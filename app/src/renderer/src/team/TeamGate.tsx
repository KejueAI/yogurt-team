/**
 * Yogurt Team: with a team server set, the app opens to this screen until someone signs in with their Google account,
 * so every recording belongs to a teammate and reaches the team's Drive. Fork-owned.
 */
import { useEffect, useState } from 'react'
import type { TeamState } from '../../../main/team/types'
import { Layout } from '../screens/Onboarding'
import { WelcomeArt } from '../components/OnboardingArt'

/** undefined while loading; null when there's no bridge (renderer tests) */
export function useTeamState(): TeamState | null | undefined {
  const [s, setS] = useState<TeamState | null>()
  useEffect(() => {
    if (!window.yogurtTeam) { setS(null); return }
    void window.yogurtTeam.state().then(setS, () => setS(null))
    return window.yogurtTeam.onChange(() => { void window.yogurtTeam.state().then(setS) })
  }, [])
  return s
}

/** true when this copy talks to a team server and no one is signed in */
export const teamGateNeeded = (s: TeamState | null | undefined) => !!s && !!s.serverUrl && !s.signedIn

export function TeamGate({ state }: { state: TeamState }) {
  const [error, setError] = useState<string | null>(null)
  const busy = state.signingIn
  const signIn = async () => {
    setError(null)
    const r = await window.yogurtTeam.signIn().catch((e: unknown) => ({ ok: false, error: String(e) }))
    if (!r.ok && r.error) setError(r.error)
  }
  return (
    <Layout testId="team-gate" step="team-sign-in" motionKey="team-gate"
      art={<WelcomeArt />}
      title="Sign in to your team"
      text="Yogurt Team saves your meetings to your team's Google Drive. Sign in with your work Google account to start."
      actions={<>
        <button type="button" data-testid="team-gate-sign-in" onClick={() => void signIn()} disabled={busy} className="ob-button primary no-drag">
          {busy ? 'Waiting for Google…' : 'Sign in with Google'}
        </button>
        {busy && <button type="button" onClick={() => void window.yogurtTeam.cancelSignIn()} className="ob-button quiet no-drag">Cancel</button>}
      </>}
      note={error || state.meError ? <p role="alert" className="ob-note ob-note-error">{error ?? state.meError}</p>
        : busy ? <p role="status" className="ob-note">Finish signing in in your browser, then come back here.</p> : null}
    />
  )
}
