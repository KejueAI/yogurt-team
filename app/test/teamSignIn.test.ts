import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { signInWithBrowser, SignInError } from '../src/main/team/signIn'
import { TeamSession, bindTeamSession, teamSession } from '../src/main/team/session'
import { TeamFile } from '../src/main/team/teamFile'
import { normalizeServerUrl } from '../src/main/team/config'

const roots: string[] = []
afterEach(() => { bindTeamSession(null); roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })

const USER = { email: 'ann@example.com', name: 'Ann', isAdmin: true }
const TEAM = { name: 'Acme', driveConnected: true, summariesEnabled: true, uploadAudio: true, uploadTranscript: true, uploadNotes: true, graceMinutes: 5 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** what the browser does: follow the server's redirect back to the loopback listener */
const visit = (url: string) => new Promise<{ status: number; body: string }>((ok, fail) => {
  request(url, res => { let body = ''; res.on('data', c => { body += c }); res.on('end', () => ok({ status: res.statusCode ?? 0, body })) }).on('error', fail).end()
})
const started = (open: ReturnType<typeof vi.fn>) => vi.waitFor(() => {
  expect(open).toHaveBeenCalled()
  const u = new URL(open.mock.calls[0][0])
  return { port: u.searchParams.get('port')!, state: u.searchParams.get('state')!, url: u }
})

describe('team sign-in through the browser', () => {
  it('opens /auth/desktop/start with a loopback port and state, then exchanges the code', async () => {
    const open = vi.fn()
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { token: 'tok-1', user: USER }))
    const done = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: open, fetch: fetch as never })
    const { port, state, url } = await started(open)
    expect(url.origin + url.pathname).toBe('https://team.example/auth/desktop/start')
    expect(Number(port)).toBeGreaterThan(0)
    expect(state.length).toBeGreaterThanOrEqual(16)
    const page = await visit(`http://127.0.0.1:${port}/callback?code=c-123&state=${encodeURIComponent(state)}`)
    expect(page.status).toBe(200)
    expect(await done).toEqual({ token: 'tok-1', user: USER })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [u, init] = fetch.mock.calls[0]
    expect(String(u)).toBe('https://team.example/api/desktop/exchange')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'c-123' })
  })

  it('ignores a callback with the wrong state and keeps waiting', async () => {
    const open = vi.fn()
    const fetch = vi.fn(async () => json(200, { token: 'tok-2', user: USER }))
    const done = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: open, fetch: fetch as never })
    const { port, state } = await started(open)
    expect((await visit(`http://127.0.0.1:${port}/callback?code=evil&state=nope`)).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    await visit(`http://127.0.0.1:${port}/callback?code=good&state=${encodeURIComponent(state)}`)
    expect((await done).token).toBe('tok-2')
  })

  it('reports a refusal from the server', async () => {
    const open = vi.fn()
    const done = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: open, fetch: vi.fn() as never })
    const { port, state } = await started(open)
    const failed = done.catch(e => e)
    await visit(`http://127.0.0.1:${port}/callback?error=forbidden&state=${encodeURIComponent(state)}`)
    expect(await failed).toMatchObject({ code: 'denied' })
    await expect(done).rejects.toMatchObject({ code: 'denied', message: 'That account isn’t on this team.' })
  })

  it('reports a failed exchange', async () => {
    const open = vi.fn()
    const fetch = vi.fn(async () => json(400, { error: 'invalid_code', message: 'Code expired' }))
    const done = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: open, fetch: fetch as never })
    const { port, state } = await started(open)
    const failed = done.catch(e => e)
    await visit(`http://127.0.0.1:${port}/callback?code=old&state=${encodeURIComponent(state)}`)
    await failed
    await expect(done).rejects.toBeInstanceOf(SignInError)
    await expect(done).rejects.toMatchObject({ code: 'exchange' })
  })

  it('can be cancelled and times out', async () => {
    const ac = new AbortController()
    const a = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: vi.fn(), fetch: vi.fn() as never, signal: ac.signal })
    ac.abort()
    await expect(a).rejects.toMatchObject({ code: 'cancelled' })
    const b = signInWithBrowser({ serverUrl: 'https://team.example', openBrowser: vi.fn(), fetch: vi.fn() as never, timeoutMs: 20 })
    await expect(b).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('team session', () => {
  const sealer = { seal: (s: string) => `sealed:${s}`, open: (s: string) => s.replace(/^sealed:/, '') }
  function setup(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-team-session-')); roots.push(root)
    const path = join(root, 'team.json')
    const open = vi.fn()
    const fetch = vi.fn(fetchImpl ?? (async (url: string) => {
      const p = new URL(url).pathname
      if (p === '/api/desktop/exchange') return json(200, { token: 'tok', user: USER })
      if (p === '/api/me') return json(200, { user: USER, team: TEAM })
      return json(200, { ok: true })
    }))
    let now = 0
    const s = new TeamSession({ file: new TeamFile(path), sealer, fetch: fetch as never, defaultServer: 'https://default.example', openBrowser: open, now: () => now })
    return { s, path, open, fetch, advance: (ms: number) => { now += ms } }
  }
  const signIn = async (t: ReturnType<typeof setup>) => {
    const p = t.s.signIn()
    const { port, state } = await started(t.open)
    await visit(`http://127.0.0.1:${port}/callback?code=c&state=${encodeURIComponent(state)}`)
    return p
  }

  it('signs in, seals the token in team.json and loads /api/me', async () => {
    const t = setup()
    expect(await signIn(t)).toEqual({ ok: true, user: USER })
    const saved = JSON.parse(readFileSync(t.path, 'utf8'))
    expect(saved.token).toBe('sealed:tok')
    expect(await t.s.token()).toBe('tok')
    expect(await t.s.me()).toEqual({ user: USER, team: TEAM })
    expect(t.s.state()).toMatchObject({ signedIn: true, serverUrl: 'https://default.example', user: USER, team: TEAM })
  })

  it('exposes the session to other main-process code through teamSession', async () => {
    const t = setup()
    expect(teamSession.serverUrl()).toBeUndefined()
    expect(await teamSession.token()).toBeUndefined()
    const changed = vi.fn()
    const off = teamSession.onChange(changed)
    bindTeamSession(t.s)
    await signIn(t)
    expect(changed).toHaveBeenCalled()
    expect(teamSession.serverUrl()).toBe('https://default.example')
    expect(await teamSession.token()).toBe('tok')
    expect(await teamSession.summariesEnabled()).toBe(true)
    expect((await teamSession.me())?.team.graceMinutes).toBe(5)
    await t.s.signOut()
    expect(await teamSession.token()).toBeUndefined()
    expect(await teamSession.summariesEnabled()).toBe(false)
    off()
  })

  it('caches /api/me for a minute', async () => {
    const t = setup(); await signIn(t)
    const meCalls = () => t.fetch.mock.calls.filter(c => String(c[0]).endsWith('/api/me')).length
    const n = meCalls()
    await t.s.me(); await t.s.me()
    expect(meCalls()).toBe(n)
    t.advance(61_000); await t.s.me()
    expect(meCalls()).toBe(n + 1)
  })

  it('a 401 from /api/me signs out', async () => {
    const t = setup(); await signIn(t)
    t.fetch.mockImplementation(async () => json(401, { error: 'unauthorized', message: 'expired' }))
    t.advance(61_000)
    expect(await t.s.me()).toBeUndefined()
    expect(t.s.signedIn()).toBe(false)
  })

  it('offline keeps the last team config', async () => {
    const t = setup(); await signIn(t)
    t.fetch.mockImplementation(async () => { throw new TypeError('fetch failed') })
    t.advance(61_000)
    expect(await t.s.me()).toEqual({ user: USER, team: TEAM })
    expect(t.s.state().meError).toBeTruthy()
  })

  it('signing out forgets the token and tells the server', async () => {
    const t = setup(); await signIn(t)
    await t.s.signOut()
    expect(JSON.parse(readFileSync(t.path, 'utf8')).token).toBeUndefined()
    expect(t.fetch.mock.calls.some(c => String(c[0]).endsWith('/api/desktop/signout') && (c[1] as RequestInit).headers && JSON.stringify((c[1] as RequestInit).headers).includes('Bearer tok'))).toBe(true)
  })

  it('changing the server signs out; normalizes addresses', async () => {
    const t = setup(); await signIn(t)
    t.s.setServerUrl('https://other.example/')
    expect(t.s.serverUrl()).toBe('https://other.example')
    expect(t.s.signedIn()).toBe(false)
    expect(() => t.s.setServerUrl('ftp://x')).toThrow()
    t.s.setServerUrl('')
    expect(t.s.serverUrl()).toBe('https://default.example')
    expect(normalizeServerUrl('team.example.com/')).toBeUndefined()
    expect(normalizeServerUrl('http://localhost:8787/')).toBe('http://localhost:8787')
  })
})
