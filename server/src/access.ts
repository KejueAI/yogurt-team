export interface AccessPolicy {
  allowedDomains: string[]
  allowlist: string[]
  adminEmails: string[]
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: 'unverified' | 'blocked' | 'domain' }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : normalizeEmail(email.slice(at + 1))
}

/** Parses a free-form admin list ("a.com, b.com\nc.com") into unique, lower-case entries. */
export function parseList(input: string, kind: 'domain' | 'email'): string[] {
  const items = input
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .map((s) => (kind === 'domain' ? s.replace(/^@/, '') : s))
    .filter(Boolean)
    .filter((s) => (kind === 'domain' ? /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)))
  return [...new Set(items)]
}

/**
 * Who may sign in: a verified Google email that is not blocked, and whose domain is allowed,
 * or which is on the allowlist, an ADMIN_EMAILS bootstrap admin, or an admin added on the admin page.
 */
export function checkAccess(
  input: { email: string; emailVerified: boolean; blocked?: boolean; isAdmin?: boolean },
  policy: AccessPolicy,
): AccessDecision {
  if (!input.emailVerified) return { allowed: false, reason: 'unverified' }
  if (input.blocked) return { allowed: false, reason: 'blocked' }
  const email = normalizeEmail(input.email)
  if (input.isAdmin) return { allowed: true }
  if (policy.adminEmails.map(normalizeEmail).includes(email)) return { allowed: true }
  if (policy.allowlist.map(normalizeEmail).includes(email)) return { allowed: true }
  const domain = emailDomain(email)
  if (domain && policy.allowedDomains.map((d) => d.toLowerCase().replace(/^@/, '')).includes(domain)) return { allowed: true }
  return { allowed: false, reason: 'domain' }
}

export function isBootstrapAdmin(email: string, adminEmails: string[]): boolean {
  return adminEmails.map(normalizeEmail).includes(normalizeEmail(email))
}

/** The loopback port the desktop app listens on. Unprivileged ports only. */
export function parseLoopbackPort(value: string | undefined): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1024 && port <= 65535 ? port : null
}

/** The app's opaque state, echoed back verbatim. Restricted to URL-safe characters. */
export function isValidAppState(value: string | undefined): value is string {
  return !!value && value.length <= 512 && /^[A-Za-z0-9._~-]+$/.test(value)
}
