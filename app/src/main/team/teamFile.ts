/**
 * team.json in the user data folder: everything Yogurt Team keeps, apart from upstream's settings.json and
 * yogurt.db so upstream's files never change shape. The session token is sealed (the system keychain through
 * Electron safeStorage, as upstream does for calendar addresses); private meetings and the upload queue are plain.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TeamMe, UploadState } from './types'

/** One meeting's place in the upload queue; keyed by meeting id, so a second summary replaces the first */
export type UploadEntry = {
  meetingId: string
  /** upload: send notes, transcript and audio; remove: the meeting became private after it was sent */
  op: 'upload' | 'remove'
  state: UploadState
  /** nothing is tried before this */
  dueAt: number
  attempts: number
  /** bumped on every change, so a run that finishes after one knows to go again */
  version: number
  /** the recording's deletion (keep-recordings off) waits for its audio to be sent */
  holdDelete?: boolean
  /** the server has had files for this meeting, so making it private must remove them */
  sent?: boolean
  folderUrl?: string
  error?: string
  /** a failure that retrying will not fix by itself (bad request): only the Retry button tries again */
  stuck?: boolean
}

export type TeamData = {
  serverUrl?: string
  /** sealed: "k:" keychain or "b:" base64 when the system has no keychain */
  token?: string
  me?: TeamMe
  private: string[]
  uploads: Record<string, UploadEntry>
}

const empty = (): TeamData => ({ private: [], uploads: {} })

export function loadTeamData(file: string): TeamData {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TeamData>
    return {
      ...(typeof raw.serverUrl === 'string' ? { serverUrl: raw.serverUrl } : {}),
      ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
      ...(raw.me && typeof raw.me === 'object' ? { me: raw.me } : {}),
      private: Array.isArray(raw.private) ? raw.private.filter((x): x is string => typeof x === 'string') : [],
      uploads: raw.uploads && typeof raw.uploads === 'object' ? raw.uploads : {},
    }
  } catch { return empty() }
}

/** Written whole to a temporary file and moved over, so a crash never leaves half a file */
export function saveTeamData(file: string, data: TeamData): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/** A small read-modify-write store over team.json, kept in memory */
export class TeamFile {
  private data: TeamData
  constructor(private file: string) { this.data = loadTeamData(file) }
  get(): TeamData { return this.data }
  update(fn: (d: TeamData) => void): TeamData {
    fn(this.data)
    saveTeamData(this.file, this.data)
    return this.data
  }
}

export type Sealer = { seal(plain: string): string; open(sealed: string): string }
