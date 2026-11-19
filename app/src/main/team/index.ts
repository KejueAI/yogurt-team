/**
 * Yogurt Team in the main process: hookTeam(deps) is the one call upstream's index.ts makes. It owns team.json,
 * the session, the upload queue and the yogurtTeam:* IPC the Team UI uses.
 */
import { ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { audioHelperPath } from '../capture'
import type { AudioExt } from '../audio'
import type { Store } from '../store'
import { bindTeamSession, TeamSession } from './session'
import { createRemoteTranscription } from './stt'
import { TeamFile, type Sealer } from './teamFile'
import type { TeamMeetingState, TeamState } from './types'
import { UploadQueue } from './uploads'

export const TEAM_CHANGED = 'yogurtTeam:changed'

/** The keychain when the system has one (as upstream seals calendar addresses), else plain base64 */
export const safeStorageSealer: Sealer = {
  seal: plain => safeStorage.isEncryptionAvailable() ? `k:${safeStorage.encryptString(plain).toString('base64')}` : `b:${Buffer.from(plain).toString('base64')}`,
  open: sealed => {
    if (sealed.startsWith('k:')) return safeStorage.decryptString(Buffer.from(sealed.slice(2), 'base64'))
    if (sealed.startsWith('b:')) return Buffer.from(sealed.slice(2), 'base64').toString('utf8')
    throw new Error('unknown sealing')
  },
}

const httpUrl = (u: string | undefined): u is string => { try { return !!u && /^https?:$/.test(new URL(u).protocol) } catch { return false } }

export type TeamDeps = {
  userDataDir: string
  store: Pick<Store, 'meeting' | 'notes' | 'segments' | 'replaceSegments'>
  dirOf: (id: string) => string
  audioKinds: () => readonly AudioExt[]
  /** upstream's automatic recording deletion: removeRecording(id, true) */
  removeRecording: (id: string) => unknown
  window: () => BrowserWindow | undefined
  /** the transcript was replaced by the team's transcription service: the window and search should look again */
  transcriptChanged: (meetingId: string) => void
}

export function hookTeam(d: TeamDeps) {
  const file = new TeamFile(join(d.userDataDir, 'team.json'))
  const session = new TeamSession({ file, sealer: safeStorageSealer, openBrowser: url => shell.openExternal(url) })
  bindTeamSession(session)
  let queue: UploadQueue | undefined
  const send = () => { const w = d.window(); if (w && !w.isDestroyed()) w.webContents.send(TEAM_CHANGED) }
  const getQueue = () => (queue ??= new UploadQueue({
    file, session, store: d.store, dirOf: d.dirOf, audioKinds: d.audioKinds(), removeRecording: d.removeRecording, changed: send,
    mixAudio: (inputs, out) => new Promise((resolve, reject) => {
      execFile(audioHelperPath(), ['mix', '--out', out, ...inputs], { timeout: 30 * 60_000, windowsHide: true }, (error, _stdout, stderr) =>
        error ? reject(new Error(String(stderr).trim() || error.message)) : resolve())
    }),
  }))
  session.onChange(send)
  const remote = createRemoteTranscription({
    session, store: d.store, dirOf: d.dirOf, audioKinds: d.audioKinds, changed: d.transcriptChanged,
    log: (msg, err) => err === undefined ? console.log(msg) : console.warn(msg, err),
    squeeze: (input, out) => new Promise((resolve, reject) => {
      execFile(audioHelperPath(), ['squeeze', '--out', out, input], { timeout: 30 * 60_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr).trim() || error.message))
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop() ?? '')) } catch (e) { reject(e) }
      })
    }),
  })

  const state = (): TeamState => session.state()
  const meeting = (id: unknown): TeamMeetingState => getQueue().meetingState(String(id))

  ipcMain.handle('yogurtTeam:state', () => state())
  ipcMain.handle('yogurtTeam:setServerUrl', (_e, url: unknown) => { session.setServerUrl(String(url ?? '')); return state() })
  ipcMain.handle('yogurtTeam:signIn', () => session.signIn())
  ipcMain.handle('yogurtTeam:cancelSignIn', () => session.cancelSignIn())
  ipcMain.handle('yogurtTeam:signOut', () => session.signOut())
  ipcMain.handle('yogurtTeam:refresh', async () => { await session.me({ fresh: true }); return state() })
  ipcMain.handle('yogurtTeam:openAdmin', async () => {
    const server = session.serverUrl()
    if (server && session.cachedMe()?.user.isAdmin) await shell.openExternal(`${server}/admin`)
  })
  ipcMain.handle('yogurtTeam:meeting', (_e, id: unknown) => meeting(id))
  ipcMain.handle('yogurtTeam:setPrivate', (_e, id: unknown, on: unknown) => { if (typeof id === 'string') getQueue().setPrivate(id, on === true); return meeting(id) })
  ipcMain.handle('yogurtTeam:retry', (_e, id: unknown) => { if (typeof id === 'string') getQueue().retry(id); return meeting(id) })
  ipcMain.handle('yogurtTeam:openFolder', async (_e, id: unknown) => {
    const url = typeof id === 'string' ? getQueue().folderUrl(id) : undefined
    if (httpUrl(url)) await shell.openExternal(url)
  })

  // after the rest of startup has run (the hook is called before upstream defines some of what deps read)
  setImmediate(() => {
    getQueue().start()
    if (session.signedIn()) void session.me({ fresh: true })
  })

  return {
    /**
     * Upstream's `summarized` hook, in place of its direct removeRecording(id, true): queues the upload and
     * deletes the recording now or once its audio is sent.
     */
    summarized(id: string) { getQueue().summarized(id) },
    /**
     * After Whisper's transcript is finished: the team's transcription service writes the meeting's transcript
     * (each track sent on its own) before names and notes are worked out. Resolves either way; never throws.
     */
    transcribe(id: string): Promise<boolean> { return remote.finish(id) },
    stop() { queue?.stop() },
  }
}
