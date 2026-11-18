import { describe, expect, it } from 'vitest'
import { matchMeeting, normalizeTitle } from '../src/matching.js'

const t = (iso: string) => new Date(iso)
const candidates = [
  { id: 1, calendarEventId: 'evt-1', title: 'Launch planning', startedAt: t('2026-11-18T10:00:00Z') },
  { id: 2, calendarEventId: null, title: 'Weekly sync', startedAt: t('2026-11-18T14:00:00Z') },
  { id: 3, calendarEventId: 'evt-3', title: 'Weekly sync', startedAt: t('2026-11-18T14:02:00Z') },
]

describe('meeting matching', () => {
  it('matches by calendar event id even with a different title or start', () => {
    expect(matchMeeting(candidates, { calendarEventId: 'evt-1', title: 'Something else', startedAt: t('2026-11-18T10:25:00Z') })?.id).toBe(1)
  })
  it('does not reuse a recurring event folder from another day', () => {
    expect(matchMeeting(candidates, { calendarEventId: 'evt-1', title: 'Launch planning', startedAt: t('2026-11-25T10:00:00Z') })).toBeNull()
  })
  it('falls back to title + start within 10 minutes', () => {
    expect(matchMeeting(candidates, { title: 'weekly  SYNC', startedAt: t('2026-11-18T13:55:00Z') })?.id).toBe(2)
    expect(matchMeeting(candidates, { title: 'Weekly sync', startedAt: t('2026-11-18T14:20:00Z') })).toBeNull()
    expect(matchMeeting(candidates, { title: 'Weekly sync', startedAt: t('2026-11-18T13:51:00Z') })?.id).toBe(2)
  })
  it('picks the closest start when several titles match', () => {
    expect(matchMeeting(candidates, { title: 'Weekly sync', startedAt: t('2026-11-18T14:03:00Z') })?.id).toBe(3)
  })
  it('does not title-match a folder that belongs to a different event', () => {
    const only = [candidates[2]!]
    expect(matchMeeting(only, { calendarEventId: 'evt-other', title: 'Weekly sync', startedAt: t('2026-11-18T14:02:00Z') })).toBeNull()
  })
  it('does not match different titles', () => {
    expect(matchMeeting(candidates, { title: 'Launch', startedAt: t('2026-11-18T10:00:00Z') })).toBeNull()
  })
  it('normalizes titles', () => {
    expect(normalizeTitle('  Weekly   SYNC ')).toBe('weekly sync')
  })
})
