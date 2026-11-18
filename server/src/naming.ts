export interface NamingContext {
  title: string
  startedAt: Date
  timezone: string
  recorderName?: string | null
  recorderEmail?: string
  kind?: string
}

export const PLACEHOLDERS = ['date', 'time', 'title', 'recorder', 'recorderFull', 'email', 'kind'] as const

function dateParts(date: Date, timeZone: string): { date: string; time: string } {
  let tz = timeZone
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  } catch {
    tz = 'UTC'
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}.${parts.minute}` }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function firstName(name: string | null | undefined, email: string | undefined): string {
  const n = name?.trim()
  if (n) return n.split(/\s+/)[0]!
  const local = email?.split('@')[0] ?? 'Someone'
  return local.charAt(0).toUpperCase() + local.slice(1)
}

/** Drive allows almost any name; keep it to one tidy line of reasonable length. */
export function cleanName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'Untitled').slice(0, 200)
}

/**
 * Fills `{date}`, `{time}`, `{title}`, `{recorder}` (first name), `{recorderFull}`, `{email}` and
 * `{kind}`. Unknown placeholders are left as written so typos are visible on the admin page.
 */
export function renderPattern(pattern: string, ctx: NamingContext): string {
  const { date, time } = dateParts(ctx.startedAt, ctx.timezone)
  const values: Record<string, string> = {
    date,
    time,
    title: ctx.title.trim() || 'Untitled meeting',
    recorder: firstName(ctx.recorderName, ctx.recorderEmail),
    recorderFull: ctx.recorderName?.trim() || ctx.recorderEmail || '',
    email: ctx.recorderEmail ?? '',
    kind: ctx.kind ?? '',
  }
  return cleanName(pattern.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? values[key]! : m)))
}

/** Audio file names keep the uploaded file's extension: "Youssef – me.m4a". */
export function withExtension(name: string, fileName: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]
  return ext ? `${name}.${ext.toLowerCase()}` : name
}

export function validatePattern(pattern: string): string | null {
  if (!pattern.trim()) return 'The pattern cannot be empty.'
  if (pattern.length > 200) return 'The pattern is too long.'
  const unknown = [...pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => !(PLACEHOLDERS as readonly string[]).includes(k))
  if (unknown.length) return `Unknown placeholder: {${unknown[0]}}`
  return null
}
