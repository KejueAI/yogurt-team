import type { Queryable } from './db.js'
import { hashToken, randomToken } from './crypto.js'
import { isBootstrapAdmin, normalizeEmail } from './access.js'
import type { GoogleUser } from './google.js'

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
export const DESKTOP_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export interface User {
  id: number
  email: string
  name: string | null
  givenName: string | null
  picture: string | null
  isAdmin: boolean
  blocked: boolean
  lastSeenAt: Date | null
  createdAt: Date
}

interface UserRow {
  id: string
  email: string
  name: string | null
  given_name: string | null
  picture: string | null
  is_admin: boolean
  blocked: boolean
  last_seen_at: Date | null
  created_at: Date
}

export const USER_COLUMNS = 'u.id, u.email, u.name, u.given_name, u.picture, u.is_admin, u.blocked, u.last_seen_at, u.created_at'

export function toUser(row: UserRow): User {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    givenName: row.given_name,
    picture: row.picture,
    isAdmin: row.is_admin,
    blocked: row.blocked,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  }
}

/** The user object in API.md. */
export function publicUser(user: User): { email: string; name: string; picture: string | null; isAdmin: boolean } {
  return { email: user.email, name: user.name ?? user.email, picture: user.picture, isAdmin: user.isAdmin }
}

export async function findUserByEmail(db: Queryable, email: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.email = $1`, [normalizeEmail(email)])
  return rows[0] ? toUser(rows[0]) : null
}

/** Creates or refreshes the user after Google sign-in. ADMIN_EMAILS entries are always admins. */
export async function upsertUser(db: Queryable, g: GoogleUser, adminEmails: string[]): Promise<User> {
  const email = normalizeEmail(g.email)
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users AS u (email, name, given_name, picture, is_admin, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, u.name),
       given_name = COALESCE(EXCLUDED.given_name, u.given_name),
       picture = COALESCE(EXCLUDED.picture, u.picture),
       is_admin = u.is_admin OR EXCLUDED.is_admin,
       last_seen_at = now()
     RETURNING ${USER_COLUMNS}`,
    [email, g.name ?? null, g.givenName ?? null, g.picture ?? null, isBootstrapAdmin(email, adminEmails)],
  )
  return toUser(rows[0]!)
}

// --- OAuth state (CSRF protection for the Google round trip) ---

export async function createOAuthState(
  db: Queryable,
  kind: 'desktop' | 'admin' | 'drive',
  data: Record<string, unknown>,
  now = new Date(),
): Promise<string> {
  const state = randomToken()
  await db.query('DELETE FROM oauth_states WHERE expires_at < $1', [now])
  await db.query('INSERT INTO oauth_states (state_hash, kind, data, expires_at) VALUES ($1, $2, $3, $4)', [
    hashToken(state),
    kind,
    JSON.stringify(data),
    new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  ])
  return state
}

/** Returns the state's data once; a second use, a wrong kind or an expired state gives null. */
export async function consumeOAuthState(
  db: Queryable,
  state: string | undefined,
  kind: 'desktop' | 'admin' | 'drive',
  now = new Date(),
): Promise<Record<string, unknown> | null> {
  if (!state) return null
  const { rows } = await db.query<{ data: Record<string, unknown> }>(
    'DELETE FROM oauth_states WHERE state_hash = $1 AND kind = $2 AND expires_at > $3 RETURNING data',
    [hashToken(state), kind, now],
  )
  return rows[0]?.data ?? null
}

// --- One-time desktop login codes ---

export async function createLoginCode(db: Queryable, userId: number, now = new Date()): Promise<string> {
  const code = randomToken('ytc_')
  await db.query('DELETE FROM login_codes WHERE expires_at < $1', [now])
  await db.query('INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(code),
    userId,
    new Date(now.getTime() + LOGIN_CODE_TTL_MS),
  ])
  return code
}

/** Marks the code used and returns its user id, or null if unknown, used or expired. */
export async function redeemLoginCode(db: Queryable, code: string, now = new Date()): Promise<number | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE login_codes SET used_at = $2
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
     RETURNING user_id`,
    [hashToken(code), now],
  )
  return rows[0] ? Number(rows[0].user_id) : null
}

// --- Sessions (desktop bearer tokens and admin cookies) ---

export async function createSession(db: Queryable, userId: number, kind: 'desktop' | 'admin', now = new Date()): Promise<string> {
  const token = randomToken(kind === 'desktop' ? 'ytd_' : 'yta_')
  const ttl = kind === 'desktop' ? DESKTOP_SESSION_TTL_MS : ADMIN_SESSION_TTL_MS
  await db.query('INSERT INTO sessions (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    kind,
    hashToken(token),
    new Date(now.getTime() + ttl),
  ])
  return token
}

/**
 * The signed-in user for a token, or null. Revoked, expired and blocked sessions do not count.
 * Desktop sessions slide: each use pushes the expiry out again.
 */
export async function authenticate(
  db: Queryable,
  token: string | undefined,
  kind: 'desktop' | 'admin',
  now = new Date(),
): Promise<User | null> {
  if (!token) return null
  const { rows } = await db.query<UserRow & { session_id: string }>(
    `SELECT s.id AS session_id, ${USER_COLUMNS}
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.kind = $2 AND s.revoked_at IS NULL AND s.expires_at > $3 AND NOT u.blocked`,
    [hashToken(token), kind, now],
  )
  const row = rows[0]
  if (!row) return null
  if (kind === 'desktop') {
    await db.query(
      `UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1;`,
      [row.session_id, now, new Date(now.getTime() + DESKTOP_SESSION_TTL_MS)],
    )
  } else {
    await db.query('UPDATE sessions SET last_used_at = $2 WHERE id = $1', [row.session_id, now])
  }
  await db.query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [row.id, now])
  return toUser(row)
}

export async function revokeSession(db: Queryable, token: string): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    hashToken(token),
  ])
  return (rowCount ?? 0) > 0
}

export async function revokeUserSessions(db: Queryable, userId: number): Promise<number> {
  const { rowCount } = await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
  return rowCount ?? 0
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.trim().match(/^Bearer\s+(\S+)$/i)
  return match?.[1]
}
