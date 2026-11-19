import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { DONE_FILE, carryOver, createRemoteTranscription, linesFromChunks, linesFromWords, sttLanguage } from '../src/main/team/stt'

const roots: string[] = [], stores: Store[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const w = (text: string, s: number | null, e: number | null) => ({ text, start_ms: s, end_ms: e })

describe('sttLanguage', () => {
  it('asks for word times in English and Arabic, and auto otherwise', () => {
    expect(sttLanguage('english')).toBe('en')
    expect(sttLanguage('arabic')).toBe('ar')
    expect(sttLanguage('french')).toBe('auto')
    expect(sttLanguage(null)).toBe('auto')
  })
})

describe('linesFromWords', () => {
  it('starts a new line at a pause and keeps untimed words in place', () => {
    const lines = linesFromWords([w('Hello,', 5761, 6081), w('there', 6241, 6481), w("How's", null, null), w('it', 10482, 10562), w('going?', 10722, 10802)], 'me')
    expect(lines.map(l => [l.startMs, l.endMs, l.text])).toEqual([[5761, 6481, 'Hello, there How\'s'], [10482, 10802, 'it going?']])
  })
  it('breaks after a sentence once the line has some length, and caps long lines', () => {
    const words = Array.from({ length: 40 }, (_, i) => w(i === 9 ? 'end.' : 'word', i * 500, i * 500 + 400))
    const lines = linesFromWords(words, 'them')
    expect(lines[0].text.split(' ').length).toBe(10)
    expect(lines.every(l => l.endMs - l.startMs <= 15_000)).toBe(true)
    expect(lines.every(l => l.track === 'them')).toBe(true)
  })
})

describe('linesFromChunks', () => {
  it('splits a chunk at sentences and shares its time out', () => {
    const lines = linesFromChunks([{ text: 'One two. Three four five six?', start_ms: 0, end_ms: 3000 }], 'me')
    expect(lines.map(l => l.text)).toEqual(['One two.', 'Three four five six?'])
    expect(lines[0].startMs).toBe(0)
    expect(lines[1].endMs).toBe(3000)
  })
})

describe('carryOver', () => {
  it('keeps the call names on them lines and hides the echo on me lines', () => {
    const old = [
      { id: 1, meetingId: 'm', track: 'them' as const, startMs: 0, endMs: 4000, text: 'a', speaker: 'Ann' },
      { id: 2, meetingId: 'm', track: 'me' as const, startMs: 0, endMs: 4000, text: 'a', speaker: null, hidden: true },
      { id: 3, meetingId: 'm', track: 'me' as const, startMs: 5000, endMs: 8000, text: 'b', speaker: null },
    ]
    const out = carryOver([
      { track: 'them', startMs: 500, endMs: 3500, text: 'A', speaker: null },
      { track: 'me', startMs: 500, endMs: 3500, text: 'A', speaker: null },
      { track: 'me', startMs: 5200, endMs: 7000, text: 'B', speaker: null },
    ], old)
    expect(out[0].speaker).toBe('Ann')
    expect(out[1].hidden).toBe(true)
    expect(out[2].hidden).toBeUndefined()
  })
})

function setup(o: { enabled?: boolean; jobStatus?: string[]; result?: unknown; busyJobs?: number; jobError?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-stt-')); roots.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Sync', startedAt: 0, endedAt: 60_000, eventId: null, app: null, state: 'done', attendees: [] })
  store.updateMeeting(m.id, { language: 'english' })
  store.addSegments([{ meetingId: m.id, track: 'me', startMs: 0, endMs: 1000, text: 'whisper me', speaker: null }])
  const dir = join(root, m.id); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'me.m4a'), Buffer.alloc(10, 1))
  writeFileSync(join(dir, 'them.m4a'), Buffer.alloc(6, 2))
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = []
  const statuses = [...(o.jobStatus ?? ['processing', 'completed'])]
  let jobs = 0
  const uploadTrack = new Map<string, string>(), jobTrack = new Map<string, string>()
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.startsWith('https://bucket/')) return new Response(null, { status: 200 })
    if (url.endsWith('/api/stt/uploads')) { const id = `up${calls.length}`; uploadTrack.set(id, JSON.parse(String(init?.body)).filename.startsWith('me') ? 'me' : 'them'); return json(201, { id, part_size_bytes: 4 }) }
    if (url.endsWith('/parts')) {
      const parts = JSON.parse(String(init?.body)).parts as { part_number: number }[]
      return json(200, { data: parts.map(p => ({ part_number: p.part_number, url: `https://bucket/${p.part_number}`, headers: { 'x-amz-checksum-sha256': 'c' } })) })
    }
    if (url.endsWith('/complete')) return json(200, { status: 'ready' })
    if (url.endsWith('/api/stt/jobs') && o.jobError) return json(400, { error: { code: 'bad_request', message: 'unsupported audio' } })
    if (url.endsWith('/api/stt/jobs') && (o.busyJobs ?? 0) > 0) { o.busyJobs!--; return json(429, { error: { code: 'inference_job_limit', message: 'workspace asynchronous transcription limit reached' } }) }
    if (url.endsWith('/api/stt/jobs')) { jobs++; jobTrack.set(`job${jobs}`, uploadTrack.get(JSON.parse(String(init?.body)).upload_id)!); return json(202, { id: `job${jobs}`, status: 'validating' }) }
    if (url.endsWith('/result')) {
      const track = jobTrack.get(url.match(/job\d+/)![0])
      return json(200, o.result ?? { text: '', words: [w(`${track} said hi.`, track === 'me' ? 100 : 2000, track === 'me' ? 900 : 2600)] })
    }
    if (method === 'DELETE') return json(200, {})
    if (/\/api\/stt\/jobs\/job\d$/.test(url)) return json(200, { id: 'j', status: statuses.length > 1 ? statuses.shift() : statuses[0] })
    return json(404, {})
  }) as typeof fetch
  const changed: string[] = []
  const rt = createRemoteTranscription({
    session: { serverUrl: () => 'https://team.example', token: async () => 'tok', signedIn: () => true, transcriptionEnabled: async () => o.enabled ?? true },
    store, dirOf: () => dir, audioKinds: () => ['m4a'], changed: id => changed.push(id), fetch: fetchImpl, sleep: async () => {},
  })
  return { store, m, dir, calls, rt, changed }
}

