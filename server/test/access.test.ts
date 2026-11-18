import { describe, expect, it } from 'vitest'
import { checkAccess, emailDomain, isBootstrapAdmin, isValidAppState, normalizeEmail, parseList, parseLoopbackPort } from '../src/access.js'
import { bearerToken } from '../src/auth.js'
import { loadConfig, splitList, googleConfigured } from '../src/config.js'

const policy = { allowedDomains: ['kejue.co'], allowlist: ['guest@gmail.com'], adminEmails: ['youssef@kejue.co'] }

describe('access checks', () => {
  it('allows verified members of allowed domains', () => {
    expect(checkAccess({ email: 'ana@kejue.co', emailVerified: true }, policy)).toEqual({ allowed: true })
    expect(checkAccess({ email: 'Ana@KEJUE.co', emailVerified: true }, policy)).toEqual({ allowed: true })
  })

  it('rejects other domains, including look-alike subdomains and suffixes', () => {
    for (const email of ['x@gmail.com', 'x@evil-kejue.co', 'x@kejue.co.evil.com', 'x@sub.kejue.co']) {
      expect(checkAccess({ email, emailVerified: true }, policy)).toEqual({ allowed: false, reason: 'domain' })
    }
  })

  it('allows the allowlist and bootstrap admins regardless of domain', () => {
    expect(checkAccess({ email: 'GUEST@gmail.com', emailVerified: true }, policy).allowed).toBe(true)
    expect(checkAccess({ email: 'youssef@kejue.co', emailVerified: true }, { ...policy, allowedDomains: [] }).allowed).toBe(true)
  })

  it('rejects unverified and blocked accounts', () => {
    expect(checkAccess({ email: 'ana@kejue.co', emailVerified: false }, policy)).toEqual({ allowed: false, reason: 'unverified' })
    expect(checkAccess({ email: 'ana@kejue.co', emailVerified: true, blocked: true }, policy)).toEqual({ allowed: false, reason: 'blocked' })
  })

  it('normalizes emails, domains and lists', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co')
    expect(emailDomain('a@B.co')).toBe('b.co')
    expect(parseList('kejue.co\n@Example.com, bad domain\n\nkejue.co', 'domain')).toEqual(['kejue.co', 'example.com'])
    expect(parseList('a@b.co; not-an-email\nA@B.co', 'email')).toEqual(['a@b.co'])
    expect(isBootstrapAdmin('YOUSSEF@kejue.co', policy.adminEmails)).toBe(true)
    expect(isBootstrapAdmin('ana@kejue.co', policy.adminEmails)).toBe(false)
  })

  it('validates loopback ports and app state', () => {
    expect(parseLoopbackPort('53682')).toBe(53682)
    for (const bad of [undefined, '', '80', '70000', '12ab', '1e4', '-1']) expect(parseLoopbackPort(bad)).toBeNull()
    expect(isValidAppState('abc-DEF_123.~')).toBe(true)
    expect(isValidAppState('')).toBe(false)
    expect(isValidAppState('a b')).toBe(false)
    expect(isValidAppState('<script>')).toBe(false)
    expect(isValidAppState('x'.repeat(513))).toBe(false)
  })

  it('parses bearer tokens', () => {
    expect(bearerToken('Bearer ytd_abc')).toBe('ytd_abc')
    expect(bearerToken('bearer   ytd_abc ')).toBe('ytd_abc')
    expect(bearerToken('Basic abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    PUBLIC_URL: 'https://team.example.com/',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    SECRET_KEY: 's'.repeat(32),
    ADMIN_EMAILS: 'Youssef@kejue.co, other@kejue.co',
    ALLOWED_DOMAINS: 'kejue.co',
  }
  it('loads and normalizes', () => {
    const c = loadConfig(env)
    expect(c.port).toBe(8080)
    expect(c.publicUrl).toBe('https://team.example.com')
    expect(c.adminEmails).toEqual(['youssef@kejue.co', 'other@kejue.co'])
    expect(c.allowedDomains).toEqual(['kejue.co'])
    expect(loadConfig({ ...env, PORT: '3000' }).port).toBe(3000)
  })
  it('rejects missing or weak settings', () => {
    expect(() => loadConfig({ ...env, SECRET_KEY: 'short' })).toThrow(/SECRET_KEY/)
    expect(() => loadConfig({ ...env, DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'team.example.com' })).toThrow(/PUBLIC_URL/)
  })
  it('boots without Google credentials', () => {
    const c = loadConfig({ ...env, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: undefined })
    expect(googleConfigured(c)).toBe(false)
    expect(googleConfigured(loadConfig(env))).toBe(true)
  })
  it('splits lists', () => {
    expect(splitList(' a, b ;c\n')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toEqual([])
  })
})
