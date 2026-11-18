export type Fetch = typeof fetch

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DOC_MIME = 'application/vnd.google-apps.document'

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

async function failure(res: Response, what: string): Promise<GoogleApiError> {
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; error_description?: string }
    detail =
      (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error_description || parsed.error) ?? detail
  } catch {
    // not JSON
  }
  return new GoogleApiError(`${what} failed (${res.status}): ${detail}`, res.status, body)
}

export interface GoogleUser {
  sub: string
  email: string
  emailVerified: boolean
  name?: string
  givenName?: string
  picture?: string
  hd?: string
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
}

/** Google OAuth 2.0 web-server flow. */
export class GoogleOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  authUrl(opts: {
    redirectUri: string
    state: string
    scopes: string[]
    offline?: boolean
    consent?: boolean
    hostedDomain?: string
    loginHint?: string
  }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: opts.scopes.join(' '),
      state: opts.state,
    })
    if (opts.offline) params.set('access_type', 'offline')
    params.set('prompt', opts.consent ? 'consent' : 'select_account')
    if (opts.hostedDomain) params.set('hd', opts.hostedDomain)
    if (opts.loginHint) params.set('login_hint', opts.loginHint)
    if (opts.offline) params.set('include_granted_scopes', 'true')
    return `${GOOGLE_AUTH_URL}?${params}`
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) throw await failure(res, 'Google token exchange')
    return (await res.json()) as TokenResponse
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) throw await failure(res, 'Google token refresh')
    return (await res.json()) as TokenResponse
  }

  async userInfo(accessToken: string): Promise<GoogleUser> {
    const res = await this.fetchImpl(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw await failure(res, 'Google userinfo')
    const u = (await res.json()) as Record<string, unknown>
    return {
      sub: String(u.sub),
      email: String(u.email ?? '').toLowerCase(),
      emailVerified: u.email_verified === true || u.email_verified === 'true',
      name: typeof u.name === 'string' ? u.name : undefined,
      givenName: typeof u.given_name === 'string' ? u.given_name : undefined,
      picture: typeof u.picture === 'string' ? u.picture : undefined,
      hd: typeof u.hd === 'string' ? u.hd : undefined,
    }
  }
}

export interface DriveFile {
  id: string
  name: string
  mimeType?: string
  parents?: string[]
  driveId?: string
  trashed?: boolean
  webViewLink?: string
  createdTime?: string
}

export interface SharedDrive {
  id: string
  name: string
}

/** Escapes a value for a Drive `q` string literal. */
export function driveQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`
}

export function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`
}

const ALL_DRIVES = 'supportsAllDrives=true'

/**
 * The parts of the Drive v3 REST API the server uses, authenticated with the admin's
 * connected account. Every call passes supportsAllDrives so Shared Drives work.
 */
export class DriveClient {
  private cached: { token: string; expiresAt: number } | null = null

