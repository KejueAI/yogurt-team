import { Hono, type Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { checkAccess, isValidAppState, parseLoopbackPort } from '../access.js'
import {
  ADMIN_SESSION_TTL_MS,
  authenticate,
  consumeOAuthState,
  createLoginCode,
  createOAuthState,
  createSession,
  findUserByEmail,
  revokeSession,
  upsertUser,
  type User,
} from '../auth.js'
import type { Deps } from '../context.js'
import { DRIVE_SCOPE } from '../google.js'
import { messagePage } from '../admin/layout.js'

export const ADMIN_COOKIE = 'yt_admin'
const SIGN_IN_SCOPES = ['openid', 'email', 'profile']

export function loopbackUrl(port: number, params: Record<string, string>): string {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(params)}`
}

export async function adminFromCookie(deps: Deps, c: Context): Promise<User | null> {
  const token = await getSignedCookie(c, deps.keys.signing.toString('base64url'), ADMIN_COOKIE)
  if (!token) return null
  const user = await authenticate(deps.db, token, 'admin')
  return user?.isAdmin ? user : null
}

export function authRoutes(deps: Deps): Hono {
  const app = new Hono()
  const { config, db, oauth } = deps
  const signInRedirect = `${config.publicUrl}/auth/google/callback`
  const driveRedirect = `${config.publicUrl}/auth/drive/callback`
  const cookieSecret = deps.keys.signing.toString('base64url')
  const secureCookie = config.publicUrl.startsWith('https://')

  // Desktop loopback sign-in: the app opens this in the browser.
  app.get('/auth/desktop/start', async (c) => {
    const port = parseLoopbackPort(c.req.query('port'))
    const appState = c.req.query('state')
    if (port === null || !isValidAppState(appState)) {
      return c.html(messagePage('Sign-in link is invalid', 'Start signing in again from the Yogurt app.'), 400)
    }
    const state = await createOAuthState(db, 'desktop', { port, appState })
    return c.redirect(oauth.authUrl({ redirectUri: signInRedirect, state, scopes: SIGN_IN_SCOPES }))
  })

  app.get('/admin/login', async (c) => {
    const state = await createOAuthState(db, 'admin', {})
    return c.redirect(oauth.authUrl({ redirectUri: signInRedirect, state, scopes: SIGN_IN_SCOPES }))
  })

  app.post('/admin/logout', async (c) => {
    const token = await getSignedCookie(c, cookieSecret, ADMIN_COOKIE)
    if (token) await revokeSession(db, token)
    deleteCookie(c, ADMIN_COOKIE, { path: '/' })
    return c.redirect('/admin/signed-out', 303)
  })

  app.get('/admin/signed-out', (c) =>
    c.html(messagePage('Signed out', '<a href="/admin/login">Sign in again</a>', { raw: true })),
  )

  // Google sign-in callback for both the desktop app and the admin pages.
  app.get('/auth/google/callback', async (c) => {
    const stateParam = c.req.query('state')
    let kind: 'desktop' | 'admin' = 'desktop'
    let data = await consumeOAuthState(db, stateParam, 'desktop')
    if (!data) {
      data = await consumeOAuthState(db, stateParam, 'admin')
      kind = 'admin'
    }
    if (!data) return c.html(messagePage('Sign-in expired', 'That sign-in link expired or was already used. Start again.'), 400)

    const port = kind === 'desktop' ? (data.port as number) : 0
    const appState = kind === 'desktop' ? String(data.appState) : ''
    const fail = (code: string, title: string, message: string, status: 400 | 403 | 502 = 403) =>
      kind === 'desktop'
        ? c.redirect(loopbackUrl(port, { error: code, state: appState }))
        : c.html(messagePage(title, message), status)

    if (c.req.query('error')) return fail('cancelled', 'Sign-in cancelled', 'Google sign-in was cancelled.', 400)
    const code = c.req.query('code')
    if (!code) return fail('failed', 'Sign-in failed', 'Google did not return a code.', 400)

    let googleUser
    try {
      const tokens = await oauth.exchangeCode(code, signInRedirect)
      googleUser = await oauth.userInfo(tokens.access_token)
    } catch (err) {
      deps.log('google sign-in failed', { error: String(err) })
      return fail('failed', 'Sign-in failed', 'Google sign-in failed. Try again.', 502)
    }

    const settings = await deps.settings.get(db)
    const existing = await findUserByEmail(db, googleUser.email)
    const decision = checkAccess(
      { email: googleUser.email, emailVerified: googleUser.emailVerified, blocked: existing?.blocked, isAdmin: existing?.isAdmin },
      { allowedDomains: settings.allowedDomains, allowlist: settings.allowlist, adminEmails: config.adminEmails },
    )
    if (!decision.allowed) {
      return fail(
        'forbidden',
        'Not on this team',
        `${googleUser.email} isn't allowed on ${settings.teamName}. Ask an admin to add you.`,
      )
    }
    const user = await upsertUser(db, googleUser, config.adminEmails)

    if (kind === 'desktop') {
      const loginCode = await createLoginCode(db, user.id)
      return c.redirect(loopbackUrl(port, { code: loginCode, state: appState }))
    }
    if (!user.isAdmin) {
      return c.html(messagePage('Admins only', `${user.email} is signed in but isn't an admin of ${settings.teamName}.`), 403)
    }
    const token = await createSession(db, user.id, 'admin')
    await setSignedCookie(c, ADMIN_COOKIE, token, cookieSecret, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'Lax',
      maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
    })
    return c.redirect('/admin')
  })

  // Admin Drive connect: offline access to the full Drive scope, refresh token stored encrypted.
  app.post('/auth/drive/start', async (c) => {
    const admin = await adminFromCookie(deps, c)
    if (!admin) return c.redirect('/admin/login', 303)
    const state = await createOAuthState(db, 'drive', { userId: admin.id })
    return c.redirect(
      oauth.authUrl({
        redirectUri: driveRedirect,
        state,
        scopes: ['openid', 'email', DRIVE_SCOPE],
        offline: true,
        consent: true,
        loginHint: admin.email,
      }),
      303,
    )
  })

  app.get('/auth/drive/callback', async (c) => {
    const admin = await adminFromCookie(deps, c)
    if (!admin) return c.redirect('/admin/login')
    const data = await consumeOAuthState(db, c.req.query('state'), 'drive')
    if (!data || data.userId !== admin.id) return c.html(messagePage('Drive connect expired', 'Start connecting Drive again.'), 400)
    if (c.req.query('error')) return c.redirect('/admin/drive?notice=cancelled')
    const code = c.req.query('code')
    if (!code) return c.html(messagePage('Drive connect failed', 'Google did not return a code.'), 400)
    try {
      const tokens = await oauth.exchangeCode(code, driveRedirect)
      if (!tokens.refresh_token) {
        return c.html(messagePage('Drive connect failed', 'Google did not return a refresh token. Remove the app from your Google account’s third-party access and try again.'), 502)
      }
      if (!tokens.scope?.split(' ').includes(DRIVE_SCOPE)) {
        return c.html(messagePage('Drive access not granted', 'Tick the Google Drive permission on the consent screen and try again.'), 400)
      }
      const who = await oauth.userInfo(tokens.access_token)
      await deps.settings.setSecret(db, 'driveRefreshToken', tokens.refresh_token)
      await deps.settings.update(db, { driveAccountEmail: who.email })
      deps.log('drive connected', { by: admin.email, account: who.email })
    } catch (err) {
      deps.log('drive connect failed', { error: String(err) })
      return c.html(messagePage('Drive connect failed', 'Google rejected the connection. Try again.'), 502)
    }
    return c.redirect('/admin/drive?notice=connected')
  })

  return app
}
