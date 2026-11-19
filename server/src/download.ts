/**
 * The public download page at "/": the latest release of the desktop app for Mac, Windows and Linux, from the GitHub
 * repo in DOWNLOADS_REPO. Each button links to /download/<os>, which redirects to that release's file, so a click
 * starts the download. Release details are cached for a few minutes so the page never waits on GitHub.
 */
import { Hono } from 'hono'
import type { Deps, Env } from './context.js'
import { html, raw } from './admin/layout.js'

export type Platform = 'mac' | 'windows' | 'linux'
export const ASSETS: Record<Platform, string> = {
  mac: 'Yogurt-mac-arm64.dmg',
  windows: 'Yogurt-windows-x64.exe',
  linux: 'Yogurt-linux-x86_64.AppImage',
}

type Release = { version: string; published: string; assets: Partial<Record<Platform, { url: string; size: number }>> }
const TTL_MS = 5 * 60_000

export function downloadRoutes(deps: Deps): Hono<Env> {
  const r = new Hono<Env>()
  let cache: { at: number; release: Release | null } | null = null

  async function latest(): Promise<Release | null> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.release
    try {
      const res = await deps.fetchImpl(`https://api.github.com/repos/${deps.config.downloadsRepo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yogurt-team-server' },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 404) { cache = { at: Date.now(), release: null }; return null }
      if (!res.ok) throw new Error(`GitHub said ${res.status}`)
      const j = (await res.json()) as { tag_name: string; published_at: string; assets: { name: string; browser_download_url: string; size: number }[] }
      const assets: Release['assets'] = {}
      for (const [os, name] of Object.entries(ASSETS) as [Platform, string][]) {
        const a = j.assets.find((x) => x.name === name)
        if (a) assets[os] = { url: a.browser_download_url, size: a.size }
      }
      cache = { at: Date.now(), release: { version: j.tag_name.replace(/^v/, ''), published: j.published_at, assets } }
      return cache.release
    } catch (e) {
      deps.log('download page: could not read the latest release', { error: (e as Error).message })
      return cache?.release ?? null // keep showing the last good one
    }
  }

  r.get('/', async (c) => c.html(page(await latest(), deps.config.downloadsRepo).value))

  r.get('/download/:os', async (c) => {
    const os = c.req.param('os') as Platform
    if (!(os in ASSETS)) return c.text('Not found', 404)
    const rel = await latest()
    // without release details (GitHub slow or down), GitHub's own latest link still points at the newest file
    const url = rel?.assets[os]?.url ?? `https://github.com/${deps.config.downloadsRepo}/releases/latest/download/${ASSETS[os]}`
    return c.redirect(url, 302)
  })
  return r
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`

const ICONS: Record<Platform, string> = {
  mac: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.7c1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-3.8zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/></svg>',
  windows: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5.5 10.4 4.5v7H3zm8.4-1.1L21 3v8.5h-9.6zM3 12.5h7.4v7L3 18.5zm8.4 0H21V21l-9.6-1.4z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-2.2 0-3.6 1.9-3.6 4.6 0 1.4.4 2.4-.6 3.9-1.2 1.8-2.6 3.8-2.6 6.3 0 .6.1 1.1.3 1.6-.8.4-1.5 1-1.5 1.7 0 1.1 1.6 1.4 3.3 1.6 1 .1 2 .6 3 .6.8 0 1.4-.3 1.7-.8h.1c.3.5.9.8 1.7.8 1 0 2-.5 3-.6 1.7-.2 3.3-.5 3.3-1.6 0-.7-.7-1.3-1.5-1.7.2-.5.3-1 .3-1.6 0-2.5-1.4-4.5-2.6-6.3-1-1.5-.6-2.5-.6-3.9C15.6 3.9 14.2 2 12 2zm-1.3 4c.4 0 .7.5.7 1.1 0 .6-.3 1.1-.7 1.1s-.7-.5-.7-1.1c0-.6.3-1.1.7-1.1zm2.6 0c.4 0 .7.5.7 1.1 0 .6-.3 1.1-.7 1.1s-.7-.5-.7-1.1c0-.6.3-1.1.7-1.1zM12 9.2c.9 0 2 .6 2 1s-1.1 1-2 1-2-.6-2-1 1.1-1 2-1z"/></svg>',
}

const CARDS: { os: Platform; name: string; detail: string; steps: string[] }[] = [
  {
    os: 'mac', name: 'Mac', detail: 'Apple Silicon (M1 or newer) · macOS 14.4+',
    steps: [
      'Open the downloaded file and drag Yogurt Team into Applications.',
      'Open it. If your Mac says it can’t check the app, open System Settings → Privacy & Security, scroll down and click Open Anyway.',
      'Sign in with your work Google account.',
    ],
  },
  {
    os: 'windows', name: 'Windows', detail: 'Windows 10 or 11 · 64-bit',
    steps: [
      'Run the downloaded installer.',
      'If Windows shows “Windows protected your PC”, click More info → Run anyway.',
      'Sign in with your work Google account.',
    ],
  },
  {
    os: 'linux', name: 'Linux', detail: 'x86_64 AppImage',
    steps: [
      'Make the file runnable: chmod +x Yogurt-linux-x86_64.AppImage',
      'Run it, then sign in with your work Google account.',
    ],
  },
]

const STYLES = `
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e4e4df; --accent:#1d1d1b; --accent-text:#fff; --tint:#f1efe8; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1d1d1b; --text:#ecece8; --muted:#9a9a94; --line:#32322e; --accent:#ecece8; --accent-text:#141413; --tint:#252522; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
a { color:inherit; }
.wrap { max-width:1040px; margin:0 auto; padding:0 20px; }
header { display:flex; justify-content:space-between; align-items:center; padding:22px 0; }
.brand { font-weight:700; font-size:18px; letter-spacing:-.01em; display:flex; align-items:center; gap:10px; }
.dot { width:22px; height:22px; border-radius:7px; background:var(--accent); display:inline-block; }
header a.admin { color:var(--muted); text-decoration:none; font-size:14px; }
.hero { padding:56px 0 36px; max-width:680px; }
h1 { font-size:clamp(32px,6vw,52px); line-height:1.05; letter-spacing:-.025em; margin:0 0 16px; }
.hero p { color:var(--muted); font-size:18px; margin:0; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; padding-bottom:28px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:22px; display:flex; flex-direction:column; gap:14px; }
.card.mine { border-color:var(--text); }
.os { display:flex; align-items:center; gap:12px; }
.os svg { width:28px; height:28px; }
.os h2 { margin:0; font-size:20px; }
.os small { display:block; color:var(--muted); font-size:13px; }
.btn { display:flex; justify-content:center; align-items:center; gap:8px; padding:12px 16px; border-radius:11px; background:var(--accent); color:var(--accent-text); text-decoration:none; font-weight:600; }
.btn:hover { opacity:.88; }
.btn.off { background:var(--tint); color:var(--muted); pointer-events:none; }
ol { margin:0; padding-left:20px; color:var(--muted); font-size:14px; }
ol li { margin:4px 0; }
code { font-size:12.5px; background:var(--tint); padding:1px 5px; border-radius:5px; word-break:break-all; }
.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; padding:28px 0 40px; border-top:1px solid var(--line); }
.facts h3 { margin:0 0 4px; font-size:15px; }
.facts p { margin:0; color:var(--muted); font-size:14px; }
footer { color:var(--muted); font-size:13px; padding:20px 0 40px; border-top:1px solid var(--line); display:flex; gap:16px; flex-wrap:wrap; justify-content:space-between; }
`

export function page(rel: Release | null, repo: string) {
  const when = rel ? new Date(rel.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
  return html`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yogurt Team · Download</title><style>${raw(STYLES)}</style></head><body><div class="wrap">
