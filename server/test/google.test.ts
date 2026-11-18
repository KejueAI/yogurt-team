import { describe, expect, it, vi } from 'vitest'
import { DOC_MIME, DriveClient, GoogleApiError, GoogleOAuth, driveQuote } from '../src/google.js'

type Call = { url: string; init: RequestInit }

function fakeFetch(responder: (call: Call) => Response) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    return responder(call)
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function client(responder: (call: Call) => Response) {
  const f = fakeFetch(responder)
  const getToken = vi.fn(async () => ({ token: 'at-1', expiresIn: 3600 }))
  return { drive: new DriveClient(getToken, f.fn), calls: f.calls, getToken }
}

describe('DriveClient', () => {
  it('creates a resumable session with the right headers and returns the Location URL', async () => {
    const { drive, calls } = client(() => json({}, 200, { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=XYZ' }))
    const url = await drive.createResumableSession({ name: 'Youssef – mic.m4a', parentId: 'folder1', mimeType: 'audio/mp4', size: 123456, appProperties: { yogurtTeamAudio: 'u:mic' } })
    expect(url).toBe('https://www.googleapis.com/upload/drive/v3/files?upload_id=XYZ')
    const { url: reqUrl, init } = calls[0]!
    expect(reqUrl).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&supportsAllDrives=true/)
    expect(init.method).toBe('POST')
    const h = new Headers(init.headers)
    expect(h.get('authorization')).toBe('Bearer at-1')
    expect(h.get('content-type')).toBe('application/json; charset=UTF-8')
    expect(h.get('x-upload-content-type')).toBe('audio/mp4')
    expect(h.get('x-upload-content-length')).toBe('123456')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Youssef – mic.m4a', parents: ['folder1'], appProperties: { yogurtTeamAudio: 'u:mic' } })
  })

  it('fails clearly when Drive returns no session URL', async () => {
    const { drive } = client(() => json({}))
    await expect(drive.createResumableSession({ name: 'a', parentId: 'p', mimeType: 'audio/mp4', size: 1 })).rejects.toBeInstanceOf(GoogleApiError)
  })

  it('uploads HTML as multipart and asks for a Google Doc', async () => {
    const { drive, calls } = client(() => json({ id: 'doc1', name: 'Notes' }))
    await drive.createDoc('Youssef – Notes', 'folder1', '<h1>Hi</h1>')
    const { url, init } = calls[0]!
    expect(url).toContain('uploadType=multipart')
    expect(url).toContain('supportsAllDrives=true')
    const ct = new Headers(init.headers).get('content-type')!
    expect(ct).toMatch(/^multipart\/related; boundary=/)
    const body = String(init.body)
    expect(body).toContain(`"mimeType":"${DOC_MIME}"`)
    expect(body).toContain('"parents":["folder1"]')
    expect(body).toContain('Content-Type: text/html; charset=UTF-8')
    expect(body).toContain('<h1>Hi</h1>')
  })

  it('updates a Doc in place and moves it when asked', async () => {
    const { drive, calls } = client(() => json({ id: 'doc1' }))
    await drive.updateDoc('doc1', 'Name', '<p>x</p>', { addParent: 'new', removeParents: ['old'] })
    const { url, init } = calls[0]!
    expect(init.method).toBe('PATCH')
    expect(url).toContain('/upload/drive/v3/files/doc1?')
    expect(url).toContain('addParents=new')
    expect(url).toContain('removeParents=old')
  })

  it('passes Shared Drive flags when listing folders', async () => {
    const { drive, calls } = client(() => json({ files: [{ id: 'f', name: 'Meetings' }] }))
    expect(await drive.listFolders('drive1', 'drive1')).toEqual([{ id: 'f', name: 'Meetings' }])
    const u = new URL(calls[0]!.url)
    expect(u.searchParams.get('supportsAllDrives')).toBe('true')
    expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(u.searchParams.get('corpora')).toBe('drive')
    expect(u.searchParams.get('driveId')).toBe('drive1')
    expect(u.searchParams.get('q')).toBe(`'drive1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)
  })

  it('pages through Shared Drives', async () => {
    let n = 0
    const { drive } = client(() => (n++ === 0 ? json({ drives: [{ id: 'a', name: 'A' }], nextPageToken: 't' }) : json({ drives: [{ id: 'b', name: 'B' }] })))
    expect((await drive.listSharedDrives()).map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('treats 404 as missing and falls back to trash on 403', async () => {
    const gone = client(() => json({ error: { message: 'File not found' } }, 404))
    expect(await gone.drive.getFile('x')).toBeNull()
    expect(await gone.drive.deleteFile('x')).toBe('missing')

    const forbidden = client((call) => (call.init.method === 'DELETE' ? json({ error: { message: 'no' } }, 403) : json({ id: 'x', trashed: true })))
    expect(await forbidden.drive.deleteFile('x')).toBe('trashed')
    expect(forbidden.calls[1]!.init.method).toBe('PATCH')
    expect(JSON.parse(forbidden.calls[1]!.init.body as string)).toEqual({ trashed: true })
  })

  it('surfaces Google error messages', async () => {
    const { drive } = client(() => json({ error: { message: 'Insufficient permissions' } }, 403))
    await expect(drive.createFolder('a', 'p')).rejects.toThrow(/Insufficient permissions/)
  })

  it('caches the access token', async () => {
    const { drive, getToken } = client(() => json({ files: [] }))
    await drive.countChildren('a')
    await drive.countChildren('b')
    expect(getToken).toHaveBeenCalledTimes(1)
  })

  it('quotes query values', () => {
    expect(driveQuote(`it's \\ here`)).toBe(`'it\\'s \\\\ here'`)
  })
})

describe('GoogleOAuth', () => {
  it('builds a Drive consent URL with offline access', () => {
    const oauth = new GoogleOAuth('cid', 'secret')
    const url = new URL(
      oauth.authUrl({ redirectUri: 'https://t.example.com/auth/drive/callback', state: 's', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive'], offline: true, consent: true }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('s')
  })

  it('exchanges a code and reads the profile', async () => {
    const f = fakeFetch((call) =>
      call.url.includes('token') ? json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' }) : json({ sub: '1', email: 'a@kejue.co', email_verified: true, name: 'Ana B', given_name: 'Ana', hd: 'kejue.co' }),
    )
    const oauth = new GoogleOAuth('cid', 'secret', f.fn)
    const tokens = await oauth.exchangeCode('code', 'https://t.example.com/auth/google/callback')
    expect(tokens.refresh_token).toBe('rt')
    const form = new URLSearchParams(String(f.calls[0]!.init.body))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('redirect_uri')).toBe('https://t.example.com/auth/google/callback')
    const user = await oauth.userInfo('at')
    expect(user).toMatchObject({ email: 'a@kejue.co', emailVerified: true, givenName: 'Ana' })
  })
})
