import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { adminRoutes } from './admin/routes.js'
import { apiError, type Deps, type Env } from './context.js'
import { apiRoutes } from './routes/api.js'
import { authRoutes } from './routes/auth.js'
import { downloadRoutes } from './download.js'

export function createApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>()

  app.get('/healthz', async (c) => {
    try {
      await deps.db.query('SELECT 1')
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false }, 503)
    }
  })
  // the public download page for the desktop app
  app.route('/', downloadRoutes(deps))

  // Sign-in routes go first so /admin/login and friends are reachable without a session.
  app.route('/', authRoutes(deps))
  app.route('/', apiRoutes(deps))
  app.route('/admin', adminRoutes(deps))

  app.notFound((c) => (c.req.path.startsWith('/api/') ? apiError(c, 404, 'not_found', 'Not found.') : c.text('Not found', 404)))
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    deps.log('unhandled error', { path: c.req.path, error: err.message, stack: err.stack })
    return c.req.path.startsWith('/api/')
      ? apiError(c, 500, 'internal', 'Something went wrong on the server.')
      : c.text('Something went wrong on the server.', 500)
  })
  return app
}
