// Yogurt Team: the meeting's transcript from the team's transcription service (Kejue Inference, through the team
// server, which holds the key). Whisper still writes the live transcript; when a meeting ends, each track (me, them)
// is sent on its own, so lines keep who said them without diarization, and the result replaces Whisper's lines
// before the summary is written. Any failure keeps Whisper's transcript as it is.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioExt } from '../audio'
import type { Segment, Store } from '../store'
import { teamApi, TeamApiError, type Fetch, type SttResult, type SttWord } from './api'
import { audioFiles, type AudioFile } from './documents'
import type { TeamSession } from './session'

type Line = Omit<Segment, 'id' | 'meetingId'>
type Track = 'me' | 'them'
type Lang = 'en' | 'ar' | 'auto'

export const DONE_FILE = 'team-transcript.json'

/** Whisper's language name for the meeting → the service's language; word times need en or ar */
export function sttLanguage(whisper: string | null | undefined): Lang {
  const l = (whisper ?? '').toLowerCase()
  if (l === 'english' || l === 'en') return 'en'
  if (l === 'arabic' || l === 'ar') return 'ar'
  return 'auto'
}

const SENTENCE_END = /[.?!؟。]["')\]]?$/
const GAP_MS = 1_000
const MAX_LINE_MS = 15_000
const MIN_SENTENCE_MS = 2_500

/** Words with times → transcript lines: a new line at a pause, after a sentence once a line has some length, or when it gets long */
export function linesFromWords(words: SttWord[], track: Track): Line[] {
  const out: Line[] = []
  let cur: { start: number; end: number; text: string[] } | undefined
  let waiting: string[] = [] // words before the first one with a time
  const flush = () => { if (cur && cur.text.length) out.push(line(track, cur.start, cur.end, cur.text.join(' '))); cur = undefined }
  for (const w of words) {
    const text = w.text.trim()
    if (!text) continue
    const timed = w.start_ms != null && w.end_ms != null
    if (!timed) { if (cur) cur.text.push(text); else waiting.push(text); continue }
    const s = w.start_ms!, e = Math.max(w.end_ms!, s)
    if (cur) {
      const last = cur.text[cur.text.length - 1]
      const breakHere = s - cur.end > GAP_MS || e - cur.start > MAX_LINE_MS || (SENTENCE_END.test(last) && cur.end - cur.start >= MIN_SENTENCE_MS)
      if (breakHere) flush()
    }
    if (!cur) { cur = { start: s, end: e, text: [...waiting] }; waiting = [] }
    cur.text.push(text)
    cur.end = Math.max(cur.end, e)
  }
  flush()
  if (waiting.length && out.length) out[out.length - 1].text += ' ' + waiting.join(' ')
  return out
}

/** Coarse chunks → lines: each chunk split at sentences, its time shared out by length */
export function linesFromChunks(chunks: NonNullable<SttResult['chunks']>, track: Track): Line[] {
  const out: Line[] = []
  for (const c of chunks) {
    const parts = c.text.match(/[^.?!؟]+[.?!؟]*["')\]]?\s*/g)?.map(p => p.trim()).filter(Boolean) ?? []
    const total = parts.reduce((n, p) => n + p.length, 0)
    if (!total) continue
    let at = c.start_ms
    for (const p of parts) {
      const len = ((c.end_ms - c.start_ms) * p.length) / total
      out.push(line(track, Math.round(at), Math.round(at + len), p))
      at += len
    }
  }
  return out
}

const line = (track: Track, startMs: number, endMs: number, text: string): Line => ({ track, startMs, endMs, text, speaker: null })

const overlap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))

/**
 * Keeps what the app had worked out on Whisper's lines: the call's speaker names on them lines (by most time shared),
 * and the mic's echo of the call stays hidden (a me line mostly over hidden me lines and not over shown ones).
 */
export function carryOver(fresh: Line[], old: Segment[]): Line[] {
  const oldThem = old.filter(s => s.track === 'them' && s.speaker)
  const oldMeHidden = old.filter(s => s.track === 'me' && s.hidden)
  const oldMeShown = old.filter(s => s.track === 'me' && !s.hidden)
  return fresh.map(l => {
    if (l.track === 'them') {
      let best: string | null = null, bestMs = 0
      for (const s of oldThem) { const o = overlap(l, s); if (o > bestMs) { bestMs = o; best = s.speaker } }
      return best ? { ...l, speaker: best } : l
    }
    const span = Math.max(1, l.endMs - l.startMs)
    const hidden = oldMeHidden.reduce((n, s) => n + overlap(l, s), 0)
    const shown = oldMeShown.reduce((n, s) => n + overlap(l, s), 0)
    return hidden / span > 0.5 && hidden > shown ? { ...l, hidden: true } : l
  })
}

export type RemoteTranscriptionDeps = {
  session: Pick<TeamSession, 'serverUrl' | 'token' | 'signedIn' | 'transcriptionEnabled'>
  store: Pick<Store, 'meeting' | 'segments' | 'replaceSegments'>
  dirOf: (id: string) => string
  audioKinds: () => readonly AudioExt[]
  /** the transcript changed: the window and the search index should look again */
  changed: (meetingId: string) => void
  log?: (msg: string, err?: unknown) => void
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
  /** how long to wait for one track's job before keeping Whisper's lines */
  jobTimeoutMs?: number
}

const sizeOf = (path: string) => { try { return statSync(path).size } catch { return -1 } }
function readDone(dir: string): { sizes?: Record<string, number> } | undefined {
  try { return JSON.parse(readFileSync(join(dir, DONE_FILE), 'utf8')) } catch { return undefined }
}
const sameSizes = (a: Record<string, number> | undefined, b: Record<string, number>) =>
  !!a && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v)