<header><span class="brand"><span class="dot"></span>Yogurt Team</span><a class="admin" href="/admin">Admin</a></header>
<section class="hero"><h1>Meeting notes that file themselves.</h1>
<p>Record a meeting and Yogurt Team writes the transcript and notes, then saves the recording, transcript and notes to the team’s Google Drive.</p></section>
<section class="grid">${CARDS.map((card) => {
    const a = rel?.assets[card.os]
    return html`<div class="card" data-os="${card.os}"><div class="os">${raw(ICONS[card.os])}<div><h2>${card.name}</h2><small>${card.detail}</small></div></div>
${a ? html`<a class="btn" href="/download/${card.os}" download>Download for ${card.name}<span style="opacity:.6;font-weight:500">· ${mb(a.size)}</span></a>`
        : html`<span class="btn off">Not available yet</span>`}
<ol>${card.steps.map((s) => html`<li>${s.includes('chmod') ? html`Make the file runnable: <code>chmod +x ${ASSETS.linux}</code>` : s}</li>`)}</ol></div>`
  })}</section>
<section class="facts">
<div><h3>Sign in with Google</h3><p>Use your work account. Only people in the team’s domain can sign in.</p></div>
<div><h3>Transcribed on your computer</h3><p>A live transcript is written on your machine while you talk; a more accurate one replaces it when the meeting ends.</p></div>
<div><h3>Saved to Drive</h3><p>The recording, transcript and notes land in the team’s shared folder, filed by date.</p></div>
<div><h3>Updates itself</h3><p>Installed copies update automatically when a new version comes out.</p></div>
</section>
<footer><span>${rel ? `Version ${rel.version} · released ${when}` : 'No release published yet.'}</span>
<a href="https://github.com/${repo}">Open source on GitHub</a></footer>
</div><script>
(function(){var u=navigator.userAgent,p=/Mac/.test(u)?'mac':/Win/.test(u)?'windows':/Linux|X11/.test(u)&&!/Android/.test(u)?'linux':null;
if(!p)return;var c=document.querySelector('[data-os="'+p+'"]');if(!c)return;c.classList.add('mine');c.parentNode.insertBefore(c,c.parentNode.firstChild);})();
</script></body></html>`
}
