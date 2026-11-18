import type { Llm } from '../notes/enhance'
import type { NotesModel } from '../notes/model'

/**
 * Yogurt Team: meeting notes, titles, part summaries and Ask answers written by a cloud model through the team
 * server (server/API.md, "Summaries (OpenRouter)") instead of the local notes model. Remote only when signed in and
 * the server says summaries are on; anything else is the local model exactly as upstream.
 */

/** What this needs from the team sign-in (team/session.ts, owned by the sign-in work). */
export type TeamSession = {
  /** the team server's base URL, e.g. https://yogurt.example.com; undefined when not set up */
  serverUrl(): string | undefined
  /** the bearer token; undefined when signed out */
  token(): Promise<string | undefined>
  /** GET /api/me's team.summariesEnabled (an admin set an OpenRouter key) */
  summariesEnabled(): Promise<boolean>
}

/** Until team/session.ts lands: never signed in, so the local model is used everywhere. */
export const signedOutSession: TeamSession = {
  serverUrl: () => undefined,
  token: async () => undefined,
  summariesEnabled: async () => false,
}

export type Purpose = 'summary' | 'title' | 'chat' | 'other'
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ChatRequest = { messages: ChatMessage[]; maxTokens?: number; temperature?: number; purpose: Purpose }

/** The server has no OpenRouter key (409 not_configured): the local model takes over. */
export class NotConfiguredError extends Error {
  constructor() { super('Summaries are not configured on the team server'); this.name = 'NotConfiguredError' }
}
/** Signed out on the server (401) */
export class UnauthorizedError extends Error {
  constructor() { super('Signed out of the team server'); this.name = 'UnauthorizedError' }
}
/** Anything else the server or OpenRouter said went wrong */
export class RemoteLlmError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'RemoteLlmError' }
}

/**
 * The cloud model's context, in chars/4 estimated tokens. Comfortably under what the usual OpenRouter models take
 * (128k and up), so the estimate's slack never overflows.
 */
export const REMOTE_CONTEXT_TOKENS = 96_000
/** a long meeting is split into parts this big for the cloud model (local: MAX_PART_TOKENS, 12k) */
export const REMOTE_PART_TOKENS = 32_000
/** Notes for a long meeting need room: at 2,048 tokens a three-hour meeting's notes were cut off halfway */
export const REMOTE_NOTES_TOKENS = 6_144

/** chars/4: good enough for budgeting a remote model whose tokenizer the app doesn't have */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/**
 * POST /api/llm/chat and read its event stream, handing each delta to onToken. Resolves with the whole text at
 * {"done":true}; rejects with NotConfiguredError on 409, UnauthorizedError on 401, RemoteLlmError otherwise, and the
 * signal's reason when it is aborted.
 */
