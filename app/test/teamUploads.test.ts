import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { TeamFile } from '../src/main/team/teamFile'
import { UploadQueue, backoffMs, type MixAudio, type PutFile } from '../src/main/team/uploads'
import type { TeamMe } from '../src/main/team/types'

const roots: string[] = [], stores: Store[] = [], queues: UploadQueue[] = []
afterEach(() => {
  queues.splice(0).forEach(q => q.stop())
  stores.splice(0).forEach(s => s.close())
  roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

const ME: TeamMe = {
  user: { email: 'ann@example.com', name: 'Ann', isAdmin: false },
  team: { name: 'Acme', driveConnected: true, summariesEnabled: false, uploadAudio: true, uploadTranscript: true, uploadNotes: true, graceMinutes: 10 },
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(o: { me?: TeamMe; audio?: boolean; signedIn?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-team-')); roots.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Launch', startedAt: Date.UTC(2026, 0, 5, 10), endedAt: Date.UTC(2026, 0, 5, 11), eventId: 'evt1', app: null, state: 'done', attendees: [{ name: 'Ann', email: 'Ann@Example.com' }, { name: 'Bo', email: null }] })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'Launch on Tuesday', speaker: 'Ann' }])
  store.setNotes(m.id, { mine: 'mine', enhanced: '## Launch\nTuesday' })
  const dir = join(root, 'meetings', m.id); mkdirSync(dir, { recursive: true })
  if (o.audio !== false) { writeFileSync(join(dir, 'me.m4a'), 'aaaa'); writeFileSync(join(dir, 'them.m4a'), 'bbbbbb') }
  const me = o.me ?? ME
  let now = 1_000_000
  let signedIn = o.signedIn ?? true
  const listeners = new Set<() => void>()
  const session = {
    serverUrl: () => 'https://team.example',
    token: async () => (signedIn ? 'tok' : undefined),
    me: async () => (signedIn ? me : undefined),
    cachedMe: () => (signedIn ? me : undefined),
    signedIn: () => signedIn,
    unauthorized: vi.fn(() => { signedIn = false; listeners.forEach(f => f()) }),
    onChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  const requests: { method: string; url: string; body: any }[] = []
  let uploadN = 0
  const handlers: Record<string, (body: any) => Response> = {
    'POST /api/uploads': () => { uploadN++; return json(200, { uploadId: `u${uploadN}`, folderUrl: 'https://drive.example/f', audio: [{ track: 'recording', uploadUrl: 'https://put.example/recording' }] }) },
    'POST /api/uploads/:id/complete': () => json(200, { ok: true }),
    [`DELETE /api/uploads/by-meeting/${m.id}`]: () => json(200, { ok: true }),
  }
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url)), method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url: u.pathname, body })
    const key = `${method} ${u.pathname.replace(/^\/api\/uploads\/[^/]+\/complete$/, '/api/uploads/:id/complete')}`
    const h = handlers[key]
    return h ? h(body) : json(404, { error: 'not_found', message: 'nope' })
  })
  const puts: { url: string; size: number; mimeType: string }[] = []
  const putFile = vi.fn<PutFile>(async (url, _path, size, mimeType) => { puts.push({ url, size, mimeType }) })
  const removeRecording = vi.fn()
  // the helper's mix, faked: the mixed file is the tracks one after another
  const mixAudio = vi.fn<MixAudio>(async (inputs, out) => { writeFileSync(out, Buffer.concat(inputs.map(i => readFileSync(i)))) })
  const file = new TeamFile(join(root, 'team.json'))
  const q = new UploadQueue({
    file, session, store, dirOf: id => join(root, 'meetings', id), audioKinds: ['m4a'], removeRecording,
    fetch: fetch as never, putFile, mixAudio, now: () => now,
  })
  queues.push(q)
  const flush = () => new Promise(r => setTimeout(r, 0))
  return {
    root, store, m, dir, q, file, session, fetch, requests, handlers, puts, putFile, removeRecording, mixAudio, flush,
    advance: (ms: number) => { now += ms },
    signOut: () => { signedIn = false; listeners.forEach(f => f()) },
    reopen: () => new UploadQueue({ file: new TeamFile(join(root, 'team.json')), session, store, dirOf: id => join(root, 'meetings', id), audioKinds: ['m4a'], removeRecording, fetch: fetch as never, putFile, mixAudio, now: () => now }),
  }
}

