import type { Config } from './config.js'
import { decrypt, encrypt } from './crypto.js'
import type { Queryable } from './db.js'

export interface DriveFolder {
  id: string
  name: string
  /** Shared Drive id, absent for a My Drive folder. */
  driveId?: string
  /** Human-readable path shown on the admin page, e.g. "Team / Meetings". */
  path?: string
}

/** Everything an admin can change. Secrets are held encrypted in the database. */
export interface TeamSettings {
  teamName: string
  allowedDomains: string[]
  allowlist: string[]
  folderPattern: string
  filePattern: string
  timezone: string
  uploadAudio: boolean
  uploadTranscript: boolean
  uploadNotes: boolean
  graceMinutes: number
  driveFolder: DriveFolder | null
  driveAccountEmail: string | null
  openrouterModel: string | null
}

export interface Secrets {
  driveRefreshToken: string | null
  openrouterKey: string | null
}

export const DEFAULT_FOLDER_PATTERN = '{date} {title}'
export const DEFAULT_FILE_PATTERN = '{recorder} – {kind}'
export const DEFAULT_MODEL = 'openrouter/auto'

export function defaultSettings(config: Pick<Config, 'allowedDomains'>): TeamSettings {
  return {
    teamName: 'Yogurt Team',
    allowedDomains: config.allowedDomains,
    allowlist: [],
    folderPattern: DEFAULT_FOLDER_PATTERN,
    filePattern: DEFAULT_FILE_PATTERN,
    timezone: 'UTC',
    uploadAudio: true,
    uploadTranscript: true,
    uploadNotes: true,
    graceMinutes: 10,
    driveFolder: null,
    driveAccountEmail: null,
    openrouterModel: null,
  }
}

const SECRET_KEYS = { driveRefreshToken: 'secret.driveRefreshToken', openrouterKey: 'secret.openrouterKey' } as const

export class SettingsStore {
  constructor(
    private readonly config: Pick<Config, 'allowedDomains' | 'openrouterApiKey' | 'openrouterModel'>,
    private readonly encryptionKey: Buffer,
  ) {}

  async get(db: Queryable): Promise<TeamSettings> {
    const { rows } = await db.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM settings WHERE key NOT LIKE 'secret.%'",
    )
    const settings = defaultSettings(this.config) as unknown as Record<string, unknown>
    for (const row of rows) if (row.key in settings) settings[row.key] = row.value
    return settings as unknown as TeamSettings
  }

  async update(db: Queryable, patch: Partial<TeamSettings>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      )
    }
  }

  async getSecret(db: Queryable, name: keyof Secrets): Promise<string | null> {
    const { rows } = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [SECRET_KEYS[name]])
    const stored = rows[0]?.value
    return stored ? decrypt(stored, this.encryptionKey) : null
  }

  async setSecret(db: Queryable, name: keyof Secrets, value: string | null): Promise<void> {
    if (value === null) {
      await db.query('DELETE FROM settings WHERE key = $1', [SECRET_KEYS[name]])
      return
    }
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SECRET_KEYS[name], JSON.stringify(encrypt(value, this.encryptionKey))],
    )
  }

  /** The admin-set key wins; OPENROUTER_API_KEY is the fallback. */
  async openrouter(db: Queryable): Promise<{ key: string | null; model: string; source: 'admin' | 'env' | null }> {
    const settings = await this.get(db)
    const stored = await this.getSecret(db, 'openrouterKey')
    const model = settings.openrouterModel || this.config.openrouterModel || DEFAULT_MODEL
    if (stored) return { key: stored, model, source: 'admin' }
    if (this.config.openrouterApiKey) return { key: this.config.openrouterApiKey, model, source: 'env' }
    return { key: null, model, source: null }
  }
}
