import { describe, expect, it } from 'vitest'
import { decrypt, deriveKeys, encrypt, hashToken, hmac, randomToken, safeEqual } from '../src/crypto.js'

const SECRET = 'a'.repeat(32)

describe('crypto', () => {
  it('derives distinct 32-byte keys deterministically', () => {
    const a = deriveKeys(SECRET)
    const b = deriveKeys(SECRET)
    expect(a.encryption.length).toBe(32)
    expect(a.signing.length).toBe(32)
    expect(a.encryption.equals(b.encryption)).toBe(true)
    expect(a.encryption.equals(a.signing)).toBe(false)
    expect(deriveKeys('b'.repeat(32)).encryption.equals(a.encryption)).toBe(false)
  })

  it('round-trips AES-256-GCM with a random IV', () => {
    const { encryption } = deriveKeys(SECRET)
    const c1 = encrypt('1//refresh-token', encryption)
    const c2 = encrypt('1//refresh-token', encryption)
    expect(c1).toMatch(/^v1:/)
    expect(c1).not.toBe(c2)
    expect(c1).not.toContain('refresh')
    expect(decrypt(c1, encryption)).toBe('1//refresh-token')
    expect(decrypt(encrypt('', encryption), encryption)).toBe('')
  })

  it('rejects tampered ciphertext and the wrong key', () => {
    const { encryption } = deriveKeys(SECRET)
    const c = encrypt('secret', encryption)
    const body = Buffer.from(c.slice(3), 'base64url')
    body[body.length - 1] = body[body.length - 1]! ^ 1
    expect(() => decrypt(`v1:${body.toString('base64url')}`, encryption)).toThrow()
    expect(() => decrypt(c, deriveKeys('z'.repeat(40)).encryption)).toThrow()
    expect(() => decrypt('garbage', encryption)).toThrow()
  })

  it('makes unguessable prefixed tokens and stable hashes', () => {
    const t1 = randomToken('ytd_')
    const t2 = randomToken('ytd_')
    expect(t1.startsWith('ytd_')).toBe(true)
    expect(t1.length).toBeGreaterThan(40)
    expect(t1).not.toBe(t2)
    expect(hashToken(t1)).toBe(hashToken(t1))
    expect(hashToken(t1)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(t1)).not.toBe(hashToken(t2))
  })

  it('signs and compares in constant time', () => {
    const { signing } = deriveKeys(SECRET)
    expect(hmac(signing, 'x')).toBe(hmac(signing, 'x'))
    expect(hmac(signing, 'x')).not.toBe(hmac(signing, 'y'))
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