describe('team uploads: grace period', () => {
  it('waits graceMinutes after the summary, then sends notes, transcript and audio', async () => {
    const s = setup()
    s.q.summarized(s.m.id)
    expect(s.q.meetingState(s.m.id).upload).toMatchObject({ state: 'waiting', dueAt: 1_000_000 + 10 * 60_000 })
    await s.q.runDue()
    expect(s.fetch).not.toHaveBeenCalled()
    s.advance(10 * 60_000 - 1); await s.q.runDue()
    expect(s.fetch).not.toHaveBeenCalled()
    s.advance(1); await s.q.runDue()
    const create = s.requests.find(r => r.url === '/api/uploads')!
    expect(create.body).toMatchObject({
      meetingId: s.m.id, calendarEventId: 'evt1', title: 'Launch',
      startedAt: '2026-01-05T10:00:00.000Z', endedAt: '2026-01-05T11:00:00.000Z', attendees: ['ann@example.com'],
      audio: [{ track: 'recording', fileName: 'recording.m4a', mimeType: 'audio/mp4', size: 10 }],
    })
    expect(create.body.notesMarkdown).toContain('Tuesday')
    expect(create.body.transcriptMarkdown).toContain('Launch on Tuesday')
    // one file of both tracks mixed, never the separate tracks
    expect(s.mixAudio).toHaveBeenCalledWith([join(s.dir, 'me.m4a'), join(s.dir, 'them.m4a')], expect.stringMatching(/recording\.m4a$/))
    expect(s.puts).toEqual([{ url: 'https://put.example/recording', size: 10, mimeType: 'audio/mp4' }])
    expect(s.requests.find(r => r.url.endsWith('/complete'))).toMatchObject({ url: '/api/uploads/u1/complete', body: { audio: [{ track: 'recording', ok: true }] } })
    expect(s.q.meetingState(s.m.id).upload).toMatchObject({ state: 'uploaded', folderUrl: 'https://drive.example/f' })
  })

  it('uses the team’s grace period', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('uploaded')
  })

  it('leaves out what the team does not take', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0, uploadAudio: false, uploadTranscript: false } } })
    s.q.summarized(s.m.id); await s.q.runDue()
    const create = s.requests.find(r => r.url === '/api/uploads')!
    expect(create.body.audio).toEqual([]); expect(create.body.transcriptMarkdown).toBe('')
    expect(s.putFile).not.toHaveBeenCalled()
  })
})

describe('team uploads: idempotency', () => {
  it('a second summary while waiting keeps one entry and restarts the grace period', async () => {
    const s = setup()
    s.q.summarized(s.m.id); s.advance(5 * 60_000); s.q.summarized(s.m.id)
    expect(Object.keys(s.file.get().uploads)).toEqual([s.m.id])
    s.advance(5 * 60_000); await s.q.runDue()
    expect(s.fetch).not.toHaveBeenCalled()
    s.advance(5 * 60_000); await s.q.runDue()
    expect(s.requests.filter(r => r.url === '/api/uploads')).toHaveLength(1)
  })

  it('a re-summary after upload sends the meeting again (the server replaces it)', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.q.summarized(s.m.id); await s.q.runDue()
    s.store.setNotes(s.m.id, { enhanced: '## Launch\nWednesday' })
    s.q.summarized(s.m.id); await s.q.runDue()
    const creates = s.requests.filter(r => r.url === '/api/uploads')
    expect(creates).toHaveLength(2)
    expect(creates[1].body.meetingId).toBe(s.m.id)
    expect(creates[1].body.notesMarkdown).toContain('Wednesday')
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('uploaded')
  })

  it('a summary arriving mid-upload makes the queue send again rather than mark the old one done', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    let once = true
    s.putFile.mockImplementation(async () => { if (once) { once = false; s.q.summarized(s.m.id) } })
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.requests.filter(r => r.url === '/api/uploads')).toHaveLength(2)
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('uploaded')
  })
})

describe('team uploads: persisted queue and retries', () => {
  it('survives a restart', async () => {
    const s = setup()
    s.q.summarized(s.m.id)
    const again = s.reopen(); queues.push(again)
    s.advance(10 * 60_000); await again.runDue()
    expect(again.meetingState(s.m.id).upload?.state).toBe('uploaded')
  })

  it('an upload cut off by quitting starts over', async () => {
    const s = setup()
    s.q.summarized(s.m.id)
    s.file.update(f => { f.uploads[s.m.id].state = 'uploading' })
    const again = s.reopen(); queues.push(again)
    again.start(); again.stop()
    expect(again.meetingState(s.m.id).upload?.state).toBe('waiting')
  })

  it('offline: fails, then retries with backoff', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload).toMatchObject({ state: 'failed', dueAt: 1_000_000 + backoffMs(1) })
    s.advance(backoffMs(1) - 1); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('failed')
    s.advance(1); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('uploaded')
    expect(s.removeRecording).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially up to an hour', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([30_000, 60_000, 120_000])
    expect(backoffMs(30)).toBe(60 * 60_000)
  })

  it('a server error that will not pass waits for Retry', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.handlers['POST /api/uploads'] = () => json(400, { error: 'bad_request', message: 'title missing' })
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload).toMatchObject({ state: 'failed', dueAt: null, error: 'title missing' })
    s.advance(24 * 60 * 60_000); await s.q.runDue()
    expect(s.requests.filter(r => r.url === '/api/uploads')).toHaveLength(1)
    s.handlers['POST /api/uploads'] = () => json(200, { uploadId: 'u9', folderUrl: 'https://drive.example/g', audio: [] })
    s.q.retry(s.m.id); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload).toMatchObject({ state: 'uploaded', folderUrl: 'https://drive.example/g' })
  })

  it('a 401 signs out and lets go of the waiting upload', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.handlers['POST /api/uploads'] = () => json(401, { error: 'unauthorized', message: 'expired' })
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.session.unauthorized).toHaveBeenCalled()
    expect(s.file.get().uploads[s.m.id]).toBeUndefined()
    expect(s.removeRecording).toHaveBeenCalledWith(s.m.id)
  })
})

