import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Catalog, Hardware } from '@yogurt/picker'
import bundled from '../../catalog/catalog.json'
import {
  createTeamNotes, estimateTokens, NotConfiguredError, RemoteLlm, RemoteLlmError, REMOTE_NOTES_TOKENS, REMOTE_PART_TOKENS, signedOutSession,
  streamChat, UnauthorizedError, type NotesModelLike, type TeamSession,
} from '../src/main/team/llm'
import { enhance, MAX_PART_TOKENS, partBudget, type Llm } from '../src/main/notes/enhance'
import { SetupController, type SetupDeps } from '../src/main/setup'
import { fakeDownloadDeps } from '../src/main/fake'
import type { DownloadDeps } from '../src/main/downloader'
import type { Segment } from '../src/main/store'

const enc = new TextEncoder()
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

/** a fetch answering with these body chunks (or a status and JSON body), recording each request */
function server(answer: { chunks?: string[]; status?: number; json?: unknown; hang?: boolean }) {
  const calls: { url: string; init: RequestInit; body: any }[] = []
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) })
    if (answer.status && answer.status !== 200) {
      return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    }
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const chunk of answer.chunks ?? []) c.enqueue(enc.encode(chunk))
        if (!answer.hang) return c.close()
        signal?.addEventListener('abort', () => c.error(signal.reason), { once: true })
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  return { fetch: f as unknown as typeof fetch, calls }
}

const base = { serverUrl: 'https://team.example.com', token: 'tok' }
const request = { messages: [{ role: 'user' as const, content: 'hi' }], purpose: 'chat' as const }

describe('streamChat (POST /api/llm/chat)', () => {
  it('posts the request with the bearer token and streams each delta until done', async () => {
    const s = server({ chunks: [sse({ delta: 'Hel' }), sse({ delta: 'lo' }), sse({ done: true }), sse({ delta: 'ignored' })] })
    const tokens: string[] = []
    const text = await streamChat({ ...base, request, onToken: (t) => tokens.push(t), fetch: s.fetch })
    expect(text).toBe('Hello')
    expect(tokens).toEqual(['Hel', 'lo'])
    expect(s.calls[0].url).toBe('https://team.example.com/api/llm/chat')
    expect(s.calls[0].init.method).toBe('POST')
    expect((s.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(s.calls[0].body).toEqual(request)
  })

  it('reads events split across chunks, CRLF lines, comments and a missing space after data:', async () => {
    const whole = ': keep-alive\r\n\r\ndata:{"delta":"a"}\r\n\r\n' + sse({ delta: 'b€' }) + sse({ done: true })
    const bytes = enc.encode(whole)
    const s = server({ chunks: [] })
    const f = (async (url: string, init: RequestInit) => {
      await s.fetch(url, init)
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close() },
      }))
    }) as unknown as typeof fetch
    const tokens: string[] = []
    expect(await streamChat({ ...base, request, onToken: (t) => tokens.push(t), fetch: f })).toBe('ab€')
    expect(tokens).toEqual(['a', 'b€'])
  })

  it('rejects with the message of an error event mid-stream', async () => {
    const s = server({ chunks: [sse({ delta: 'part' }), sse({ error: 'OpenRouter is down' })] })
    const tokens: string[] = []
    await expect(streamChat({ ...base, request, onToken: (t) => tokens.push(t), fetch: s.fetch })).rejects.toThrow(new RemoteLlmError('OpenRouter is down'))
    expect(tokens).toEqual(['part'])
  })

  it('rejects when the stream ends before done', async () => {
    const s = server({ chunks: [sse({ delta: 'part' })] })
    await expect(streamChat({ ...base, request, onToken: () => {}, fetch: s.fetch })).rejects.toThrow(/stopped before the answer was done/)
  })

  it('409 not_configured is a NotConfiguredError; 401 is UnauthorizedError; other statuses carry the server message', async () => {
    await expect(streamChat({ ...base, request, onToken: () => {}, fetch: server({ status: 409, json: { error: 'not_configured', message: 'no key' } }).fetch }))
      .rejects.toBeInstanceOf(NotConfiguredError)
    await expect(streamChat({ ...base, request, onToken: () => {}, fetch: server({ status: 401, json: { error: 'unauthorized' } }).fetch }))
      .rejects.toBeInstanceOf(UnauthorizedError)
    const e = await streamChat({ ...base, request, onToken: () => {}, fetch: server({ status: 502, json: { error: 'upstream', message: 'OpenRouter failed' } }).fetch }).catch((e) => e)
    expect(e).toBeInstanceOf(RemoteLlmError)
    expect(e).toMatchObject({ message: 'OpenRouter failed', status: 502 })
  })

  it('stops when aborted mid-stream, rejecting with the abort reason', async () => {
    const s = server({ chunks: [sse({ delta: 'part' })], hang: true })
    const ac = new AbortController()
    const tokens: string[] = []
    const p = streamChat({ ...base, request, onToken: (t) => { tokens.push(t); ac.abort(new Error('stopped')) }, signal: ac.signal, fetch: s.fetch })
    await expect(p).rejects.toThrow('stopped')
    expect(tokens).toEqual(['part'])
    expect(s.calls[0].init.signal).toBe(ac.signal)
  })

  it('does not post at all when already aborted', async () => {
    const s = server({ chunks: [sse({ done: true })] })
    const ac = new AbortController(); ac.abort(new Error('gone'))
    await expect(streamChat({ ...base, request, onToken: () => {}, signal: ac.signal, fetch: s.fetch })).rejects.toThrow('gone')
    expect(s.calls).toHaveLength(0)
  })
})

