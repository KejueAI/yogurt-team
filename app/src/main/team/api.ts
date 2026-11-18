/**
 * The team server's JSON API (server/API.md is the contract). Every call takes the server and token it should
 * use, so the session and the upload queue decide those; fetch is injectable for tests.
 */
import type { TeamMe, TeamUser } from './types'

export type Fetch = typeof fetch

/** A failed call: status 0 when the server could not be reached */
export class TeamApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'TeamApiError' }
  /** worth trying again later by itself: offline, the server failing, rate limits, an admin still setting up */
  get transient(): boolean { return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429 || this.code === 'not_configured' }
}

export type UploadAudio = { track: 'me' | 'them'; fileName: string; mimeType: string; size: number }
export type UploadRequest = {
  meetingId: string; calendarEventId?: string; title: string; startedAt: string; endedAt: string
  attendees: string[]; notesMarkdown: string; transcriptMarkdown: string; audio: UploadAudio[]
}
export type UploadResponse = { uploadId: string; folderUrl: string; audio: { track: 'me' | 'them'; uploadUrl: string }[] }
export type CompleteAudio = { track: 'me' | 'them'; ok: boolean; error?: string }

export type TeamApi = ReturnType<typeof teamApi>

export function teamApi(serverUrl: string, token: string | undefined, f: Fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await f(`${serverUrl}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (e) {
      throw new TeamApiError(0, 'offline', `Couldn't reach the team server (${e instanceof Error ? e.message : String(e)})`)
    }
    const text = await res.text().catch(() => '')
    let json: unknown = undefined
    try { json = text ? JSON.parse(text) : undefined } catch { /* not JSON */ }
    if (!res.ok) {
      const err = json && typeof json === 'object' ? json as { error?: string; message?: string } : {}
      throw new TeamApiError(res.status, err.error ?? (res.status === 401 ? 'unauthorized' : 'http_error'), err.message ?? `The team server answered ${res.status}`)
    }
    return json as T
  }
  return {
    exchange: (code: string) => call<{ token: string; user: TeamUser }>('POST', '/api/desktop/exchange', { code }),
    me: () => call<TeamMe>('GET', '/api/me'),
    signOut: () => call<unknown>('POST', '/api/desktop/signout'),
    createUpload: (body: UploadRequest) => call<UploadResponse>('POST', '/api/uploads', body),
    complete: (uploadId: string, audio: CompleteAudio[]) => call<unknown>('POST', `/api/uploads/${encodeURIComponent(uploadId)}/complete`, { audio }),
    removeMeeting: (meetingId: string) => call<unknown>('DELETE', `/api/uploads/by-meeting/${encodeURIComponent(meetingId)}`),
  }
}
