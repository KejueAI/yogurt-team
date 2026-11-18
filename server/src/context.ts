import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { deriveKeys, type Keys } from './crypto.js'
import { DriveClient, GoogleOAuth, type Fetch } from './google.js'
import { SettingsStore } from './settings.js'
import type { User } from './auth.js'

export interface Deps {
  config: Config
  db: Db
  keys: Keys
  settings: SettingsStore
  oauth: GoogleOAuth
  fetchImpl: Fetch
  /** The Drive client for the admin's connected account, or null when Drive isn't connected. */
  drive(): Promise<DriveClient | null>
  log: (msg: string, extra?: Record<string, unknown>) => void
}

export type Env = { Variables: { user: User } }

export function createDeps(config: Config, db: Db, fetchImpl: Fetch = fetch): Deps {
  const keys = deriveKeys(config.secretKey)
  const settings = new SettingsStore(config, keys.encryption)
  const oauth = new GoogleOAuth(config.googleClientId, config.googleClientSecret, fetchImpl)
  let cachedClient: { refreshToken: string; client: DriveClient } | null = null
  return {
    config,
    db,
    keys,
    settings,
    oauth,
    fetchImpl,
    async drive() {
      const refreshToken = await settings.getSecret(db, 'driveRefreshToken')
      if (!refreshToken) return null
      if (cachedClient?.refreshToken !== refreshToken) {
        const client = new DriveClient(async () => {
          const res = await oauth.refresh(refreshToken)
          return { token: res.access_token, expiresIn: res.expires_in }
        }, fetchImpl)
        cachedClient = { refreshToken, client }
      }
      return cachedClient.client
    },
    log(msg, extra) {
      console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))
    },
  }
}

export type ErrorCode = 'unauthorized' | 'forbidden' | 'not_configured' | 'bad_request' | 'not_found' | 'upstream_error' | 'internal'

export function apiError(c: Context, status: ContentfulStatusCode, error: ErrorCode, message: string) {
  return c.json({ error, message }, status)
}
