import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import type { ZodType } from 'zod'
import { authenticate, bearerToken, createSession, publicUser, redeemLoginCode, revokeSession, type User } from '../auth.js'
import { apiError, type Deps, type Env } from '../context.js'
import { callOpenRouter, chatRequestSchema, reemit, sse } from '../llm.js'
import {
  UploadError,
  completeRequestSchema,
  completeUpload,
  deleteRecording,
  startUpload,
  uploadRequestSchema,
} from '../uploads.js'
import { USER_COLUMNS, toUser } from '../auth.js'
import { mountStt } from '../stt.js'

async function readJson<T>(c: Context, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { ok: false, message: 'The request body must be JSON.' }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request.' }
  }
  return { ok: true, data: parsed.data }
}

function uploadErrorResponse(c: Context, err: unknown) {
  if (err instanceof UploadError) {
    if (err.code === 'not_configured') return apiError(c, 409, 'not_configured', err.message)
    if (err.code === 'not_found') return apiError(c, 404, 'not_found', err.message)
    return apiError(c, 502, 'upstream_error', err.message)
  }
  throw err
}

export function apiRoutes(deps: Deps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.post('/api/desktop/exchange', async (c) => {
    let code: unknown
    try {
      code = ((await c.req.json()) as { code?: unknown }).code
    } catch {
      return apiError(c, 400, 'bad_request', 'The request body must be JSON.')
    }
    if (typeof code !== 'string' || !code) return apiError(c, 400, 'bad_request', 'code is required.')
    const userId = await redeemLoginCode(db, code)
    if (!userId) return apiError(c, 401, 'unauthorized', 'This sign-in code is invalid, expired or already used.')
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId])
    const user = rows[0] ? toUser(rows[0]) : null
    if (!user || user.blocked) return apiError(c, 403, 'forbidden', 'This account no longer has access.')
    const token = await createSession(db, user.id, 'desktop')
    return c.json({ token, user: publicUser(user) })
  })

  // Everything below needs a desktop bearer token.
  const authed = new Hono<Env>()
  authed.use('*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    const user = token ? await authenticate(db, token, 'desktop') : null
    if (!user) return apiError(c, 401, 'unauthorized', 'Sign in again.')
    c.set('user', user)
    await next()
  })

  authed.get('/me', async (c) => {
    const user = c.get('user')
    const settings = await deps.settings.get(db)
    const [refreshToken, openrouter] = await Promise.all([
      deps.settings.getSecret(db, 'driveRefreshToken'),
      deps.settings.openrouter(db),
    ])
    return c.json({
      user: publicUser(user),
      team: {
        name: settings.teamName,
        driveConnected: !!refreshToken && !!settings.driveFolder,
        summariesEnabled: !!openrouter.key,
        transcriptionEnabled: !!deps.config.kejueApiKey,
        uploadAudio: settings.uploadAudio,
        uploadTranscript: settings.uploadTranscript,
        uploadNotes: settings.uploadNotes,
        graceMinutes: settings.graceMinutes,
      },
    })
  })

  authed.post('/desktop/signout', async (c) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token) await revokeSession(db, token)
    return c.json({ ok: true })
  })

  authed.post('/uploads', async (c) => {
    const body = await readJson(c, uploadRequestSchema)
    if (!body.ok) return apiError(c, 400, 'bad_request', body.message)
    const user: User = c.get('user')
    try {
      const settings = await deps.settings.get(db)
      const result = await startUpload(db, await deps.drive(), settings, user, body.data)
      deps.log('upload started', { uploadId: result.uploadId, user: user.email, audio: result.audio.length })
      return c.json(result)
    } catch (err) {
      deps.log('upload failed', { user: user.email, error: err instanceof Error ? err.message : String(err) })
      return uploadErrorResponse(c, err)
    }
  })

  authed.post('/uploads/:uploadId/complete', async (c) => {
    const body = await readJson(c, completeRequestSchema)
    if (!body.ok) return apiError(c, 400, 'bad_request', body.message)
    try {
      return c.json(await completeUpload(db, await deps.drive(), c.get('user'), c.req.param('uploadId'), body.data))
    } catch (err) {
      return uploadErrorResponse(c, err)
    }
  })

  authed.delete('/uploads/by-meeting/:meetingId', async (c) => {
    try {
      return c.json(await deleteRecording(db, await deps.drive(), c.get('user'), c.req.param('meetingId')))
    } catch (err) {
      return uploadErrorResponse(c, err)
    }
  })

  mountStt(authed, deps.config, deps.fetchImpl)

  authed.post('/llm/chat', async (c) => {
    const body = await readJson(c, chatRequestSchema)
    if (!body.ok) return apiError(c, 400, 'bad_request', body.message)
    const { key, model } = await deps.settings.openrouter(db)
    if (!key) return apiError(c, 409, 'not_configured', 'An admin has not set an OpenRouter key.')

    const abort = new AbortController()
    c.req.raw.signal?.addEventListener('abort', () => abort.abort())
    let upstream: Response
    try {
      upstream = await callOpenRouter({
        apiKey: key,
        model,
        request: body.data,
        referer: deps.config.publicUrl,
        signal: abort.signal,
        fetchImpl: deps.fetchImpl,
      })
    } catch (err) {
      return apiError(c, 502, 'upstream_error', `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!upstream.ok || !upstream.body) {
      let message = `OpenRouter returned ${upstream.status}.`
      try {
        const data = (await upstream.json()) as { error?: { message?: string } }
        if (data.error?.message) message = `OpenRouter: ${data.error.message}`
      } catch {
        // keep the status message
      }
      return apiError(c, 502, 'upstream_error', message)
    }

    const user = c.get('user')
    deps.log('llm chat', { user: user.email, purpose: body.data.purpose, model })
    c.header('Content-Type', 'text/event-stream; charset=utf-8')
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('X-Accel-Buffering', 'no')
    const upstreamBody = upstream.body
    return stream(c, async (s) => {
      s.onAbort(() => abort.abort())
      try {
        for await (const event of reemit(upstreamBody)) await s.write(event)
      } catch (err) {
        if (!abort.signal.aborted) await s.write(sse({ error: err instanceof Error ? err.message : String(err) }))
      }
    })
  })

  app.route('/api', authed)
  return app
}