describe('createRemoteTranscription', () => {
  it('sends each track on its own, then replaces the transcript', async () => {
    const { store, m, dir, calls, rt, changed } = setup()
    expect(await rt.finish(m.id)).toBe(true)
    const segs = store.segments(m.id)
    expect(segs.map(s => [s.track, s.text])).toEqual([['me', 'me said hi.'], ['them', 'them said hi.']])
    expect(changed).toEqual([m.id])
    expect(existsSync(join(dir, DONE_FILE))).toBe(true)
    // me.m4a is 10 bytes in parts of 4: three parts; them.m4a two
    expect(calls.filter(c => c.url.startsWith('https://bucket/')).length).toBe(5)
    const jobBodies = calls.filter(c => c.url.endsWith('/api/stt/jobs')).map(c => JSON.parse(c.body!))
    expect(jobBodies.every(b => b.language === 'en' && b.timestamp_granularity === 'word')).toBe(true)
    expect(calls.filter(c => c.method === 'POST').every(c => c.headers['Idempotency-Key'])).toBe(true)
    // a second call is a no-op once done
    const before = calls.length
    expect(await rt.finish(m.id)).toBe(true)
    expect(calls.length).toBe(before)
  })

  it('waits for a free job slot when the workspace is busy', async () => {
    const { store, m, calls, rt } = setup({ busyJobs: 2 })
    expect(await rt.finish(m.id)).toBe(true)
    expect(store.segments(m.id).map(s => s.text)).toEqual(['me said hi.', 'them said hi.'])
    const keys = calls.filter(c => c.url.endsWith('/api/stt/jobs')).map(c => c.headers['Idempotency-Key'])
    expect(keys.length).toBe(4)
    expect(new Set(keys).size).toBe(4)
  })

  it('aborts an upload whose job never starts, so it does not hold a slot', async () => {
    const { store, m, calls, rt } = setup({ jobError: true })
    expect(await rt.finish(m.id)).toBe(false)
    expect(calls.filter(c => c.method === 'DELETE' && /\/api\/stt\/uploads\/up\d+$/.test(c.url)).length).toBe(1)
    expect(store.segments(m.id).map(s => s.text)).toEqual(['whisper me'])
  })

  it('deletes each finished job', async () => {
    const { m, calls, rt } = setup()
    await rt.finish(m.id)
    expect(calls.filter(c => c.method === 'DELETE' && /\/api\/stt\/jobs\/job\d$/.test(c.url)).length).toBe(2)
  })

  it("keeps Whisper's transcript when the job fails", async () => {
    const { store, m, dir, rt } = setup({ jobStatus: ['failed'] })
    expect(await rt.finish(m.id)).toBe(false)
    expect(store.segments(m.id).map(s => s.text)).toEqual(['whisper me'])
    expect(existsSync(join(dir, DONE_FILE))).toBe(false)
  })

  it('does nothing when the team has no transcription service', async () => {
    const { store, m, calls, rt } = setup({ enabled: false })
    expect(await rt.finish(m.id)).toBe(false)
    expect(calls.length).toBe(0)
    expect(store.segments(m.id).map(s => s.text)).toEqual(['whisper me'])
  })

  it("keeps Whisper's transcript when the service hears nothing", async () => {
    const { store, m, rt } = setup({ result: { text: '', words: [] } })
    expect(await rt.finish(m.id)).toBe(false)
    expect(store.segments(m.id).map(s => s.text)).toEqual(['whisper me'])
  })
})
