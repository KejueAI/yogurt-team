// End-to-end tests against a real Postgres with an in-memory fake Drive and a fake OpenRouter.
// Runs only when TEST_DATABASE_URL is set (it drops and recreates the public schema), e.g.
//   docker run -d --rm --name ytpg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=yt -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/yt corepack pnpm test
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createLoginCode, upsertUser } from '../src/auth.js'
import type { Config } from '../src/config.js'
import { createDeps, type Deps } from '../src/context.js'
import { createPool, migrate, type Db } from '../src/db.js'
import type { DriveClient, DriveFile } from '../src/google.js'

const url = process.env.TEST_DATABASE_URL

interface FakeFile extends DriveFile {
  appProperties?: Record<string, string>
  html?: string
}

class FakeDrive {
  files = new Map<string, FakeFile>()
  sessions = new Map<string, { name: string; parentId: string; mimeType: string; size: number; appProperties?: Record<string, string> }>()
  private n = 0
  private id(prefix: string) {
    return `${prefix}${++this.n}`
  }
  constructor(rootId: string) {
    this.files.set(rootId, { id: rootId, name: 'Meetings', mimeType: 'application/vnd.google-apps.folder', parents: [] })
  }
  children(parentId: string) {
    return [...this.files.values()].filter((f) => f.parents?.includes(parentId) && !f.trashed)
  }
  async getFile(id: string) {
    return this.files.get(id) ?? null
  }
  async createFolder(name: string, parentId: string, appProperties?: Record<string, string>) {
    const f: FakeFile = { id: this.id('folder'), name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder', appProperties }
    this.files.set(f.id, f)
    return f
  }
  async createDoc(name: string, parentId: string, html: string, appProperties?: Record<string, string>) {
    const f: FakeFile = { id: this.id('doc'), name, parents: [parentId], mimeType: 'application/vnd.google-apps.document', html, appProperties }
    this.files.set(f.id, f)
    return f
  }
  async updateDoc(fileId: string, name: string, html: string, move?: { addParent: string; removeParents: string[] }) {
    const f = this.files.get(fileId)
    if (!f) throw Object.assign(new Error('not found'), { status: 404 })
    f.name = name
    f.html = html
    if (move) f.parents = [move.addParent]
    return f
  }
  async createResumableSession(opts: { name: string; parentId: string; mimeType: string; size: number; appProperties?: Record<string, string> }) {
    const sid = this.id('session')
    this.sessions.set(sid, opts)
    return `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}`
  }
  /** What the desktop app's PUT does: the file appears once the bytes land. */
  put(uploadUrl: string) {
    const sid = new URL(uploadUrl).searchParams.get('upload_id')!
    const s = this.sessions.get(sid)!
    const f: FakeFile = { id: this.id('audio'), name: s.name, parents: [s.parentId], mimeType: s.mimeType, appProperties: s.appProperties }
    this.files.set(f.id, f)
    return f
  }
  async findByAppProperty(parentId: string, key: string, value: string) {
    return this.children(parentId).filter((f) => f.appProperties?.[key] === value).reverse()
  }
  async countChildren(parentId: string) {
    return this.children(parentId).length
  }
  async deleteFile(id: string): Promise<'deleted' | 'trashed' | 'missing'> {
    return this.files.delete(id) ? 'deleted' : 'missing'
  }
}

describe.skipIf(!url)('server against Postgres', () => {
  let db: Db
  let deps: Deps
  let app: ReturnType<typeof createApp>
  const drive = new FakeDrive('root-folder')
  let openrouterCalls: { url: string; body: unknown; auth: string | null }[] = []

  const config: Config = {
    port: 0,
    databaseUrl: url ?? '',
    publicUrl: 'https://team.example.com',
    googleClientId: 'cid',
    googleClientSecret: 'secret',
    adminEmails: ['boss@kejue.co'],
    allowedDomains: ['kejue.co'],
    secretKey: 'x'.repeat(40),
  }

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (u.startsWith('https://openrouter.ai/')) {
      openrouterCalls.push({ url: u, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') })
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        ': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]
      const body = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('unexpected fetch ' + u, { status: 500 })
  }) as typeof fetch

  async function signIn(email: string, name: string): Promise<string> {
    const user = await upsertUser(db, { sub: email, email, emailVerified: true, name }, config.adminEmails)
    const code = await createLoginCode(db, user.id)
    const res = await app.request('/api/desktop/exchange', { method: 'POST', body: JSON.stringify({ code }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string }
    return body.token
  }

  function call(token: string, path: string, method = 'GET', body?: unknown) {
    return app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  const meeting = {
    meetingId: 'local-1',
    calendarEventId: 'evt-1',
    title: 'Launch planning',
    startedAt: '2026-11-18T10:00:00Z',
    endedAt: '2026-11-18T10:45:00Z',
    attendees: ['boss@kejue.co', 'sam@kejue.co'],
    notesMarkdown: '# Notes\n\n- shipped **it**',
    transcriptMarkdown: 'Boss: hi',
    audio: [
      { track: 'mic', fileName: 'mic.m4a', mimeType: 'audio/mp4', size: 1000 },
      { track: 'others', fileName: 'others.m4a', mimeType: 'audio/mp4', size: 2000 },
    ],
  }

  beforeAll(async () => {
    db = createPool(url!)
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await migrate(db, undefined, () => {})
    deps = createDeps(config, db, fakeFetch)
    deps.drive = async () => ((await deps.settings.getSecret(db, 'driveRefreshToken')) ? (drive as unknown as DriveClient) : null)
    deps.log = () => {}
    app = createApp(deps)
  })

  afterAll(async () => {
    await db?.end()
  })

  it('migrations are idempotent', async () => {
    expect(await migrate(db, undefined, () => {})).toEqual([])
    const res = await app.request('/healthz')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('exchanges a one-time code once and authenticates the bearer token', async () => {
    const user = await upsertUser(db, { sub: '1', email: 'Boss@kejue.co', emailVerified: true, name: 'Boss Person' }, config.adminEmails)
    const code = await createLoginCode(db, user.id)
    const post = () => app.request('/api/desktop/exchange', { method: 'POST', body: JSON.stringify({ code }), headers: { 'content-type': 'application/json' } })
    const first = await post()
    expect(first.status).toBe(200)
    const { token, user: u } = (await first.json()) as { token: string; user: Record<string, unknown> }
    expect(u).toEqual({ email: 'boss@kejue.co', name: 'Boss Person', picture: null, isAdmin: true })
    const second = await post()
    expect(second.status).toBe(401)
    expect(await second.json()).toMatchObject({ error: 'unauthorized' })

    const stored = await db.query('SELECT token_hash FROM sessions')
    expect(stored.rows.every((r: { token_hash: string }) => r.token_hash !== token)).toBe(true)

    const me = await call(token, '/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      user: { email: 'boss@kejue.co', isAdmin: true },
      team: { name: 'Yogurt Team', driveConnected: false, summariesEnabled: false, uploadAudio: true, graceMinutes: 10 },
    })
    expect((await app.request('/api/me')).status).toBe(401)
    expect((await call('ytd_nope', '/api/me')).status).toBe(401)
  })

  it('rejects uploads with not_configured until Drive is set up', async () => {
    const token = await signIn('boss@kejue.co', 'Boss Person')
    const res = await call(token, '/api/uploads', 'POST', meeting)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_configured' })
  })

  it('uploads, shares folders between recorders, keeps audio on audio-less re-uploads, and deletes per recorder', async () => {
    await deps.settings.setSecret(db, 'driveRefreshToken', 'rt')
    await deps.settings.update(db, { driveFolder: { id: 'root-folder', name: 'Meetings' } })
    const boss = await signIn('boss@kejue.co', 'Boss Person')
    const sam = await signIn('sam@kejue.co', 'Sam Smith')
    expect(await (await call(boss, '/api/me')).json()).toMatchObject({ team: { driveConnected: true } })

    // First upload by Boss.
    const r1 = await call(boss, '/api/uploads', 'POST', meeting)
    expect(r1.status).toBe(200)
    const up1 = (await r1.json()) as { uploadId: string; folderUrl: string; audio: { track: string; uploadUrl: string }[] }
    const [folder] = drive.children('root-folder')
    expect(folder!.name).toBe('2026-11-18 Launch planning')
    expect(up1.folderUrl).toBe(`https://drive.google.com/drive/folders/${folder!.id}`)
    expect(up1.audio.map((a) => a.track)).toEqual(['mic', 'others'])
    const names = () => drive.children(folder!.id).map((f) => f.name).sort()
    expect(names()).toEqual(['Boss – Notes', 'Boss – Transcript'])
    expect(drive.children(folder!.id).find((f) => f.name === 'Boss – Notes')!.html).toContain('<strong>it</strong>')

    // App PUTs the bytes, then completes.
    for (const a of up1.audio) drive.put(a.uploadUrl)
    const c1 = await call(boss, `/api/uploads/${up1.uploadId}/complete`, 'POST', { audio: up1.audio.map((a) => ({ track: a.track, ok: true })) })
    expect(c1.status).toBe(200)
    expect(names()).toEqual(['Boss – Notes', 'Boss – Transcript', 'Boss – mic.m4a', 'Boss – others.m4a'])
    const log1 = await db.query('SELECT status FROM uploads WHERE id = $1', [up1.uploadId])
    expect(log1.rows[0].status).toBe('complete')

    // Sam records the same calendar event: same folder.
    const r2 = await call(sam, '/api/uploads', 'POST', { ...meeting, meetingId: 'sam-local', startedAt: '2026-11-18T10:03:00Z', audio: [] })
    expect(r2.status).toBe(200)
    expect(((await r2.json()) as { folderUrl: string }).folderUrl).toBe(up1.folderUrl)
    expect(drive.children('root-folder')).toHaveLength(1)
    expect(names()).toContain('Sam – Notes')

    // Boss re-uploads with no audio: docs updated in place, audio kept.
    const docIds = drive.children(folder!.id).filter((f) => f.name.startsWith('Boss – N')).map((f) => f.id)
    const r3 = await call(boss, '/api/uploads', 'POST', { ...meeting, notesMarkdown: '# Better notes', audio: [] })
    expect(r3.status).toBe(200)
    const up3 = (await r3.json()) as { audio: unknown[] }
    expect(up3.audio).toEqual([])
    expect(names().filter((n) => n.startsWith('Boss'))).toEqual(['Boss – Notes', 'Boss – Transcript', 'Boss – mic.m4a', 'Boss – others.m4a'])
    const notes = drive.children(folder!.id).find((f) => f.name === 'Boss – Notes')!
    expect(docIds).toContain(notes.id)
    expect(notes.html).toContain('Better notes')

    // Boss re-uploads just the mic track: the old mic file is replaced, others kept.
    const oldMic = drive.children(folder!.id).find((f) => f.name === 'Boss – mic.m4a')!
    const r4 = await call(boss, '/api/uploads', 'POST', { ...meeting, audio: [meeting.audio[0]] })
    const up4 = (await r4.json()) as { uploadId: string; audio: { track: string; uploadUrl: string }[] }
    drive.put(up4.audio[0]!.uploadUrl)
    await call(boss, `/api/uploads/${up4.uploadId}/complete`, 'POST', { audio: [{ track: 'mic', ok: true }] })
    expect(drive.files.has(oldMic.id)).toBe(false)
    expect(names().filter((n) => n.startsWith('Boss'))).toEqual(['Boss – Notes', 'Boss – Transcript', 'Boss – mic.m4a', 'Boss – others.m4a'])

    // A failed audio PUT is reported and logged.
    const r5 = await call(boss, '/api/uploads', 'POST', { ...meeting, audio: [meeting.audio[1]] })
    const up5 = (await r5.json()) as { uploadId: string }
    const c5 = await call(boss, `/api/uploads/${up5.uploadId}/complete`, 'POST', { audio: [{ track: 'others', ok: false, error: 'network' }] })
    expect(await c5.json()).toMatchObject({ status: 'failed' })
    expect(names().filter((n) => n.startsWith('Boss – others'))).toHaveLength(1)

    // Someone else can't complete Boss's upload.
    expect((await call(sam, `/api/uploads/${up5.uploadId}/complete`, 'POST', { audio: [] })).status).toBe(404)

    // Boss deletes: only Boss's files go, the folder stays for Sam.
    const d1 = await call(boss, '/api/uploads/by-meeting/local-1', 'DELETE')
    expect(d1.status).toBe(200)
    expect(names()).toEqual(['Sam – Notes', 'Sam – Transcript'])
    // Sam deletes: folder is now empty and removed.
    await call(sam, '/api/uploads/by-meeting/sam-local', 'DELETE')
    expect(drive.files.has(folder!.id)).toBe(false)
  })

  it('matches by title and start within 10 minutes when there is no calendar event', async () => {
    const boss = await signIn('boss@kejue.co', 'Boss Person')
    const sam = await signIn('sam@kejue.co', 'Sam Smith')
    const base = { ...meeting, calendarEventId: undefined, title: 'Standup', audio: [] }
    const a = (await (await call(boss, '/api/uploads', 'POST', { ...base, meetingId: 'w1', startedAt: '2026-11-19T09:00:00Z' })).json()) as { folderUrl: string }
    const b = (await (await call(sam, '/api/uploads', 'POST', { ...base, meetingId: 'w2', startedAt: '2026-11-19T09:08:00Z' })).json()) as { folderUrl: string }
    const c = (await (await call(sam, '/api/uploads', 'POST', { ...base, meetingId: 'w3', startedAt: '2026-11-19T09:25:00Z' })).json()) as { folderUrl: string }
    expect(b.folderUrl).toBe(a.folderUrl)
    expect(c.folderUrl).not.toBe(a.folderUrl)
  })

  it('respects admin toggles for which files get uploaded', async () => {
    await deps.settings.update(db, { uploadTranscript: false, uploadAudio: false })
    const boss = await signIn('boss@kejue.co', 'Boss Person')
    const res = await call(boss, '/api/uploads', 'POST', { ...meeting, meetingId: 'toggles', calendarEventId: 'evt-toggles' })
    const body = (await res.json()) as { folderUrl: string; audio: unknown[] }
    expect(body.audio).toEqual([])
    const folderId = body.folderUrl.split('/').pop()!
    expect(drive.children(folderId).map((f) => f.name)).toEqual(['Boss – Notes'])
    await deps.settings.update(db, { uploadTranscript: true, uploadAudio: true })
  })

  it('streams /api/llm/chat through OpenRouter in the contract SSE shape', async () => {
    const token = await signIn('sam@kejue.co', 'Sam Smith')
    const req = { messages: [{ role: 'user', content: 'Hi' }], purpose: 'summary', maxTokens: 50 }
    const none = await call(token, '/api/llm/chat', 'POST', req)
    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ error: 'not_configured' })

    await deps.settings.setSecret(db, 'openrouterKey', 'sk-or-test')
    await deps.settings.update(db, { openrouterModel: 'test/model' })
    expect(await (await call(token, '/api/me')).json()).toMatchObject({ team: { summariesEnabled: true } })
    const res = await call(token, '/api/llm/chat', 'POST', req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe('data: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\ndata: {"done":true}\n\n')
    expect(openrouterCalls[0]).toMatchObject({ auth: 'Bearer sk-or-test', body: { model: 'test/model', stream: true, max_tokens: 50 } })

    const stored = await db.query(`SELECT value FROM settings WHERE key = 'secret.openrouterKey'`)
    expect(JSON.stringify(stored.rows[0].value)).not.toContain('sk-or-test')
  })

  it('signs out a desktop token', async () => {
    const token = await signIn('sam@kejue.co', 'Sam Smith')
    expect((await call(token, '/api/desktop/signout', 'POST')).status).toBe(200)
    expect((await call(token, '/api/me')).status).toBe(401)
  })

  it('sends /admin to sign-in without a session and starts Google sign-in', async () => {
    const res = await app.request('/admin')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/login')
    const members = await app.request('/admin/members')
    expect(members.headers.get('location')).toBe('/admin/login')
    const login = await app.request('/admin/login')
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    const desktop = await app.request('/auth/desktop/start?port=53682&state=abc123')
    const loc = new URL(desktop.headers.get('location')!)
    expect(loc.searchParams.get('redirect_uri')).toBe('https://team.example.com/auth/google/callback')
    expect(loc.searchParams.get('scope')).toBe('openid email profile')
    expect((await app.request('/auth/desktop/start?port=80&state=abc')).status).toBe(400)
  })
})
