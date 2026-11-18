export interface Config {
  port: number
  databaseUrl: string
  publicUrl: string
  googleClientId: string
  googleClientSecret: string
  adminEmails: string[]
  allowedDomains: string[]
  secretKey: string
  openrouterApiKey?: string
  openrouterModel?: string
}

export function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = []
  const req = (name: string): string => {
    const v = env[name]?.trim()
    if (!v) missing.push(name)
    return v ?? ''
  }
  const config: Config = {
    port: Number(env.PORT ?? 8080) || 8080,
    databaseUrl: req('DATABASE_URL'),
    publicUrl: req('PUBLIC_URL').replace(/\/+$/, ''),
    googleClientId: req('GOOGLE_CLIENT_ID'),
    googleClientSecret: req('GOOGLE_CLIENT_SECRET'),
    secretKey: req('SECRET_KEY'),
    adminEmails: splitList(env.ADMIN_EMAILS),
    allowedDomains: splitList(env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, '')),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterModel: env.OPENROUTER_MODEL?.trim() || undefined,
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  if (config.secretKey.length < 32) throw new Error('SECRET_KEY must be at least 32 characters')
  if (!/^https?:\/\//.test(config.publicUrl)) throw new Error('PUBLIC_URL must start with http:// or https://')
  return config
}
