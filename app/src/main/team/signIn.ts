/**
 * Sign-in through the system browser (server/API.md): a one-off listener on 127.0.0.1 and a random port, the
 * browser sent to the server's /auth/desktop/start, the server's redirect back to /callback with a one-time code
 * and our state, then the code exchanged for a session token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { teamApi, type Fetch } from './api'
import type { TeamUser } from './types'

export type SignInDeps = {
  serverUrl: string
  /** opens the system browser (shell.openExternal) */
  openBrowser: (url: string) => Promise<void> | void
  fetch?: Fetch
  /** give up after this long without the browser coming back */
  timeoutMs?: number
  signal?: AbortSignal
}

export class SignInError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'denied' | 'state' | 'exchange', message: string) { super(message); this.name = 'SignInError' }
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#222}
@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#eee}}main{text-align:center;max-width:28rem}</style></head>
<body><main><h1 style="font-size:20px">${title}</h1><p>${body}</p></main></body></html>`

const sameState = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Resolves with the session token and the signed-in person; rejects with SignInError */
export async function signInWithBrowser(d: SignInDeps): Promise<{ token: string; user: TeamUser }> {
  const state = randomBytes(24).toString('base64url')
  const server = createServer()
  let settle!: { ok: (code: string) => void; fail: (e: Error) => void }
  const code = new Promise<string>((ok, fail) => { settle = { ok, fail } })
  code.catch(() => {}) // awaited below; this only keeps an early failure from counting as unhandled
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end(); return }
    const back = url.searchParams.get('state') ?? ''
    if (!sameState(back, state)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in didn’t match', 'Start signing in again from Yogurt.'))
      return
    }
    const err = url.searchParams.get('error'), got = url.searchParams.get('code')
    if (err || !got) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Couldn’t sign in', 'You can close this tab and try again in Yogurt.'))
      settle.fail(new SignInError('denied', err === 'forbidden' ? 'That account isn’t on this team.' : `Sign-in didn’t finish (${err ?? 'no code'}).`))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Signed in to Yogurt Team', 'You can close this tab and go back to Yogurt.'))
    settle.ok(got)
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => ok()) })
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => settle.fail(new SignInError('timeout', 'Sign-in timed out. Try again.')), d.timeoutMs ?? 5 * 60_000)
  const onAbort = () => settle.fail(new SignInError('cancelled', 'Sign-in was cancelled.'))
  d.signal?.addEventListener('abort', onAbort)
  try {
    if (d.signal?.aborted) throw new SignInError('cancelled', 'Sign-in was cancelled.')
    await d.openBrowser(`${d.serverUrl}/auth/desktop/start?port=${port}&state=${encodeURIComponent(state)}`)
    const got = await code
    try {
      return await teamApi(d.serverUrl, undefined, d.fetch).exchange(got)
    } catch (e) {
      throw new SignInError('exchange', e instanceof Error ? e.message : String(e))
    }
  } finally {
    clearTimeout(timer)
    d.signal?.removeEventListener('abort', onAbort)
    server.closeAllConnections?.()
    server.close()
  }
}
