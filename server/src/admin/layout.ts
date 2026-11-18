import { escapeHtml } from '../markdown.js'

/** A string that is already safe HTML. */
export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export function raw(value: string): Raw {
  return new Raw(value)
}

type Part = Raw | string | number | boolean | null | undefined | Part[]

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return ''
  if (part instanceof Raw) return part.value
  if (Array.isArray(part)) return part.map(render).join('')
  return escapeHtml(String(part))
}

/** Tagged template that escapes every interpolated value unless it is Raw (or an array of Raw). */
export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = ''
  strings.forEach((s, i) => {
    out += s
    if (i < values.length) out += render(values[i]!)
  })
  return new Raw(out)
}

const STYLES = `
:root {
  --bg: #f7f7f5; --panel: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df;
  --accent: #3b5bdb; --accent-text: #fff; --ok: #2b8a3e; --warn: #b7791f; --bad: #c92a2a;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --panel: #1f1f1d; --text: #ecece8; --muted: #9a9a94; --line: #33332f;
    --accent: #748ffc; --accent-text: #10131f; --ok: #69db7c; --warn: #ffc078; --bad: #ff8787; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
header.top { display: flex; align-items: center; gap: 24px; padding: 14px 24px; border-bottom: 1px solid var(--line);
  background: var(--panel); flex-wrap: wrap; }
header.top .brand { font-weight: 650; }
header.top nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
header.top nav a { text-decoration: none; color: var(--muted); padding: 6px 10px; border-radius: 8px; }
header.top nav a.active { color: var(--text); background: var(--bg); font-weight: 550; }
header.top .who { color: var(--muted); font-size: 13px; display: flex; gap: 10px; align-items: center; }
main { max-width: 980px; margin: 0 auto; padding: 28px 24px 64px; }
h1 { font-size: 22px; margin: 0 0 6px; }
h2 { font-size: 16px; margin: 0 0 12px; }
p.lead { color: var(--muted); margin: 0 0 24px; }
section.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; margin-bottom: 20px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
label { display: block; font-weight: 550; margin: 14px 0 4px; }
label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; margin: 8px 0; }
input[type=text], input[type=password], input[type=number], textarea, select {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
textarea { min-height: 80px; }
.hint { color: var(--muted); font-size: 13px; margin-top: 4px; }
button, .button { display: inline-block; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel);
  color: var(--text); font: inherit; cursor: pointer; text-decoration: none; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.danger { color: var(--bad); }
button.link { border: none; background: none; padding: 0; color: var(--accent); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
form.inline { display: inline; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
.table-wrap { overflow-x: auto; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--ok); border-color: currentColor; }
.badge.warn { color: var(--warn); border-color: currentColor; }
.badge.bad { color: var(--bad); border-color: currentColor; }
.notice { padding: 10px 14px; border-radius: 8px; margin-bottom: 20px; border: 1px solid var(--line); background: var(--panel); }
.notice.ok { border-color: var(--ok); }
.notice.bad { border-color: var(--bad); }
ul.picker { list-style: none; padding: 0; margin: 0; }
ul.picker li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.crumbs { margin-bottom: 12px; font-size: 14px; }
code { font-size: 13px; background: var(--bg); padding: 1px 5px; border-radius: 5px; }
.center { max-width: 460px; margin: 12vh auto; text-align: center; }
`

export const NAV = [
  ['drive', 'Drive', '/admin/drive'],
  ['members', 'Members', '/admin/members'],
  ['uploads', 'Uploads', '/admin/uploads'],
  ['naming', 'Naming and contents', '/admin/naming'],
  ['summaries', 'Summaries', '/admin/summaries'],
] as const

export type Section = (typeof NAV)[number][0]

function shell(title: string, body: Raw): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body>${body.value}</body></html>`
}

export interface Notice {
  kind: 'ok' | 'bad'
  text: string
}

export function page(opts: {
  title: string
  section: Section
  teamName: string
  adminEmail: string
  notice?: Notice | null
  body: Raw
}): string {
  const nav = NAV.map(
    ([key, label, href]) => html`<a href="${href}" class="${key === opts.section ? 'active' : ''}">${label}</a>`,
  )
  return shell(
    `${opts.title} · ${opts.teamName}`,
    html`<header class="top">
  <span class="brand">${opts.teamName}</span>
  <nav>${nav}</nav>
  <span class="who">${opts.adminEmail}
    <form class="inline" method="post" action="/admin/logout"><button class="link" type="submit">Sign out</button></form>
  </span>
</header>
<main>
  ${opts.notice ? html`<div class="notice ${opts.notice.kind}">${opts.notice.text}</div>` : ''}
  ${opts.body}
</main>`,
  )
}

/** A standalone page with a heading and one message (sign-in errors and the like). */
export function messagePage(title: string, message: string, opts: { raw?: boolean } = {}): string {
  return shell(
    title,
    html`<main class="center"><h1>${title}</h1><p class="muted">${opts.raw ? raw(message) : message}</p></main>`,
  )
}

export function formatTime(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
