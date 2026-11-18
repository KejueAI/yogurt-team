export interface MeetingCandidate {
  id: number
  calendarEventId: string | null
  title: string
  startedAt: Date
}

export interface MeetingKey {
  calendarEventId?: string | null
  title: string
  startedAt: Date
}

export const TITLE_MATCH_WINDOW_MS = 10 * 60 * 1000
/**
 * A calendar event id alone could be a recurring series id shared by every occurrence,
 * so an id match also needs the starts to fall within the same day.
 */
export const EVENT_MATCH_WINDOW_MS = 18 * 60 * 60 * 1000

export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Picks the meeting folder an upload belongs in:
 * 1. same calendar event id (and same day), else
 * 2. same title (case and spacing ignored) with starts within 10 minutes, among meetings that do
 *    not carry a different calendar event id.
 * The closest start wins a tie.
 */
export function matchMeeting<T extends MeetingCandidate>(candidates: T[], key: MeetingKey): T | null {
  const eventId = key.calendarEventId?.trim() || null
  const start = key.startedAt.getTime()
  const byCloseness = (a: T, b: T) => Math.abs(a.startedAt.getTime() - start) - Math.abs(b.startedAt.getTime() - start)

  if (eventId) {
    const byEvent = candidates
      .filter((c) => c.calendarEventId === eventId && Math.abs(c.startedAt.getTime() - start) <= EVENT_MATCH_WINDOW_MS)
      .sort(byCloseness)
    if (byEvent[0]) return byEvent[0]
  }

  const title = normalizeTitle(key.title)
  const byTitle = candidates
    .filter(
      (c) =>
        normalizeTitle(c.title) === title &&
        Math.abs(c.startedAt.getTime() - start) <= TITLE_MATCH_WINDOW_MS &&
        (!eventId || !c.calendarEventId),
    )
    .sort(byCloseness)
  return byTitle[0] ?? null
}
