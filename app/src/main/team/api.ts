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

/** me and them are the raw tracks; recording is both mixed, the one file the app sends now */
export type AudioTrack = 'me' | 'them' | 'recording'
export type UploadAudio = { track: AudioTrack; fileName: string; mimeType: string; size: number }
export type UploadRequest = {
  meetingId: string; calendarEventId?: string; title: string; startedAt: string; endedAt: string
  attendees: string[]; notesMarkdown: string; transcriptMarkdown: string; audio: UploadAudio[]
}
export type UploadResponse = { uploadId: string; folderUrl: string; audio: { track: AudioTrack; uploadUrl: string }[] }
export type CompleteAudio = { track: AudioTrack; ok: boolean; error?: string }

export type SttJob = { id: string; status: string; error?: { code?: string; message?: string } | null }
export type SttWord = { text: string; start_ms: number | null; end_ms: number | null }
export type SttResult = { text: string; language?: string; duration_ms?: number; words?: SttWord[]; chunks?: { text: string; start_ms: number; end_ms: number }[] }

export type TeamApi = ReturnType<typeof teamApi>

export function teamApi(serverUrl: string, token: string | undefined, f: Fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    let res: Response
    try {
      res = await f(`${serverUrl}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
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
      const raw = json && typeof json === 'object' ? json as { error?: string | { code?: string; message?: string }; message?: string } : {}
      // most routes answer { error, message }; the transcription routes pass Kejue's { error: { code, message } } through
      const err = typeof raw.error === 'object' && raw.error ? { error: raw.error.code, message: raw.error.message } : { error: raw.error as string | undefined, message: raw.message }
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
    // transcription through the server (it holds the Kejue key); key: an Idempotency-Key so a retry never makes a second one
    sttUpload: (b: { filename: string; size_bytes: number; content_type: string }, key: string) => call<{ id: string; part_size_bytes: number }>('POST', '/api/stt/uploads', b, { 'Idempotency-Key': key }),
    sttParts: (id: string, parts: { part_number: number; checksum_sha256: string }[], key: string) => call<{ data: { part_number: number; url: string; headers?: Record<string, string> }[] }>('POST', `/api/stt/uploads/${encodeURIComponent(id)}/parts`, { parts }, { 'Idempotency-Key': key }),
    sttComplete: (id: string, key: string) => call<{ status?: string }>('POST', `/api/stt/uploads/${encodeURIComponent(id)}/complete`, {}, { 'Idempotency-Key': key }),
    sttJob: (b: { upload_id: string; language: 'en' | 'ar' | 'auto'; timestamp_granularity: 'chunk' | 'word' }, key: string) => call<{ id: string; status: string }>('POST', '/api/stt/jobs', b, { 'Idempotency-Key': key }),
    sttJobStatus: (id: string) => call<SttJob>('GET', `/api/stt/jobs/${encodeURIComponent(id)}`),
    sttResult: (id: string) => call<SttResult>('GET', `/api/stt/jobs/${encodeURIComponent(id)}/result`),
    sttAbortUpload: (id: string) => call<unknown>('DELETE', `/api/stt/uploads/${encodeURIComponent(id)}`),
    sttDelete: (id: string) => call<unknown>('DELETE', `/api/stt/jobs/${encodeURIComponent(id)}`),
  }
}
