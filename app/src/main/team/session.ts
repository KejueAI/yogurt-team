/**
 * The signed-in Yogurt Team session: which server, the session token (sealed in team.json) and /api/me.
 *
 * Other main-process code (the OpenRouter summaries) uses `teamSession`:
 *   teamSession.serverUrl()  the team server, no trailing slash; undefined when none is set
 *   teamSession.token()      the bearer token; undefined when signed out
 *   teamSession.me()         /api/me (user + team config), cached for a minute; undefined when signed out.
 *                            When the server can't be reached it answers the last one it had.
 *   teamSession.summariesEnabled() team.summariesEnabled from /api/me; false when signed out or unknown
 *   teamSession.signedIn()   whether there is a token
 *   teamSession.unauthorized() call when the server answered 401: forgets the token (the person signs in again)
 *   teamSession.onChange(cb) sign-in, sign-out, server or team changes; returns an unsubscribe
 * Before hookTeam has run (and in tests that don't bind one) it acts signed out.
 */
import { teamApi, TeamApiError, type Fetch } from './api'
import { defaultServerUrl, normalizeServerUrl } from './config'
import { signInWithBrowser, SignInError } from './signIn'
import type { TeamFile, Sealer } from './teamFile'
import type { SignInResult, TeamMe, TeamState } from './types'

const ME_TTL_MS = 60_000

export type SessionDeps = {
  file: TeamFile
  sealer: Sealer
  fetch?: Fetch
  now?: () => number
  defaultServer?: string
  openBrowser?: (url: string) => Promise<void> | void
}

export class TeamSession {
  private listeners = new Set<() => void>()
  private meAt = 0
  private meError: string | null = null
  private meLoading: Promise<TeamMe | undefined> | null = null
  private signing: AbortController | null = null
  private readonly now: () => number
  private readonly defaultServer: string

  constructor(private d: SessionDeps) {
    this.now = d.now ?? Date.now
    this.defaultServer = d.defaultServer ?? defaultServerUrl()
  }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private changed() { for (const cb of [...this.listeners]) { try { cb() } catch (e) { console.error('[team] listener', e) } } }

  serverUrl(): string | undefined { return this.d.file.get().serverUrl || this.defaultServer || undefined }

  /** Empty goes back to the built-in server. A different server signs out here: the token belongs to the old one. */
  setServerUrl(raw: string): void {
    const next = raw.trim() ? normalizeServerUrl(raw) : ''
    if (next === undefined) throw new Error('Enter a web address that starts with https://')
    if ((next || this.defaultServer) === this.serverUrl()) {
      if ((this.d.file.get().serverUrl ?? '') !== next) this.d.file.update(f => { if (next) f.serverUrl = next; else delete f.serverUrl })
      return
    }
    this.d.file.update(f => { if (next) f.serverUrl = next; else delete f.serverUrl; delete f.token; delete f.me })
    this.meAt = 0; this.meError = null
    this.changed()
  }

  signedIn(): boolean { return !!this.d.file.get().token }

  async token(): Promise<string | undefined> {
    const sealed = this.d.file.get().token
    if (!sealed) return undefined
    try { return this.d.sealer.open(sealed) } catch (e) {
      console.error('[team] the saved sign-in could not be read; signing out', e)
      this.forget()
      return undefined
    }
  }

  /** The cached /api/me without asking the server */
  cachedMe(): TeamMe | undefined { return this.signedIn() ? this.d.file.get().me : undefined }

  async me(o: { fresh?: boolean } = {}): Promise<TeamMe | undefined> {
    if (!this.signedIn()) return undefined
    const cached = this.d.file.get().me
    if (!o.fresh && cached && this.now() - this.meAt < ME_TTL_MS) return cached
    this.meLoading ??= this.loadMe().finally(() => { this.meLoading = null })
    return this.meLoading
  }

