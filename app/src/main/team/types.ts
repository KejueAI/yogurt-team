/**
 * Yogurt Team: the shapes shared by the main process, the preload bridge (window.yogurtTeam) and the Team UI.
 * Fork-owned; upstream's YogurtApi in shared/types.ts is left alone.
 */

/** GET /api/me and POST /api/desktop/exchange (server/API.md) */
export type TeamUser = { email: string; name: string; picture?: string | null; isAdmin: boolean }
export type TeamConfig = {
  name: string; driveConnected: boolean; summariesEnabled: boolean
  /** the server transcribes finished recordings (Kejue Inference); optional for older servers */
  transcriptionEnabled?: boolean
  uploadAudio: boolean; uploadTranscript: boolean; uploadNotes: boolean; graceMinutes: number
}
export type TeamMe = { user: TeamUser; team: TeamConfig }

/** What the Team section of Settings shows */
export type TeamState = {
  serverUrl: string
  defaultServerUrl: string
  signedIn: boolean
  signingIn: boolean
  user: TeamUser | null
  team: TeamConfig | null
  /** the last /api/me failed (offline, server down); what is shown is the last one that worked */
  meError: string | null
}

export type UploadState = 'waiting' | 'uploading' | 'uploaded' | 'failed' | 'removing'

/** What the note view shows next to the Private switch */
export type TeamMeetingState = {
  signedIn: boolean
  private: boolean
  upload: null | {
    state: UploadState
    /** waiting: when the upload starts (end of the grace period, or the next retry) */
    dueAt: number | null
    folderUrl: string | null
    error: string | null
  }
}

export type SignInResult = { ok: true; user: TeamUser } | { ok: false; error: string }

/** window.yogurtTeam */
export type YogurtTeamApi = {
  state(): Promise<TeamState>
  setServerUrl(url: string): Promise<TeamState>
  signIn(): Promise<SignInResult>
  cancelSignIn(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<TeamState>
  openAdmin(): Promise<void>
  meeting(id: string): Promise<TeamMeetingState>
  setPrivate(id: string, on: boolean): Promise<TeamMeetingState>
  retry(id: string): Promise<TeamMeetingState>
  openFolder(id: string): Promise<void>
  /** fires when sign-in, the team or any meeting's upload changed; returns an unsubscribe */
  onChange(cb: () => void): () => void
}