/** a local Llm that answers "local" */
const localLlm = (contextSize = 8192): Llm & { prompts: string[] } => {
  const prompts: string[] = []
  return {
    prompts, contextSize,
    count: async (texts) => texts.map(estimateTokens),
    chat: async (prompt, onToken) => { prompts.push(prompt); onToken('local'); return 'local' },
  }
}

describe('RemoteLlm', () => {
  it('sends earlier turns as alternating user/assistant messages, with maxTokens, temperature and a purpose', async () => {
    const s = server({ chunks: [sse({ delta: 'Title' }), sse({ done: true })] })
    const llm = new RemoteLlm({ ...base, fetch: s.fetch })
    expect(await llm.chat('Name it', () => {}, { maxTokens: 40, temperature: 0.3, before: ['notes prompt', 'the notes'] })).toBe('Title')
    expect(s.calls[0].body).toEqual({
      messages: [{ role: 'user', content: 'notes prompt' }, { role: 'assistant', content: 'the notes' }, { role: 'user', content: 'Name it' }],
      maxTokens: 40, temperature: 0.3, purpose: 'title',
    })
    await llm.chat('a part', () => {}, { summary: true, maxTokens: 700 })
    expect(s.calls[1].body.purpose).toBe('summary')
    await new RemoteLlm({ ...base, fetch: s.fetch, purpose: 'chat' }).chat('q', () => {}, { maxTokens: 40 })
    expect(s.calls[2].body.purpose).toBe('chat')
  })

  it('counts tokens as chars/4 and splits long meetings into bigger parts than the local model', async () => {
    const llm = new RemoteLlm(base)
    expect(await llm.count(['abcd', 'abcde', ''])).toEqual([1, 2, 0])
    expect(await partBudget(llm, 'en')).toBe(REMOTE_PART_TOKENS)
    expect(await partBudget(localLlm(1_000_000), 'en')).toBe(MAX_PART_TOKENS)
  })

  it('aborts with the job signal', async () => {
    const s = server({ chunks: [], hang: true })
    const ac = new AbortController()
    const p = new RemoteLlm({ ...base, fetch: s.fetch, signal: ac.signal }).chat('x', () => {})
    setTimeout(() => ac.abort(new Error('cancelled')), 5)
    await expect(p).rejects.toThrow('cancelled')
  })

  it('409 not_configured: tells the selector and lets the local model write it when it fits', async () => {
    const s = server({ status: 409, json: { error: 'not_configured' } })
    const local = localLlm()
    const turnedDown = vi.fn()
    const llm = new RemoteLlm({ ...base, fetch: s.fetch, onNotConfigured: turnedDown, fallback: async () => local })
    const tokens: string[] = []
    expect(await llm.chat('short', (t) => tokens.push(t))).toBe('local')
    expect(tokens).toEqual(['local'])
    expect(turnedDown).toHaveBeenCalledOnce()
    // cut for the cloud model's context: too big for the local one, so the job fails (and is retried locally later)
    await expect(llm.chat('x'.repeat(100_000), () => {})).rejects.toBeInstanceOf(NotConfiguredError)
    expect(local.prompts).toEqual(['short'])
  })

  it('writes a long meeting with enhance() in one pass, where a local 16k model splits it into parts', async () => {
    const segments: Segment[] = Array.from({ length: 400 }, (_, i) => ({
      id: i, meetingId: 'm', track: i % 2 ? 'them' : 'me', startMs: i * 10_000, endMs: i * 10_000 + 9000,
      text: 'we talked about the plan for the launch and who does what next week '.repeat(4), speaker: i % 2 ? null : 'me',
    }))
    const input = { meeting: { title: 'Planning', attendees: [] }, mine: '', segments, language: 'en' }
    const s = server({ chunks: [sse({ delta: '## Notes\n- one' }), sse({ done: true })] })
    await enhance(input, new RemoteLlm({ ...base, fetch: s.fetch }), () => {})
    expect(s.calls.filter((c) => c.body.purpose === 'summary')).toHaveLength(0)
    // the notes get the cloud budget, so a long meeting's notes are not cut off halfway
    expect(s.calls[0]!.body.maxTokens).toBe(REMOTE_NOTES_TOKENS)
    const local = localLlm(16_384)
    await enhance(input, local, () => {})
    expect(local.prompts.length).toBeGreaterThan(1)
  })
})