  private async loadMe(): Promise<TeamMe | undefined> {
    const server = this.serverUrl(), token = await this.token()
    if (!server || !token) return undefined
    try {
      const me = await teamApi(server, token, this.d.fetch).me()
      const before = JSON.stringify(this.d.file.get().me)
      if (!this.signedIn()) return undefined // signed out meanwhile
      this.d.file.update(f => { f.me = me })
      this.meAt = this.now()
      const hadError = this.meError != null
      this.meError = null
      if (hadError || before !== JSON.stringify(me)) this.changed()
      return me
    } catch (e) {
      if (e instanceof TeamApiError && e.status === 401) { this.forget(); return undefined }
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== this.meError) { this.meError = msg; this.changed() }
      return this.d.file.get().me
    }
  }

  /** The server said the token is no good: sign out here */
  unauthorized(): void { this.forget() }

  private forget() {
    if (!this.d.file.get().token && !this.d.file.get().me) return
    this.d.file.update(f => { delete f.token; delete f.me })
    this.meAt = 0; this.meError = null
    this.changed()
  }

  signingIn(): boolean { return this.signing != null }

  async signIn(): Promise<SignInResult> {
    const server = this.serverUrl()
    if (!server) return { ok: false, error: 'Set the team server address first.' }
    if (!this.d.openBrowser) return { ok: false, error: 'Sign-in is not available here.' }
    this.signing?.abort()
    const ctl = new AbortController()
    this.signing = ctl
    this.changed()
    try {
      const { token, user } = await signInWithBrowser({ serverUrl: server, openBrowser: this.d.openBrowser, fetch: this.d.fetch, signal: ctl.signal })
      if (ctl.signal.aborted) return { ok: false, error: 'Sign-in was cancelled.' }
      const prev = this.d.file.get().me
      this.d.file.update(f => {
        f.token = this.d.sealer.seal(token)
        // until /api/me answers: the person, and the team as it was if it is the same person
        f.me = { user, team: prev?.user.email === user.email && prev.team ? prev.team : { name: '', driveConnected: false, summariesEnabled: false, uploadAudio: true, uploadTranscript: true, uploadNotes: true, graceMinutes: 10 } }
      })
      this.meAt = 0; this.meError = null
      this.changed()
      void this.me({ fresh: true })
      return { ok: true, user }
    } catch (e) {
      return { ok: false, error: e instanceof SignInError || e instanceof Error ? e.message : String(e) }
    } finally {
      if (this.signing === ctl) { this.signing = null; this.changed() }
    }
  }

  cancelSignIn(): void { this.signing?.abort() }

  async signOut(): Promise<void> {
    const server = this.serverUrl(), token = await this.token()
    this.forget()
    if (server && token) await teamApi(server, token, this.d.fetch).signOut().catch(e => console.warn('[team] sign-out on the server failed', e))
  }

  /** team.transcriptionEnabled from /api/me; false when signed out, unknown, or an older server */
  async transcriptionEnabled(): Promise<boolean> {
    return (await this.me().catch(() => undefined))?.team.transcriptionEnabled === true
  }
  /** team.summariesEnabled from /api/me (cached for a minute); false when signed out or unknown */
  async summariesEnabled(): Promise<boolean> {
    return (await this.me().catch(() => undefined))?.team.summariesEnabled === true
  }

  state(): TeamState {
    const me = this.cachedMe()
    return {
      serverUrl: this.serverUrl() ?? '', defaultServerUrl: this.defaultServer, signedIn: this.signedIn(), signingIn: this.signingIn(),
      user: me?.user ?? null, team: me?.team.name ? me.team : null, meError: this.signedIn() ? this.meError : null,
    }
  }
}

/** What the OpenRouter summaries need; both the TeamSession class and the teamSession facade satisfy it */
export type TeamSessionLike = {
  serverUrl(): string | undefined
  token(): Promise<string | undefined>
  summariesEnabled(): Promise<boolean>
  onChange?(cb: () => void): () => void
}

let bound: TeamSession | null = null
let unbind = () => {}
const facadeListeners = new Set<() => void>()
/** hookTeam binds the app's session here; listeners added before that are kept */
export function bindTeamSession(s: TeamSession | null): void {
  unbind()
  bound = s
  unbind = s ? s.onChange(() => { for (const cb of [...facadeListeners]) { try { cb() } catch (e) { console.error('[team] listener', e) } } }) : () => {}
}

export const teamSession = {
  serverUrl: (): string | undefined => bound?.serverUrl(),
  token: async (): Promise<string | undefined> => bound?.token(),
  me: async (): Promise<TeamMe | undefined> => bound?.me(),
  summariesEnabled: async (): Promise<boolean> => (await bound?.summariesEnabled()) ?? false,
  signedIn: (): boolean => bound?.signedIn() ?? false,
  unauthorized: (): void => bound?.unauthorized(),
  onChange: (cb: () => void): (() => void) => { facadeListeners.add(cb); return () => { facadeListeners.delete(cb) } },
}
