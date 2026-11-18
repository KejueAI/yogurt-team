/**
 * The upload queue: a summarized meeting goes to the team server after the team's grace period (time to mark it
 * private), notes and transcript first, then the audio straight to the upload addresses the server gives.
 *
 * - Keyed by meeting id and kept in team.json, so a restart or a stretch offline picks up where it was; a failure
 *   that may pass (offline, 5xx) tries again later with backoff.
 * - A meeting summarized again is sent again from scratch; the server replaces what it had.
 * - With keep-recordings off, upstream deletes the audio once the summary is written. That deletion waits here until
 *   the audio is on the server, or until it will not be sent (private, signed out, the team does not take audio).
 * - Making a sent meeting private asks the server to remove it.
 */
import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AudioExt } from '../audio'
import type { Store } from '../store'
import { teamApi, TeamApiError, type CompleteAudio, type Fetch } from './api'
import { DEFAULT_GRACE_MINUTES } from './config'
import { attendeeEmails, audioFiles, notesMarkdown, transcriptMarkdown } from './documents'
import type { TeamSession } from './session'
import type { TeamFile, UploadEntry } from './teamFile'
import type { TeamMeetingState } from './types'

export type PutFile = (url: string, path: string, size: number, mimeType: string) => Promise<void>

export type UploadDeps = {
  file: TeamFile
  session: Pick<TeamSession, 'serverUrl' | 'token' | 'me' | 'cachedMe' | 'signedIn' | 'unauthorized' | 'onChange'>
  store: Pick<Store, 'meeting' | 'notes' | 'segments'>
  dirOf: (id: string) => string
  audioKinds: readonly AudioExt[]
  /** upstream's automatic recording deletion (it decides itself whether the recording is kept) */
  removeRecording: (id: string) => unknown
  fetch?: Fetch
  putFile?: PutFile
  now?: () => number
  /** the window should look again */
  changed?: (meetingId: string | null) => void
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 60 * 60_000
/** a meeting still recording (it was rejoined) waits this long before looking again */
const BUSY_RETRY_MS = 60_000

export const backoffMs = (attempts: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))

class UploadFailed extends Error {
  constructor(message: string, readonly transient: boolean) { super(message) }
}

/** PUT a file's bytes, streamed from disk, with its length set (a signed upload address needs it) */
export const putFile: PutFile = (url, path, size, mimeType) => new Promise((resolve, reject) => {
  const u = new URL(url)
  const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
    method: 'PUT', headers: { 'Content-Length': String(size), 'Content-Type': mimeType },
  }, res => {
    res.resume()
    res.on('end', () => {
      const s = res.statusCode ?? 0
      if (s >= 200 && s < 300) resolve()
      else reject(new UploadFailed(`The audio upload was refused (${s}).`, s >= 500 || s === 408 || s === 429))
    })
    res.on('error', reject)
  })
  req.setTimeout(10 * 60_000, () => req.destroy(new UploadFailed('The audio upload timed out.', true)))
  req.on('error', e => reject(e instanceof UploadFailed ? e : new UploadFailed(e.message, true)))
  const body = createReadStream(path)
  body.on('error', e => req.destroy(new UploadFailed(`Couldn't read the recording: ${e.message}`, false)))
  body.pipe(req)
})

export class UploadQueue {
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private readonly now: () => number
  private wasSignedIn: boolean
  /** bumped whenever a meeting's entry is replaced from outside a run, so a run that ends after it steps aside */
  private gen = new Map<string, number>()
  private bump(id: string) { this.gen.set(id, (this.gen.get(id) ?? 0) + 1) }

  constructor(private d: UploadDeps) {
    this.now = d.now ?? Date.now
    this.wasSignedIn = d.session.signedIn()
    d.session.onChange(() => {
      const signedIn = d.session.signedIn()
      if (this.wasSignedIn && !signedIn) this.signedOut()
      this.wasSignedIn = signedIn
      this.kick()
    })
  }

  private entries() { return this.d.file.get().uploads }
  private entry(id: string): UploadEntry | undefined { return this.entries()[id] }
  isPrivate(id: string): boolean { return this.d.file.get().private.includes(id) }

  private save(id: string, fn: (e: UploadEntry) => void) {
    this.d.file.update(f => { const e = f.uploads[id]; if (e) { fn(e); e.version++ } })
    this.d.changed?.(id)
  }

  /** Lets upstream delete the recording now, if it was waiting on this meeting's upload */
  private releaseHold(id: string) {
    const e = this.entry(id)
    if (!e?.holdDelete) return
    this.d.file.update(f => { const x = f.uploads[id]; if (x) delete x.holdDelete })
    void Promise.resolve().then(() => this.d.removeRecording(id)).catch(err => console.error('[team] deleting the recording failed', err))
  }

