// Yogurt Team: end-of-meeting transcription through Kejue Inference (kejue-stt).
// The server holds the API key and forwards only the calls a file job needs; the app PUTs the audio bytes
// straight to the presigned storage addresses the API hands back, so recordings never pass through here.
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Config } from './config.js'

type Fetch = typeof fetch

const ID = /^[A-Za-z0-9_-]{1,100}$/
const LANGUAGES = new Set(['en', 'ar', 'auto'])
const GRANULARITIES = new Set(['none', 'chunk', 'word'])

/** one call to the Kejue API: its status and JSON body passed back as they are */
async function call(config: Config, fetchImpl: Fetch, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.kejueApiKey}`,
    Accept: 'application/json',
    // the API sits behind Cloudflare, which refuses some default library user agents
    'User-Agent': 'yogurt-team-server',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey && /^[\x21-\x7e]{1,200}$/.test(idempotencyKey) ? idempotencyKey : randomUUID()
  let res: Response
  try {
    res = await fetchImpl(`${config.kejueApiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (err) {
    return Response.json({ error: { code: 'upstream_error', message: `Could not reach the transcription service: ${err instanceof Error ? err.message : String(err)}` } }, { status: 502 })
  }
  const text = await res.text()
  return new Response(text || '{}', { status: res.status, headers: { 'Content-Type': 'application/json' } })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountStt(authed: Hono<any>, config: Config, fetchImpl: Fetch) {
  const ready = (c: { json: (b: unknown, s: number) => Response }) =>
    config.kejueApiKey ? null : c.json({ error: { code: 'not_configured', message: 'This server has no transcription key (KEJUE_API_KEY).' } }, 409)
  const idem = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('Idempotency-Key')
  const json = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> => {
    try { const b = await c.req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null } catch { return null }
  }
  const bad = (c: { json: (b: unknown, s: number) => Response }, message: string) => c.json({ error: { code: 'bad_request', message } }, 400)

  authed.post('/stt/uploads', async (c) => {
    const r = ready(c); if (r) return r
    const b = await json(c)
    if (!b || typeof b.filename !== 'string' || !Number.isSafeInteger(b.size_bytes) || (b.size_bytes as number) <= 0 || typeof b.content_type !== 'string') return bad(c, 'filename, size_bytes and content_type are required')
    return call(config, fetchImpl, 'POST', '/inference/uploads', { filename: b.filename.slice(0, 200), size_bytes: b.size_bytes, content_type: b.content_type }, idem(c))
  })

  authed.post('/stt/uploads/:id/parts', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad upload id')
    const b = await json(c)
    if (!b || !Array.isArray(b.parts) || !b.parts.length || b.parts.length > 4) return bad(c, 'parts: 1 to 4 parts')
    const parts = (b.parts as Array<Record<string, unknown>>).map((p) => ({ part_number: p.part_number, checksum_sha256: p.checksum_sha256 }))
    if (parts.some((p) => !Number.isSafeInteger(p.part_number) || typeof p.checksum_sha256 !== 'string')) return bad(c, 'each part needs part_number and checksum_sha256')
    return call(config, fetchImpl, 'POST', `/inference/uploads/${id}/parts`, { parts }, idem(c))
  })

  authed.post('/stt/uploads/:id/complete', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad upload id')
    return call(config, fetchImpl, 'POST', `/inference/uploads/${id}/complete`, {}, idem(c))
  })

  // an upload that never became a job holds one of the workspace's upload slots until it is aborted
  authed.delete('/stt/uploads/:id', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad upload id')
    return call(config, fetchImpl, 'DELETE', `/inference/uploads/${id}`)
  })

  authed.post('/stt/jobs', async (c) => {
    const r = ready(c); if (r) return r
    const b = await json(c)
    if (!b || typeof b.upload_id !== 'string' || !ID.test(b.upload_id)) return bad(c, 'upload_id is required')
    const language = typeof b.language === 'string' && LANGUAGES.has(b.language) ? b.language : 'auto'
    const granularity = typeof b.timestamp_granularity === 'string' && GRANULARITIES.has(b.timestamp_granularity) ? b.timestamp_granularity : 'chunk'
    // the model is the server's choice, not the app's
    return call(config, fetchImpl, 'POST', '/inference/transcription-jobs', { upload_id: b.upload_id, model: config.kejueSttModel, language, timestamp_granularity: granularity }, idem(c))
  })

  authed.get('/stt/jobs/:id', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad job id')
    return call(config, fetchImpl, 'GET', `/inference/transcription-jobs/${id}`)
  })

  authed.get('/stt/jobs/:id/result', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad job id')
    return call(config, fetchImpl, 'GET', `/inference/transcription-jobs/${id}/result?format=json&reason=${encodeURIComponent('Yogurt Team meeting transcript for the recording user')}`)
  })

  authed.delete('/stt/jobs/:id', async (c) => {
    const r = ready(c); if (r) return r
    const id = c.req.param('id'); if (!ID.test(id)) return bad(c, 'bad job id')
    return call(config, fetchImpl, 'DELETE', `/inference/transcription-jobs/${id}`)
  })
}
