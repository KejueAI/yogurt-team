import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export type Db = pg.Pool
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

export function createPool(databaseUrl: string): Db {
  const ssl = /sslmode=(require|verify-ca|verify-full|no-verify)/.test(databaseUrl)
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    ...(ssl && !/sslmode=verify/.test(databaseUrl) ? { ssl: { rejectUnauthorized: false } } : {}),
  })
}

/** Applies every `NNN_name.sql` file not yet recorded, in order, each in its own transaction. */
export async function migrate(db: Db, dir = DEFAULT_MIGRATIONS_DIR, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const client = await db.connect()
  const applied: string[] = []
  try {
    // One migrator at a time, even with several replicas booting together.
    await client.query('SELECT pg_advisory_lock(424242)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
      applied.push(file)
      log(`Applied migration ${file}`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {})
    client.release()
  }
  return applied
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