  private drop(id: string) {
    this.bump(id)
    this.releaseHold(id)
    if (!this.entry(id)) return
    this.d.file.update(f => { delete f.uploads[id] })
    this.d.changed?.(id)
  }

  /**
   * The summary of a meeting was written (upstream's `summarized`; it may come more than once). Replaces the
   * hook's recording deletion: the deletion happens here, now or once the audio is sent.
   */
  summarized(id: string): void {
    const me = this.d.session.cachedMe()
    if (!this.d.session.signedIn() || !me || this.isPrivate(id)) {
      // nothing goes to the team; a waiting upload (signed out since) is let go
      if (this.entry(id)?.op === 'upload') this.drop(id)
      void this.d.removeRecording(id)
      return
    }
    const hold = me.team.uploadAudio !== false && audioFiles(this.d.dirOf(id), this.d.audioKinds).length > 0
    const grace = Number.isFinite(me.team.graceMinutes) && me.team.graceMinutes >= 0 ? me.team.graceMinutes : DEFAULT_GRACE_MINUTES
    const prev = this.entry(id)
    this.bump(id)
    this.d.file.update(f => {
      f.uploads[id] = {
        meetingId: id, op: 'upload', state: 'waiting', dueAt: this.now() + grace * 60_000, attempts: 0,
        version: (prev?.version ?? 0) + 1,
        ...(hold || prev?.holdDelete ? { holdDelete: true } : {}),
        ...(prev?.sent ? { sent: true } : {}),
        ...(prev?.folderUrl ? { folderUrl: prev.folderUrl } : {}),
      }
    })
    this.d.changed?.(id)
    if (!hold) void this.d.removeRecording(id)
    this.kick()
  }

  setPrivate(id: string, on: boolean): void {
    if (on === this.isPrivate(id)) return
    this.bump(id)
    this.d.file.update(f => { f.private = on ? [...f.private, id] : f.private.filter(x => x !== id) })
    const e = this.entry(id)
    if (on) {
      this.releaseHold(id)
      if (e && (e.sent || e.state === 'uploading' || e.state === 'uploaded')) {
        this.d.file.update(f => {
          f.uploads[id] = { meetingId: id, op: 'remove', state: 'removing', dueAt: this.now(), attempts: 0, version: e.version + 1, sent: true }
        })
      } else if (e) {
        this.d.file.update(f => { delete f.uploads[id] })
      }
    } else if (this.d.session.signedIn() && this.d.store.notes(id).enhanced != null) {
      // back to shared: sent now, the person just chose it
      this.d.file.update(f => {
        f.uploads[id] = { meetingId: id, op: 'upload', state: 'waiting', dueAt: this.now(), attempts: 0, version: (e?.version ?? 0) + 1, ...(e?.sent ? { sent: true } : {}) }
      })
    }
    this.d.changed?.(id)
    this.kick()
  }

  retry(id: string): void {
    const e = this.entry(id)
    if (!e || e.state !== 'failed') return
    this.save(id, x => { x.state = x.op === 'remove' ? 'removing' : 'waiting'; x.dueAt = this.now(); delete x.stuck; delete x.error })
    this.kick()
  }

  meetingState(id: string): TeamMeetingState {
    const e = this.entry(id)
    return {
      signedIn: this.d.session.signedIn(),
      private: this.isPrivate(id),
      upload: e ? { state: e.state, dueAt: e.state === 'waiting' || (e.state === 'failed' && !e.stuck) ? e.dueAt : null, folderUrl: e.folderUrl ?? null, error: e.error ?? null } : null,
    }
  }

  folderUrl(id: string): string | undefined { return this.entry(id)?.folderUrl }

  /** Signed out: nothing more goes, waiting deletions happen. Removals of sent meetings stay for the next sign-in. */
  private signedOut() {
    for (const e of Object.values(this.entries())) if (e.op === 'upload') this.drop(e.meetingId)
  }

  /** Starts the timer; a run interrupted by quitting starts over */
  start(): void {
    this.started = true
    const busy = Object.values(this.entries()).filter(e => e.state === 'uploading')
    if (busy.length) this.d.file.update(f => { for (const e of busy) { const x = f.uploads[e.meetingId]; if (x) x.state = 'waiting' } })
    this.kick()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Runs what is due now, then sets the timer for the next one */
  kick(): void {
    if (!this.started) return
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.running) return // it schedules again when it ends
    void this.runDue().finally(() => this.schedule())
  }

  private schedule() {
    if (!this.started) return
    const next = Object.values(this.entries()).filter(e => !e.stuck && (e.state === 'waiting' || e.state === 'failed' || e.state === 'removing')).map(e => e.dueAt)
    if (!next.length) return
    const wait = Math.max(0, Math.min(...next) - this.now())
    // timers longer than ~24 days overflow; look again within an hour anyway
    this.timer = setTimeout(() => { this.timer = null; this.kick() }, Math.min(wait, 60 * 60_000) + 50)
  }