export async function streamChat(o: {
  serverUrl: string; token: string; request: ChatRequest; onToken: (text: string) => void
  signal?: AbortSignal; fetch?: typeof fetch
}): Promise<string> {
  const f = o.fetch ?? fetch
  o.signal?.throwIfAborted()
  const res = await f(new URL('/api/llm/chat', o.serverUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${o.token}` },
    body: JSON.stringify(o.request),
    signal: o.signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: string; message?: string } | undefined
    if (res.status === 409 && (!body?.error || body.error === 'not_configured')) throw new NotConfiguredError()
    if (res.status === 401) throw new UnauthorizedError()
    throw new RemoteLlmError(body?.message ?? body?.error ?? `The team server answered ${res.status}`, res.status)
  }
  if (!res.body) throw new RemoteLlmError('The team server sent no answer')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', text = '', data: string[] = []
  // one event: its data lines joined; true at done
  const event = (): boolean => {
    const payload = data.join('\n'); data = []
    if (!payload) return false
    let msg: { delta?: unknown; done?: unknown; error?: unknown }
    try { msg = JSON.parse(payload) } catch { return false }
    if (typeof msg.error === 'string' || (msg.error && typeof msg.error === 'object')) {
      throw new RemoteLlmError(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error))
    }
    if (typeof msg.delta === 'string' && msg.delta) { text += msg.delta; o.onToken(msg.delta) }
    return msg.done === true
  }
  const line = (l: string): boolean => {
    if (l.endsWith('\r')) l = l.slice(0, -1)
    if (l === '') return event()
    if (l.startsWith(':')) return false
    if (l.startsWith('data:')) data.push(l.slice(l[5] === ' ' ? 6 : 5))
    return false
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const l = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        if (line(l)) return text
      }
    }
    buffer += decoder.decode()
    if (buffer && line(buffer)) return text
    if (event()) return text
  } catch (e) {
    o.signal?.throwIfAborted()
    throw e
  } finally {
    reader.cancel().catch(() => {})
  }
  o.signal?.throwIfAborted()
  throw new RemoteLlmError('The team server stopped before the answer was done')
}

/** Earlier [prompt, answer] pairs as alternating user and assistant turns, as the local model does (notes/model.ts). */
const history = (before?: string[]): ChatMessage[] =>
  (before ?? []).map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }))

/** What a chat is for, so the server can log it: a part summary, a short title, an Ask answer or anything else. */
const purposeOf = (base: Purpose | undefined, opts?: { summary?: boolean; maxTokens?: number }): Purpose =>
  base ?? (opts?.summary ? 'summary' : opts?.maxTokens !== undefined && opts.maxTokens <= 60 ? 'title' : 'other')

/** The Llm the notes, title and Ask code already use, over the team server. No readAhead: nothing to warm remotely. */
export class RemoteLlm implements Llm {
  readonly contextSize = REMOTE_CONTEXT_TOKENS
  readonly partTokens = REMOTE_PART_TOKENS
  readonly notesTokens = REMOTE_NOTES_TOKENS

  constructor(private o: {
    serverUrl: string; token: string; signal?: AbortSignal; purpose?: Purpose; fetch?: typeof fetch
    /** 409 not_configured: told before the chat moves to the local model */
    onNotConfigured?: () => void
    /** the local model, for a chat the server turns down with not_configured (only when the prompt fits it) */
    fallback?: () => Promise<Llm>
  }) {}

  async count(texts: string[]) { return texts.map(estimateTokens) }

  async chat(prompt: string, onToken: (text: string) => void, opts?: Parameters<Llm['chat']>[2]): Promise<string> {
    const request: ChatRequest = {
      messages: [...history(opts?.before), { role: 'user', content: prompt }],
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      purpose: purposeOf(this.o.purpose, opts),
    }
    try {
      return await streamChat({ serverUrl: this.o.serverUrl, token: this.o.token, request, onToken, signal: this.o.signal, fetch: this.o.fetch })
    } catch (e) {
      if (!(e instanceof NotConfiguredError)) throw e
      this.o.onNotConfigured?.()
      if (!this.o.fallback) throw e
      const local = await this.o.fallback()
      // the prompt was cut for the cloud model's bigger context: only a local model it still fits can take it
      const counts = await local.count([prompt, ...(opts?.before ?? [])])
      if (counts.reduce((a, b) => a + b, 0) + (opts?.maxTokens ?? 0) > local.contextSize) throw e
      console.info('NOTES', 'summaries are off on the team server: the local notes model writes this')
      return local.chat(prompt, onToken, opts)
    }
  }
}

/** The parts of the local notes model (notes/model.ts) the app uses */
export type NotesModelLike = Pick<NotesModel, 'llm' | 'unload' | 'loaded' | 'needsLoad'>

export type TeamNotesOptions = {
  session: TeamSession
  fetch?: typeof fetch
  /** how long a "summaries on/off" answer is trusted (default a minute) */
  ttlMs?: number
  /** a session that takes longer than this to answer counts as off (default 5 s) */
  timeoutMs?: number
  now?: () => number
}

/**
 * Picks the model for each job: the team server when signed in and summaries are on, the local notes model otherwise.
 * `active()` is the last answer, for the synchronous readiness checks (the notes queue, Ask's "waiting for the model").
 */
export function createTeamNotes(o: TeamNotesOptions) {
  const ttl = o.ttlMs ?? 60_000, timeout = o.timeoutMs ?? 5_000, now = o.now ?? Date.now
  let last = false, checkedAt = -Infinity, checking: Promise<boolean> | undefined
  const listeners = new Set<(active: boolean) => void>()

  const settle = (active: boolean) => {
    checkedAt = now()
    if (active === last) return active
    last = active
    console.info('NOTES', active ? 'notes are written by the team server' : 'notes are written by the local notes model')
    for (const l of listeners) { try { l(active) } catch (e) { console.error('team notes listener failed', e) } }
    return active
  }

  const ask = async (): Promise<boolean> => {
    if (!o.session.serverUrl() || !(await o.session.token())) return false
    return o.session.summariesEnabled()
  }

  /** whether summaries go to the team server now (cached for ttlMs; a failing or slow session counts as off) */
  const remoteActive = (fresh = false): Promise<boolean> => {
    if (!fresh && now() - checkedAt < ttl) return Promise.resolve(last)
    checking ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const slow = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout) })
        return settle(await Promise.race([ask().catch((e) => { console.warn('could not check team summaries', e); return false }), slow]))
      } finally { clearTimeout(timer); checking = undefined }
    })()
    return checking
  }

  /** the server said not_configured: off until the next check */
  const turnedDown = () => { settle(false) }

  return {
    remoteActive,
    /** the last answer, without waiting */
    active: () => last,
    /** called when remote summaries turn on or off */
    onChange(cb: (active: boolean) => void) { listeners.add(cb); return () => listeners.delete(cb) },
    /** forget the cached answer (signed in or out, the team settings changed) */
    invalidate() { checkedAt = -Infinity },
    turnedDown,

    /**
     * The local notes model with the team server in front of it: llm() is remote while active, local otherwise.
     * `as(purpose)` labels every chat of one consumer (Ask: 'chat').
     */
    wrap(local: NotesModelLike) {
      const make = (purpose?: Purpose) => ({
        async llm(signal?: AbortSignal): Promise<Llm> {
          if (await remoteActive()) {
            const serverUrl = o.session.serverUrl(), token = await o.session.token()
            if (serverUrl && token) {
              return new RemoteLlm({
                serverUrl, token, signal, fetch: o.fetch, onNotConfigured: turnedDown,
                fallback: () => local.llm(signal),
                ...(purpose ? { purpose } : {}),
              })
            }
          }
          return local.llm(signal)
        },
        unload: () => local.unload(),
        loaded: () => local.loaded(),
        /** remote never loads anything */
        needsLoad: () => !last && local.needsLoad(),
      })
      return { ...make(), as: (purpose: Purpose) => make(purpose) }
    },
  }
}
export type TeamNotes = ReturnType<typeof createTeamNotes>
