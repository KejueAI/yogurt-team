/** Yogurt Team: the Team section of Settings (one line in screens/Settings.tsx). English only, fork-owned. */
import { useCallback, useEffect, useState } from 'react'
import type { TeamState } from '../../../main/team/types'
import './team.css'

export function TeamSettings() {
  const [s, setS] = useState<TeamState | null>(null)
  const [server, setServer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => window.yogurtTeam.state().then(v => { setS(v); setServer(v.serverUrl) }), [])
  useEffect(() => {
    if (!window.yogurtTeam) return // no bridge (renderer tests)
    void load()
    void window.yogurtTeam.refresh().then(setS).catch(() => {})
    return window.yogurtTeam.onChange(() => { void window.yogurtTeam.state().then(setS) })
  }, [load])
  if (!s) return null

  const saveServer = async () => {
    setError(null)
    try { const v = await window.yogurtTeam.setServerUrl(server); setS(v); setServer(v.serverUrl) } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)) }
  }
  const signIn = async () => {
    setError(null)
    const r = await window.yogurtTeam.signIn()
    if (!r.ok && r.error) setError(r.error)
    void load()
  }

  return (
    <>
      <h2 className="settings-section-heading">Team</h2>
      <div className="settings-group" data-testid="team-settings">
        <div className="settings-row">
          <div className="settings-row-copy">
            <p className="settings-label">{s.signedIn && s.user ? `Signed in as ${s.user.name || s.user.email}` : 'Not signed in'}</p>
            <p className="settings-description">
              {s.signedIn && s.user
                ? `${s.user.email}${s.user.isAdmin ? ' · admin' : ''}`
                : 'Sign in with your work account to share meeting notes, transcripts and recordings with your team.'}
            </p>
            {error && <p className="team-error" role="alert">{error}</p>}
          </div>
          {s.signedIn
            ? <button className="workspace-button settings-action" onClick={() => void window.yogurtTeam.signOut()}>Sign out</button>
            : s.signingIn
              ? <button className="workspace-button settings-action" onClick={() => void window.yogurtTeam.cancelSignIn()}>Cancel sign-in</button>
              : <button className="workspace-button settings-action primary" disabled={!s.serverUrl} onClick={() => void signIn()}>Sign in…</button>}
        </div>
        {s.signedIn && s.team && (
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{s.team.name || 'Your team'}</p>
              <ul className="team-facts">
                <li>{s.team.driveConnected ? 'Google Drive connected' : 'Google Drive not connected yet: uploads wait until an admin connects it'}</li>
                <li>Shared: {[s.team.uploadNotes && 'notes', s.team.uploadTranscript && 'transcripts', s.team.uploadAudio && 'recordings'].filter(Boolean).join(', ') || 'nothing'}</li>
                <li>Meetings are shared {s.team.graceMinutes} minutes after their summary, unless marked private</li>
                <li>Summaries: {s.team.summariesEnabled ? 'written by the team’s AI service' : 'written on this computer'}</li>
              </ul>
              {s.meError && <p className="team-error">Couldn’t reach the team server: {s.meError}</p>}
            </div>
            {s.user?.isAdmin && <button className="workspace-button settings-action" onClick={() => void window.yogurtTeam.openAdmin()}>Open admin page</button>}
          </div>
        )}
        <div className="settings-row">
          <div className="settings-row-copy">
            <p className="settings-label">Team server</p>
            <p className="settings-description">Changing it signs you out.</p>
            <div className="team-server-row">
              <input className="team-input" value={server} placeholder={s.defaultServerUrl || 'https://'} spellCheck={false}
                onChange={e => setServer(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void saveServer() }} aria-label="Team server" />
              {server.trim() !== s.serverUrl && <button className="workspace-button settings-action" onClick={() => void saveServer()}>Save</button>}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
