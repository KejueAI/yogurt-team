import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/** Keys derived from SECRET_KEY, one per purpose, so no raw secret is reused across uses. */
export interface Keys {
  encryption: Buffer
  signing: Buffer
}

export function deriveKeys(secretKey: string): Keys {
  const ikm = Buffer.from(secretKey, 'utf8')
  const salt = Buffer.from('yogurt-team', 'utf8')
  return {
    encryption: Buffer.from(hkdfSync('sha256', ikm, salt, 'encryption', 32)),
    signing: Buffer.from(hkdfSync('sha256', ikm, salt, 'signing', 32)),
  }
}

const VERSION = 'v1'

/** AES-256-GCM. Output: `v1:<base64url(iv | tag | ciphertext)>`. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64url')}`
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, body] = payload.split(':', 2)
  if (version !== VERSION || !body) throw new Error('Unsupported ciphertext format')
  const raw = Buffer.from(body, 'base64url')
  if (raw.length < 28) throw new Error('Ciphertext too short')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ct = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** A random, URL-safe secret with a readable prefix. */
export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** Tokens, codes and states are stored only as SHA-256 hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