describe('team uploads: private meetings', () => {
  it('a private meeting is never sent, and its recording is handled at once', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.q.setPrivate(s.m.id, true)
    s.q.summarized(s.m.id); await s.q.runDue()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.removeRecording).toHaveBeenCalledWith(s.m.id)
  })

  it('marked private during the grace period: nothing is sent', async () => {
    const s = setup()
    s.q.summarized(s.m.id); s.q.setPrivate(s.m.id, true)
    s.advance(60 * 60_000); await s.q.runDue()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.q.meetingState(s.m.id)).toMatchObject({ private: true, upload: null })
  })

  it('marked private after upload: asks the server to remove it', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.q.summarized(s.m.id); await s.q.runDue()
    s.q.setPrivate(s.m.id, true)
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('removing')
    await s.q.runDue()
    expect(s.requests.at(-1)).toMatchObject({ method: 'DELETE', url: `/api/uploads/by-meeting/${s.m.id}` })
    expect(s.q.meetingState(s.m.id)).toMatchObject({ private: true, upload: null })
  })

  it('shared again: sent right away', async () => {
    const s = setup()
    s.q.setPrivate(s.m.id, true); s.q.summarized(s.m.id)
    s.q.setPrivate(s.m.id, false); await s.q.runDue()
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('uploaded')
  })
})

describe('team uploads: the recording deletion waits for the audio', () => {
  it('holds upstream’s deletion until the audio is confirmed', async () => {
    const s = setup()
    s.q.summarized(s.m.id)
    expect(s.removeRecording).not.toHaveBeenCalled()
    s.advance(10 * 60_000); await s.q.runDue(); await s.flush()
    expect(s.removeRecording).toHaveBeenCalledWith(s.m.id)
  })

  it('a recording that cannot be mixed is retried later and nothing is sent', async () => {
    const s = setup()
    s.mixAudio.mockRejectedValueOnce(new Error('helper crashed'))
    s.q.summarized(s.m.id)
    s.advance(10 * 60_000); await s.q.runDue()
    expect(s.puts).toEqual([])
    expect(s.q.meetingState(s.m.id).upload?.state).not.toBe('uploaded')
  })

  it('keeps holding while an audio upload fails', async () => {
    const s = setup({ me: { ...ME, team: { ...ME.team, graceMinutes: 0 } } })
    s.putFile.mockRejectedValueOnce(new Error('connection reset'))
    s.q.summarized(s.m.id); await s.q.runDue(); await s.flush()
    expect(s.q.meetingState(s.m.id).upload?.state).toBe('failed')
    expect(s.requests.find(r => r.url.endsWith('/complete'))?.body.audio[0]).toMatchObject({ track: 'recording', ok: false })
    expect(s.removeRecording).not.toHaveBeenCalled()
    s.advance(backoffMs(1)); await s.q.runDue(); await s.flush()
    expect(s.removeRecording).toHaveBeenCalledTimes(1)
  })

  it('does not hold when there is no audio, the team takes none, or signed out', async () => {
    for (const o of [{ audio: false }, { me: { ...ME, team: { ...ME.team, uploadAudio: false } } }, { signedIn: false }]) {
      const s = setup(o)
      s.q.summarized(s.m.id)
      expect(s.removeRecording).toHaveBeenCalledWith(s.m.id)
    }
  })

  it('making it private or signing out lets the deletion go', async () => {
    const a = setup(); a.q.summarized(a.m.id); a.q.setPrivate(a.m.id, true); await a.flush()
    expect(a.removeRecording).toHaveBeenCalledWith(a.m.id)
    const b = setup(); b.q.summarized(b.m.id); b.signOut(); await b.flush()
    expect(b.removeRecording).toHaveBeenCalledWith(b.m.id)
    expect(b.file.get().uploads[b.m.id]).toBeUndefined()
  })
})