/** a local notes model that records what was used */
function localModel(): NotesModelLike & { llms: number } {
  const m = {
    llms: 0,
    llm: async () => { m.llms++; return localLlm() },
    unload: async () => {}, loaded: () => '/models/local.gguf', needsLoad: () => true,
  }
  return m
}

function session(o: { url?: string; token?: string; enabled?: boolean | (() => Promise<boolean>) } = {}): TeamSession & { checks: number } {
  const s = {
    checks: 0,
    serverUrl: () => ('url' in o ? o.url : base.serverUrl),
    token: async () => ('token' in o ? o.token : base.token),
    summariesEnabled: async () => { s.checks++; return typeof o.enabled === 'function' ? o.enabled() : o.enabled ?? true },
  }
  return s
}

describe('createTeamNotes (the selector)', () => {
  it('is remote when signed in and summaries are on', async () => {
    const s = server({ chunks: [sse({ delta: 'hi' }), sse({ done: true })] })
    const t = createTeamNotes({ session: session(), fetch: s.fetch })
    const local = localModel()
    const model = t.wrap(local)
    const llm = await model.llm()
    expect(llm).toBeInstanceOf(RemoteLlm)
    expect(await llm.chat('x', () => {})).toBe('hi')
    expect(local.llms).toBe(0)
    expect(t.active()).toBe(true)
    expect(model.needsLoad()).toBe(false)
    await model.as('chat').llm().then((l) => l.chat('q', () => {}))
    expect(s.calls[1].body.purpose).toBe('chat')
  })

  it.each([
    ['signed out', session({ token: undefined })],
    ['no server set', session({ url: undefined })],
    ['summaries off on the server', session({ enabled: false })],
    ['the check failing', session({ enabled: async () => { throw new Error('offline') } })],
    ['no session yet', signedOutSession],
  ])('is the local model exactly as upstream when %s', async (_, sess) => {
    const t = createTeamNotes({ session: sess })
    const local = localModel()
    const model = t.wrap(local)
    expect(await model.llm()).not.toBeInstanceOf(RemoteLlm)
    expect(local.llms).toBe(1)
    expect(t.active()).toBe(false)
    expect(model.needsLoad()).toBe(true)
  })

  it('a session that does not answer in time counts as off', async () => {
    const t = createTeamNotes({ session: session({ enabled: () => new Promise(() => {}) }), timeoutMs: 10 })
    expect(await t.remoteActive()).toBe(false)
  })

  it('caches the answer for the ttl, shares one check, and tells listeners when it changes', async () => {
    let on = true, clock = 0
    const sess = session({ enabled: async () => on })
    const t = createTeamNotes({ session: sess, ttlMs: 1000, now: () => clock })
    const changes: boolean[] = []
    t.onChange((a) => changes.push(a))
    expect(await Promise.all([t.remoteActive(), t.remoteActive()])).toEqual([true, true])
    expect(sess.checks).toBe(1)
    on = false
    clock = 500
    expect(await t.remoteActive()).toBe(true)
    clock = 1500
    expect(await t.remoteActive()).toBe(false)
    t.invalidate(); on = true
    expect(await t.remoteActive()).toBe(true)
    expect(changes).toEqual([true, false, true])
  })

  it('a 409 not_configured turns remote off and the chat goes to the local model', async () => {
    const s = server({ status: 409, json: { error: 'not_configured' } })
    const t = createTeamNotes({ session: session(), fetch: s.fetch })
    const changes: boolean[] = []
    t.onChange((a) => changes.push(a))
    const local = localModel()
    const llm = await t.wrap(local).llm()
    expect(await llm.chat('x', () => {})).toBe('local')
    expect(t.active()).toBe(false)
    expect(changes).toEqual([true, false])
  })
})

