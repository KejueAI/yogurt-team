import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { mountStt } from '../src/stt.js'

const base = { kejueApiUrl: 'https://stt.example.com/v1', kejueSttModel: 'kejue-stt' } as Config

function setup(key: string | undefined, reply: (url: string, init: RequestInit) => Response = () => Response.json({ id: 'job1', status: 'validating' }, { status: 202 })) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(url, init) }) as unknown as typeof fetch
  const app = new Hono()
  mountStt(app, { ...base, kejueApiKey: key }, fetchImpl)
  return { app, calls }
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('transcription proxy', () => {
  it('refuses when the server has no key', async () => {
    const { app, calls } = setup(undefined)
    const res = await app.request('/stt/jobs', post({ upload_id: 'u1' }))
    expect(res.status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('creates a job with the server model and key, passing the idempotency key through', async () => {
    const { app, calls } = setup('secret-key')
    const res = await app.request('/stt/jobs', post({ upload_id: 'u1', model: 'something-else', language: 'ar', timestamp_granularity: 'word' }, { 'Idempotency-Key': 'abc-1' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: 'job1', status: 'validating' })
    expect(calls[0]!.url).toBe('https://stt.example.com/v1/inference/transcription-jobs')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer secret-key')
    expect(h['Idempotency-Key']).toBe('abc-1')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ upload_id: 'u1', model: 'kejue-stt', language: 'ar', timestamp_granularity: 'word' })
  })

  it('forwards upstream errors as they are and rejects bad ids', async () => {
    const { app } = setup('k', () => Response.json({ error: { code: 'inference_result_not_ready' } }, { status: 409 }))
    const res = await app.request('/stt/jobs/job1/result')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('inference_result_not_ready')
    expect((await app.request('/stt/jobs/..%2Fadmin')).status).toBe(400)
  })

  it('asks for JSON results with a reason', async () => {
    const { app, calls } = setup('k', () => Response.json({ words: [] }))
    await app.request('/stt/jobs/job1/result')
    expect(calls[0]!.url).toMatch(/\/inference\/transcription-jobs\/job1\/result\?format=json&reason=/)
  })

  it('aborts an unused upload', async () => {
    const { app, calls } = setup('k', () => Response.json({}))
    const res = await app.request('/stt/uploads/up1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('https://stt.example.com/v1/inference/uploads/up1')
    expect(calls[0]!.init.method).toBe('DELETE')
  })

  it('reports an unreachable service as 502', async () => {
    const { app } = setup('k', () => { throw new Error('down') })
    const res = await app.request('/stt/uploads/u1/complete', post({}))
    expect(res.status).toBe(502)
  })
})