  constructor(
    private readonly getAccessToken: () => Promise<{ token: string; expiresIn: number }>,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token
    const { token, expiresIn } = await this.getAccessToken()
    this.cached = { token, expiresAt: Date.now() + expiresIn * 1000 }
    return token
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` },
    })
    if (!res.ok) throw await failure(res, what)
    return res
  }

  async listSharedDrives(): Promise<SharedDrive[]> {
    const drives: SharedDrive[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({ pageSize: '100', fields: 'nextPageToken,drives(id,name)' })
      if (pageToken) params.set('pageToken', pageToken)
      const res = await this.call(`${DRIVE_API}/drives?${params}`, {}, 'List Shared Drives')
      const body = (await res.json()) as { drives?: SharedDrive[]; nextPageToken?: string }
      drives.push(...(body.drives ?? []))
      pageToken = body.nextPageToken
    } while (pageToken && drives.length < 1000)
    return drives
  }

  /** Folders directly inside `parentId` (a folder id, a Shared Drive id, or "root" for My Drive). */
  async listFolders(parentId: string, driveId?: string): Promise<DriveFile[]> {
    const folders: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: `${driveQuote(parentId)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,parents,driveId)',
        orderBy: 'name',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      })
      if (driveId) {
        params.set('corpora', 'drive')
        params.set('driveId', driveId)
      } else {
        params.set('corpora', 'user')
      }
      if (pageToken) params.set('pageToken', pageToken)
      const res = await this.call(`${DRIVE_API}/files?${params}`, {}, 'List folders')
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string }
      folders.push(...(body.files ?? []))
      pageToken = body.nextPageToken
    } while (pageToken && folders.length < 2000)
    return folders
  }

  /** Returns null when the file does not exist or the account cannot see it. */
  async getFile(id: string): Promise<DriveFile | null> {
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,parents,driveId,trashed,webViewLink',
      supportsAllDrives: 'true',
    })
    try {
      const res = await this.call(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {}, 'Get file')
      return (await res.json()) as DriveFile
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return null
      throw err
    }
  }

  async getSharedDrive(id: string): Promise<SharedDrive | null> {
    try {
      const res = await this.call(`${DRIVE_API}/drives/${encodeURIComponent(id)}?fields=id,name`, {}, 'Get Shared Drive')
      return (await res.json()) as SharedDrive
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return null
      throw err
    }
  }

  async createFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    const res = await this.call(
      `${DRIVE_API}/files?${ALL_DRIVES}&fields=id,name,parents,driveId`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
      },
      'Create folder',
    )
    return (await res.json()) as DriveFile
  }

  /** Uploads HTML and has Drive convert it to a Google Doc. */
  async createDoc(name: string, parentId: string, html: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    const { body, contentType } = multipart({ name, mimeType: DOC_MIME, parents: [parentId], appProperties }, html, 'text/html')
    const res = await this.call(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&${ALL_DRIVES}&fields=id,name,parents`,
      { method: 'POST', headers: { 'Content-Type': contentType }, body },
      'Create Google Doc',
    )
    return (await res.json()) as DriveFile
  }

  /** Replaces a Google Doc's content (and name), moving it into `parentId` if it lives elsewhere. */
  async updateDoc(fileId: string, name: string, html: string, move?: { addParent: string; removeParents: string[] }): Promise<DriveFile> {
    const { body, contentType } = multipart({ name }, html, 'text/html')
    const params = new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name,parents' })
    if (move && move.removeParents.length) {
      params.set('addParents', move.addParent)
      params.set('removeParents', move.removeParents.join(','))
    }
    const res = await this.call(
      `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?${params}`,
      { method: 'PATCH', headers: { 'Content-Type': contentType }, body },
      'Update Google Doc',
    )
    return (await res.json()) as DriveFile
  }

  /**
   * Starts a resumable upload session on behalf of the server's account and returns the
   * session URL. Whoever holds the URL can PUT the bytes without further auth.
   */
  async createResumableSession(opts: {
    name: string
    parentId: string
    mimeType: string
    size: number
    appProperties?: Record<string, string>
  }): Promise<string> {
    const res = await this.call(
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&${ALL_DRIVES}&fields=id,name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': opts.mimeType,
          'X-Upload-Content-Length': String(opts.size),
        },
        body: JSON.stringify({ name: opts.name, parents: [opts.parentId], appProperties: opts.appProperties }),
      },
      'Start resumable upload',
    )
    const location = res.headers.get('location')
    if (!location) throw new GoogleApiError('Start resumable upload returned no Location header', 502)
    return location
  }

  /** Files this server created with the given appProperty, newest first. */
  async findByAppProperty(parentId: string, key: string, value: string): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q: `${driveQuote(parentId)} in parents and appProperties has { key=${driveQuote(key)} and value=${driveQuote(value)} } and trashed = false`,
      fields: 'files(id,name,createdTime)',
      orderBy: 'createdTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    const res = await this.call(`${DRIVE_API}/files?${params}`, {}, 'Find uploaded file')
    return ((await res.json()) as { files?: DriveFile[] }).files ?? []
  }

  async countChildren(parentId: string): Promise<number> {
    const params = new URLSearchParams({
      q: `${driveQuote(parentId)} in parents and trashed = false`,
      fields: 'files(id)',
      pageSize: '10',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    const res = await this.call(`${DRIVE_API}/files?${params}`, {}, 'List folder')
    return ((await res.json()) as { files?: DriveFile[] }).files?.length ?? 0
  }

  /**
   * Deletes a file permanently. On a Shared Drive that needs the Manager (organizer) role, so
   * a 403 falls back to moving the file to the trash, which Content managers may do.
   * A file that is already gone counts as deleted.
   */
  async deleteFile(id: string): Promise<'deleted' | 'trashed' | 'missing'> {
    try {
      await this.call(`${DRIVE_API}/files/${encodeURIComponent(id)}?${ALL_DRIVES}`, { method: 'DELETE' }, 'Delete file')
      return 'deleted'
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err
      if (err.status === 404) return 'missing'
      if (err.status !== 403) throw err
    }
    try {
      await this.call(
        `${DRIVE_API}/files/${encodeURIComponent(id)}?${ALL_DRIVES}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) },
        'Trash file',
      )
      return 'trashed'
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return 'missing'
      throw err
    }
  }
}

function multipart(metadata: object, content: string, contentType: string): { body: string; contentType: string } {
  const boundary = `yogurt-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}