describe('setup with remote notes', () => {
  const catalog = bundled as unknown as Catalog
  const hw: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1 Max', totalRamGB: 32, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1 Max', vramGB: 24 } }
  const llmUrls = new Set(catalog.models.flatMap((m) => m.builds.map((b) => b.url)))

  function make(remote: boolean) {
    const asked: string[] = []
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const download: DownloadDeps['download'] = async (url, ...rest) => { asked.push(url); return inner.download(url, ...rest) }
    const deps: SetupDeps = {
      getHardware: async () => hw, getCatalog: async () => catalog, modelsDir: mkdtempSync(join(tmpdir(), 'yogurt-team-setup-')),
      download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0, 0], remoteNotes: async () => remote,
    }
    return { c: new SetupController(deps), asked }
  }

  it('is ready with speech and meaning search but no notes model, and notes wait on nothing', async () => {
    const { c, asked } = make(true)
    const arrived = vi.fn()
    c.onNotesModel(arrived)
    await c.start()
    await c.idle()
    expect(c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(c.state.notesDownloading).toBeFalsy()
    expect(c.state.notesError).toBeUndefined()
    expect(c.installed()?.asr).toBeTruthy()
    expect(c.notesPath()).toBeUndefined()
    expect(asked.some((u) => llmUrls.has(u))).toBe(false)
    expect(asked).toContain(catalog.embedding.url)
    expect(arrived).toHaveBeenCalled()
  })

  it('downloads the notes models as upstream does once the team server stops writing notes', async () => {
    const { c, asked } = make(true)
    await c.start()
    await c.idle()
    c.startLocalNotes()
    await c.idle()
    expect(c.notesPath()).toBeTruthy()
    expect(asked.some((u) => llmUrls.has(u))).toBe(true)
    const n = asked.length
    c.startLocalNotes()
    await c.idle()
    expect(asked.length).toBe(n)
  })

  it('is unchanged from upstream when remote notes are off', async () => {
    const { c, asked } = make(false)
    await c.start()
    await c.idle()
    expect(c.notesPath()).toBeTruthy()
    expect(asked.some((u) => llmUrls.has(u))).toBe(true)
    c.startLocalNotes()
  })
})
