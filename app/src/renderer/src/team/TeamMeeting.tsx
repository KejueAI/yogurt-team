/** Yogurt Team: the Private switch and upload state under a note's title (one line in screens/Note.tsx) */
import { useEffect, useState } from 'react'
import type { TeamMeetingState } from '../../../main/team/types'
import './team.css'

const until = (at: number | null) => {
  if (at == null) return ''
  const min = Math.ceil((at - Date.now()) / 60_000)
  return min <= 1 ? ' in a minute' : ` in ${min} minutes`
}

export function TeamMeeting({ meetingId }: { meetingId: string }) {
  const [s, setS] = useState<TeamMeetingState | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!window.yogurtTeam) return // no bridge (renderer tests)
    let live = true
    const load = () => { void window.yogurtTeam.meeting(meetingId).then(v => { if (live) setS(v) }) }
    load()
    const off = window.yogurtTeam.onChange(load)
    const t = setInterval(() => tick(n => n + 1), 30_000) // the "in N minutes" count
    return () => { live = false; off(); clearInterval(t) }
  }, [meetingId])
  if (!s?.signedIn) return null

  const u = s.upload
  let status: React.ReactNode = null
  if (!s.private && u) {
    if (u.state === 'waiting') status = <span>Shares with your team{until(u.dueAt)}</span>
    else if (u.state === 'uploading') status = <span>Sharing…</span>
    else if (u.state === 'removing') status = <span>Removing from team…</span>
    else if (u.state === 'uploaded') status = <span>Shared · {u.folderUrl
      ? <button className="team-link" onClick={() => void window.yogurtTeam.openFolder(meetingId)}>Open folder</button>
      : null}</span>
    else if (u.state === 'failed') status = <span className="team-failed" title={u.error ?? undefined}>
      Sharing failed{u.dueAt ? `, retrying${until(u.dueAt)}` : ''} · <button className="team-link" onClick={() => void window.yogurtTeam.retry(meetingId).then(setS)}>Retry</button>
    </span>
  } else if (s.private && u?.state === 'removing') status = <span>Removing from team…</span>

  return (
    <span className="team-meeting" data-testid="team-meeting">
      <button className="team-private" aria-pressed={s.private} title={s.private ? 'Only you can see this meeting' : 'Mark private to keep it off the team’s Drive'}
        onClick={() => void window.yogurtTeam.setPrivate(meetingId, !s.private).then(setS)}>
        {s.private ? 'Private' : 'Team'}
      </button>
      {status}
    </span>
  )
}