  /** Works through every due entry, one at a time. Tests call it directly. */
  runDue(): Promise<void> {
    if (this.running) return this.running
    // the first await comes before the finally, so `running` is set before it is cleared
    this.running = (async () => {
      await Promise.resolve()
      try {
        for (;;) {
          const due = Object.values(this.entries())
            .filter(e => !e.stuck && e.dueAt <= this.now() && (e.state === 'waiting' || e.state === 'failed' || e.state === 'removing'))
            .sort((a, b) => a.dueAt - b.dueAt)[0]
          if (!due) break
          if (!this.d.session.signedIn()) break
          await this.runOne(due.meetingId)
        }
      } finally { this.running = null }
    })()
    return this.running
  }

  private async runOne(id: string) {
    const e = this.entry(id)
    if (!e) return
    const gen = this.gen.get(id) ?? 0
    const same = () => (this.gen.get(id) ?? 0) === gen && !!this.entry(id)
    const server = this.d.session.serverUrl(), token = await this.d.session.token()
    if (!server || !token) return
    const api = teamApi(server, token, this.d.fetch)
    try {
      if (e.op === 'remove') {
        await api.removeMeeting(id).catch(err => { if (!(err instanceof TeamApiError && err.status === 404)) throw err })
        if (same()) { this.d.file.update(f => { delete f.uploads[id] }); this.d.changed?.(id) }
        return
      }
      await this.upload(id, same, api)
    } catch (err) {
      if (err instanceof TeamApiError && err.status === 401) { this.d.session.unauthorized(); return }
      const cur = this.entry(id)
      if (!cur || !same()) return // changed meanwhile; that change runs next
      const transient = err instanceof TeamApiError ? err.transient : err instanceof UploadFailed ? err.transient : true
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[team] ${cur.op} of ${id} failed`, message)
      this.save(id, x => {
        x.state = 'failed'; x.attempts++; x.error = message
        if (transient) x.dueAt = this.now() + backoffMs(x.attempts)
        else x.stuck = true
      })
    }
  }

  private async upload(id: string, same: () => boolean, api: ReturnType<typeof teamApi>) {
    const m = this.d.store.meeting(id)
    if (!m || m.trashedAt != null || this.isPrivate(id)) { this.drop(id); return }
    if (m.state === 'recording' || m.state === 'prepared') {
      this.save(id, x => { x.dueAt = this.now() + BUSY_RETRY_MS })
      return
    }
    const me = await this.d.session.me()
    if (!me) return // signed out meanwhile; the change listener lets the entry go
    if (!same()) return
    const team = me.team
    const audio = team.uploadAudio !== false ? audioFiles(this.d.dirOf(id), this.d.audioKinds) : []
    if (!audio.length) this.releaseHold(id)
    this.save(id, x => { x.state = 'uploading'; delete x.error })
    const notes = this.d.store.notes(id)
    const startedAt = new Date(m.startedAt).toISOString()
    const res = await api.createUpload({
      meetingId: id,
      ...(m.eventId ? { calendarEventId: m.eventId } : {}),
      title: m.title,
      startedAt,
      endedAt: m.endedAt != null ? new Date(m.endedAt).toISOString() : startedAt,
      attendees: attendeeEmails(m),
      notesMarkdown: team.uploadNotes !== false ? notesMarkdown(m, notes) : '',
      transcriptMarkdown: team.uploadTranscript !== false ? transcriptMarkdown(m, this.d.store.segments(id)) : '',
      audio: audio.map(({ track, fileName, mimeType, size }) => ({ track, fileName, mimeType, size })),
    })
    this.d.file.update(f => { const x = f.uploads[id]; if (x) { x.sent = true; x.folderUrl = res.folderUrl } })
    const put = this.d.putFile ?? putFile
    const results: CompleteAudio[] = []
    let failure: UploadFailed | null = null
    for (const a of audio) {
      const target = res.audio.find(x => x.track === a.track)
      if (!target) { results.push({ track: a.track, ok: false, error: 'no upload address' }); continue }
      try {
        await put(target.uploadUrl, a.path, a.size, a.mimeType)
        results.push({ track: a.track, ok: true })
      } catch (err) {
        const f = err instanceof UploadFailed ? err : new UploadFailed(err instanceof Error ? err.message : String(err), true)
        failure ??= f
        results.push({ track: a.track, ok: false, error: f.message })
      }
    }
    await api.complete(res.uploadId, results)
    if (failure) throw failure
    if (!same()) return // summarized again or made private while sending: that change runs next
    this.save(id, x => { x.state = 'uploaded'; x.attempts = 0; x.folderUrl = res.folderUrl; delete x.error; delete x.stuck })
    if (results.every(r => r.ok)) this.releaseHold(id)
  }
}
