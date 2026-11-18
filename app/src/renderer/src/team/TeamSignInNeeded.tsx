/** Yogurt Team: under a waiting summary, says why when it waits on sign-in (the team server writes summaries). Fork-owned. */
import { useEffect, useState } from 'react'
import type { TeamState } from '../../../main/team/types'

export function TeamSignInNeeded() {
  const [s, setS] = useState<TeamState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!window.yogurtTeam) return // no bridge (renderer tests)
    void window.yogurtTeam.state().then(setS)
    return window.yogurtTeam.onChange(() => { void window.yogurtTeam.state().then(setS) })
  }, [])
  if (!s || !s.serverUrl || s.signedIn) return null
  const signIn = async () => {
    setBusy(true); setError(null)
    try { const r = await window.yogurtTeam.signIn(); if (!r.ok && r.error) setError(r.error) } finally { setBusy(false) }
  }
  return (
    <div data-testid="team-sign-in-needed" role="status" className="mb-6 flex flex-wrap items-center gap-3 text-[15px] text-muted">
      <span>Summaries are written by your team's server. Sign in to write this one.</span>
      <button type="button" className="text-action" disabled={busy} onClick={() => void signIn()}>{busy ? 'Signing in…' : 'Sign in with Google'}</button>
      {error && <span className="text-[13px]">{error}</span>}
    </div>
  )
}