const POLL_MS = [2_000, 3_000, 5_000, 10_000, 30_000]
const UPLOAD_TIMEOUT_MS = 10 * 60_000
/** the notes wait on this: when the team's job slots stay busy this long, Whisper's transcript is used */
const SLOT_WAIT_MS = 10 * 60_000

class GiveUp extends Error {}

export function createRemoteTranscription(d: RemoteTranscriptionDeps) {
  const running = new Map<string, Promise<boolean>>()
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const f: Fetch = d.fetch ?? fetch
  const log = d.log ?? (() => {})

  type Api = ReturnType<typeof teamApi>

  /** Sends one track's file in parts; resolves the upload's id, ready for a job */
  async function sendFile(api: Api, file: AudioFile, key: (step: string) => string): Promise<string> {
    const up = await api.sttUpload({ filename: file.fileName, size_bytes: file.size, content_type: file.mimeType }, key('upload'))
    try {
      const partSize = up.part_size_bytes > 0 ? up.part_size_bytes : 16 * 1024 * 1024
      const count = Math.max(1, Math.ceil(file.size / partSize))
      const fh = await open(file.path, 'r')
      try {
        for (let first = 1; first <= count; first += 4) {
          const nums = Array.from({ length: Math.min(4, count - first + 1) }, (_, i) => first + i)
          const bodies = new Map<number, Buffer>()
          for (const n of nums) {
            const start = (n - 1) * partSize
            const len = Math.min(partSize, file.size - start)
            const buf = Buffer.alloc(len)
            const { bytesRead } = await fh.read(buf, 0, len, start)
            if (bytesRead !== len) throw new Error(`${file.fileName} changed while it was being sent`)
            bodies.set(n, buf)
          }
          const signed = await api.sttParts(up.id, nums.map(n => ({ part_number: n, checksum_sha256: createHash('sha256').update(bodies.get(n)!).digest('base64') })), key(`parts-${first}`))
          for (const p of signed.data) {
            const body = bodies.get(p.part_number)
            if (!body) continue
            const res = await f(p.url, { method: 'PUT', headers: p.headers ?? {}, body: new Uint8Array(body), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
            if (!res.ok) throw new Error(`sending part ${p.part_number} of ${file.fileName}: ${res.status}`)
          }
        }
      } finally { await fh.close() }
      await api.sttComplete(up.id, key('complete'))
      return up.id
    } catch (e) {
      // an upload that never becomes a job holds one of the workspace's upload slots for a day: give it back now
      await api.sttAbortUpload(up.id).catch(() => {})
      throw e
    }
  }

  /** Starts the job, waiting for a free slot when the workspace's are all busy; aborts the upload if it never starts */
  async function startJob(api: Api, uploadId: string, lang: Lang, key: (step: string) => string, deadline: number): Promise<string> {
    for (let i = 0; ; i++) {
      try {
        const job = await api.sttJob({ upload_id: uploadId, language: lang, timestamp_granularity: lang === 'auto' ? 'chunk' : 'word' }, key(`job-${i}`))
        return job.id
      } catch (e) {
        if (!(e instanceof TeamApiError && e.code === 'inference_job_limit') || Date.now() > deadline) {
          await api.sttAbortUpload(uploadId).catch(() => {})
          throw e
        }
        await sleep(POLL_MS[Math.min(i + 2, POLL_MS.length - 1)])
      }
    }
  }

  async function transcribeTrack(api: Api, file: AudioFile, lang: Lang, nonce: string): Promise<Line[]> {
    const key = (step: string) => `yt-${nonce}-${file.track}-${step}`
    const deadline = Date.now() + (d.jobTimeoutMs ?? 60 * 60_000)
    const uploadId = await sendFile(api, file, key)
    const jobId = await startJob(api, uploadId, lang, key, Math.min(deadline, Date.now() + SLOT_WAIT_MS))
    try {
      for (let i = 0; ; i++) {
        const s = await api.sttJobStatus(jobId)
        if (s.status === 'completed') break
        if (s.status === 'failed' || s.status === 'cancelled') throw new GiveUp(`the transcription service ${s.status} on ${file.track}${s.error?.message ? `: ${s.error.message}` : ''}`)
        if (s.status === 'awaiting_credits') throw new GiveUp('the transcription service is out of credits')
        if (Date.now() > deadline) throw new GiveUp(`the transcription service took too long on ${file.track}`)
        await sleep(POLL_MS[Math.min(i, POLL_MS.length - 1)])
      }
      const r = await api.sttResult(jobId)
      if (r.words?.length) return linesFromWords(r.words, file.track as Track)
      if (r.chunks?.length) return linesFromChunks(r.chunks, file.track as Track)
      return []
    } finally {
      // the service keeps jobs and results for days; deleting cancels one still running and frees its slot
      await api.sttDelete(jobId).catch(() => {})
    }
  }

  async function run(id: string): Promise<boolean> {
    const dir = d.dirOf(id)
    const server = d.session.serverUrl()
    const token = await d.session.token().catch(() => undefined)
    if (!server || !token || !(await d.session.transcriptionEnabled())) return false
    const m = d.store.meeting(id)
    if (!m || (m.state !== 'stopped' && m.state !== 'done')) return false
    const files = audioFiles(dir, d.audioKinds()).filter(a => a.track === 'me' || a.track === 'them')
    if (!files.length) return false
    // done already for this audio (a resumed meeting has more of it, so it is sent again)
    const sizes = Object.fromEntries(files.map(a => [a.track, a.size]))
    if (sameSizes(readDone(dir)?.sizes, sizes)) return true
    const api = teamApi(server, token, f)
    const lang = sttLanguage(m.language)
    const nonce = randomUUID()
    const started = Date.now()
    try {
      // one track after the other: each is a job, and the workspace's job slots are shared by the whole team
      const lines: Line[] = []
      for (const file of files) lines.push(...await transcribeTrack(api, file, lang, nonce))
      if (!lines.some(l => l.text.trim())) { log(`[team] transcription service heard nothing in ${id}; keeping Whisper's transcript`); return false }
      // recording again (resumed) while this ran: its new lines are Whisper's to keep; this run's result is stale
      const now = d.store.meeting(id)
      if (!now || (now.state !== 'stopped' && now.state !== 'done') || files.some(a => sizeOf(a.path) !== a.size)) {
        log(`[team] ${id} was recorded again while it was being transcribed; keeping Whisper's transcript`)
        return false
      }
      const kept = carryOver(lines, d.store.segments(id, { hidden: true }))
      kept.sort((a, b) => a.startMs - b.startMs || (a.track === b.track ? 0 : a.track === 'me' ? -1 : 1))
      d.store.replaceSegments(id, kept)
      writeFileSync(join(dir, DONE_FILE), JSON.stringify({ at: new Date().toISOString(), language: lang, lines: kept.length, sizes }))
      log(`[team] transcript of ${id} from the transcription service: ${kept.length} lines (${lang}) in ${Math.round((Date.now() - started) / 1000)}s`)
      d.changed(id)
      return true
    } catch (e) {
      const why = e instanceof TeamApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)
      log(`[team] transcription service didn't finish ${id} (${why}); keeping Whisper's transcript`)
      return false
    }
  }

  return {
    /** Replaces the meeting's transcript with the service's when the team has one; resolves false when Whisper's is kept. Never throws. */
    finish(id: string): Promise<boolean> {
      let p = running.get(id)
      if (!p) {
        p = run(id).catch(() => false).finally(() => running.delete(id))
        running.set(id, p)
      }
      return p
    },
  }
}
