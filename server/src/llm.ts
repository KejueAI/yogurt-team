import { z } from 'zod'
import type { Fetch } from './google.js'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  purpose: z.enum(['summary', 'title', 'chat', 'other']).default('other'),
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

/** Extra room for models that must think before answering, so the thinking can't use up the answer's tokens */
export const REASONING_HEADROOM = 4096

/**
 * The app's token limits are sized for the answer alone. Thinking is turned off so it can't spend them; a model that
 * cannot answer without thinking is asked again (see callOpenRouter) with low effort and room for it.
 */
export function openRouterBody(req: ChatRequest, model: string, mustReason = false): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: req.messages, stream: true }
  body.reasoning = mustReason ? { effort: 'low', exclude: true } : { enabled: false }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens + (mustReason ? REASONING_HEADROOM : 0)
  if (req.temperature !== undefined) body.temperature = req.temperature
  return body
}

/** OpenRouter's answer when a model's endpoint refuses to turn thinking off */
export function reasoningIsMandatory(status: number, text: string): boolean {
  return status === 400 && /reasoning/i.test(text) && /mandatory|required|cannot be disabled/i.test(text)
}

export async function callOpenRouter(opts: {
  apiKey: string
  model: string
  request: ChatRequest
  referer: string
  signal?: AbortSignal
  fetchImpl?: Fetch
}): Promise<Response> {
  const send = (mustReason: boolean) =>
    (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'HTTP-Referer': opts.referer,
        'X-Title': 'Yogurt Team',
      },
      body: JSON.stringify(openRouterBody(opts.request, opts.model, mustReason)),
      signal: opts.signal,
    })
  const res = await send(false)
  if (res.status !== 400) return res
  const text = await res.text()
  if (reasoningIsMandatory(res.status, text)) return send(true)
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export function sse(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message
  return 'The model returned an error.'
}

/**
 * Reads OpenRouter's OpenAI-style SSE stream and yields events in the app's shape:
 * `data: {"delta":"..."}` per content chunk, then `data: {"done":true}`, or
 * `data: {"error":"..."}` if the stream fails. Comment lines (": OPENROUTER PROCESSING")
 * and reasoning deltas are dropped.
 */
export async function* reemit(upstream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = upstream.getReader()
  let buffer = ''
  let finished = false

  const handleEvent = (data: string): { out?: string; end?: boolean } => {
    if (data === '[DONE]') return { out: sse({ done: true }), end: true }
    let chunk: {
      error?: unknown
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null; error?: unknown }[]
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      return {}
    }
    if (chunk.error) return { out: sse({ error: errorMessage(chunk.error) }), end: true }
    const choice = chunk.choices?.[0]
    if (choice?.error) return { out: sse({ error: errorMessage(choice.error) }), end: true }
    if (choice?.finish_reason === 'error') return { out: sse({ error: 'The model stopped with an error.' }), end: true }
    const delta = choice?.delta?.content
    return delta ? { out: sse({ delta }) } : {}
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while (!finished && (idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx)
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '')
        const data = rawEvent
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        const { out, end } = handleEvent(data)
        if (out) yield out
        if (end) finished = true
      }
    }
    if (!finished) {
      const tail = buffer.trim()
      if (tail.startsWith('data:')) {
        const { out, end } = handleEvent(tail.slice(5).trim())
        if (out) yield out
        if (end) return
      }
      // The connection closed without [DONE]; what arrived is all there is.
      yield sse({ done: true })
    }
  } catch (err) {
    yield sse({ error: `The model stream broke: ${errorMessage(err)}` })
  } finally {
    reader.cancel().catch(() => {})
  }
}
