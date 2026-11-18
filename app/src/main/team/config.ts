/**
 * Yogurt Team build-time settings. The team server's address comes from YOGURT_TEAM_SERVER: at build time through
 * electron-vite's MAIN_VITE_ env (MAIN_VITE_YOGURT_TEAM_SERVER), or at run time from the environment; the Team
 * section of Settings can change it per install.
 */
const built = (() => {
  try { return (import.meta as { env?: Record<string, string | undefined> }).env?.MAIN_VITE_YOGURT_TEAM_SERVER } catch { return undefined }
})()

export const DEFAULT_GRACE_MINUTES = 10

/** The server this build points at; empty when none was given */
export function defaultServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeServerUrl(env.YOGURT_TEAM_SERVER || built || '') ?? ''
}

/** An http(s) origin plus optional path, without a trailing slash; undefined when it is not one */
export function normalizeServerUrl(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    if (u.username || u.password || u.search || u.hash) return undefined
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
  } catch { return undefined }
}
