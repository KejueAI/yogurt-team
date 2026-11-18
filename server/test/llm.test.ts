import { describe, expect, it, vi } from 'vitest'
import { OPENROUTER_URL, REASONING_HEADROOM, callOpenRouter, chatRequestSchema, openRouterBody, reemit, sse } from '../src/llm.js'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const event of reemit(streamOf(chunks))) {
    expect(event).toMatch(/^data: .*\n\n$/)
    out.push(JSON.parse(event.slice(6)))
  }
  return out
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

describe('SSE re-emission', () => {
  it('turns OpenAI-style chunks into delta events and a final done', async () => {
    expect(await collect([': OPENROUTER PROCESSING\n\n', delta('Hel'), delta('lo'), 'data: [DONE]\n\n'])).toEqual([
      { delta: 'Hel' },
      { delta: 'lo' },
      { done: true },
    ])
  })

  it('handles events split across network chunks and CRLF line endings', async () => {
    const full = delta('Hello, world') + delta(' again') + 'data: [DONE]\n\n'
    const crlf = full.replace(/\n/g, '\r\n')
    const pieces = crlf.match(/.{1,7}/gs) ?? []
    expect(await collect(pieces)).toEqual([{ delta: 'Hello, world' }, { delta: ' again' }, { done: true }])
  })

  it('skips empty deltas and role-only chunks', async () => {
    const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`
    expect(await collect([roleOnly, delta(''), delta('x'), 'data: [DONE]\n\n'])).toEqual([{ delta: 'x' }, { done: true }])
  })

  it('emits an error for a mid-stream provider error and stops', async () => {
    const err = `data: ${JSON.stringify({ error: { message: 'Provider overloaded' } })}\n\n`
    expect(await collect([delta('a'), err, delta('b')])).toEqual([{ delta: 'a' }, { error: 'Provider overloaded' }])
  })

  it('emits an error for finish_reason error', async () => {
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`
    const out = await collect([delta('a'), chunk])
    expect(out[0]).toEqual({ delta: 'a' })
    expect(out[1]).toHaveProperty('error')
    expect(out).toHaveLength(2)
  })

  it('still finishes when the upstream closes without [DONE]', async () => {
    expect(await collect([delta('a')])).toEqual([{ delta: 'a' }, { done: true }])
  })

  it('ignores malformed lines', async () => {
    expect(await collect(['data: {not json\n\n', delta('ok'), 'data: [DONE]\n\n'])).toEqual([{ delta: 'ok' }, { done: true }])
  })

  it('formats events', () => {
    expect(sse({ delta: 'a\nb' })).toBe('data: {"delta":"a\\nb"}\n\n')
  })
})

describe('OpenRouter request', () => {
  it('validates the contract body', () => {
    const parsed = chatRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }] })
    expect(parsed.purpose).toBe('other')
    expect(() => chatRequestSchema.parse({ messages: [{ role: 'tool', content: 'x' }] })).toThrow()
    expect(() => chatRequestSchema.parse({ messages: [] })).toThrow()
  })

  it('builds a streaming OpenAI-compatible body', () => {
    const req = chatRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, temperature: 0.2, purpose: 'summary' })
    expect(openRouterBody(req, 'anthropic/claude-sonnet-4.5')).toEqual({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoning: { enabled: false },
      max_tokens: 500,
      temperature: 0.2,
    })
    expect(openRouterBody(req, 'm', true)).toMatchObject({ reasoning: { effort: 'low', exclude: true }, max_tokens: 500 + REASONING_HEADROOM })
  })

  it('asks again with low-effort thinking when a model cannot turn it off', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}', { status: 400 }))
      .mockResolvedValueOnce(new Response('data: [DONE]', { status: 200 }))
    const request = chatRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
    const res = await callOpenRouter({ apiKey: 'k', model: 'm', request, referer: 'https://x', fetchImpl })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const second = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(second.reasoning).toEqual({ effort: 'low', exclude: true })
    expect(second.max_tokens).toBe(100 + REASONING_HEADROOM)
  })

  it('passes other 400s through unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"bad model"}}', { status: 400 }))
    const request = chatRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }] })
    const res = await callOpenRouter({ apiKey: 'k', model: 'm', request, referer: 'https://x', fetchImpl })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('bad model')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('posts to OpenRouter with the key and attribution headers', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const request = chatRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }] })
    await callOpenRouter({ apiKey: 'sk-or-test', model: 'm', request, referer: 'https://team.example.com', fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENROUTER_URL)
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-or-test')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('http-referer')).toBe('https://team.example.com')
    expect(JSON.parse(init.body as string).stream).toBe(true)
  })
})
