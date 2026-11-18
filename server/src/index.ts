import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDeps } from './context.js'
import { createPool, migrate } from './db.js'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createPool(config.databaseUrl)
  const log = (msg: string) => console.log(JSON.stringify({ time: new Date().toISOString(), msg }))
  await migrate(db, undefined, log)
  // Drop expired one-time records now and then.
  const sweep = setInterval(() => {
    db.query(`DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'`).catch(() => {})
    db.query(`DELETE FROM oauth_states WHERE expires_at < now()`).catch(() => {})
  }, 60 * 60 * 1000)
  sweep.unref()

  const app = createApp(createDeps(config, db))
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
    log(`listening on :${info.port}`),
  )
  const shutdown = () => {
    log('shutting down')
    server.close(() => {
      db.end().finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
