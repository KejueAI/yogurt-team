import { describe, expect, it } from 'vitest'
import type { Deps } from '../src/context.js'
import { downloadRoutes } from '../src/download.js'

const release = {
  tag_name: 'v0.4.0', published_at: '2026-11-19T12:00:00Z',
  assets: [
    { name: 'Yogurt-mac-arm64.dmg', browser_download_url: 'https://gh.example/mac.dmg', size: 210e6 },
    { name: 'Yogurt-windows-x64.exe', browser_download_url: 'https://gh.example/win.exe', size: 180e6 },
    { name: 'latest.yml', browser_download_url: 'https://gh.example/latest.yml', size: 1 },
  ],
}

function setup(reply: () => Response) {
  let calls = 0
  const fetchImpl = (async () => { calls++; return reply() }) as unknown as typeof fetch
  const deps = { config: { downloadsRepo: 'acme/yt' }, fetchImpl, log: () => {} } as unknown as Deps
  return { app: downloadRoutes(deps), calls: () => calls }
}

describe('download page', () => {
  it('offers the files the latest release has, and says when one is missing', async () => {
    const { app, calls } = setup(() => Response.json(release))
    const body = await (await app.request('/')).text()
    expect(body).toContain('href="/download/mac"')
    expect(body).toContain('href="/download/windows"')
    expect(body).not.toContain('href="/download/linux"')
    expect(body).toContain('Not available yet')
    expect(body).toContain('Version 0.4.0')
    expect(body).toContain('210 MB')
    await app.request('/')
    expect(calls()).toBe(1) // cached
  })

  it('redirects a download to the release file, or to GitHub latest when unknown', async () => {
    const { app } = setup(() => Response.json(release))
    const mac = await app.request('/download/mac')
    expect(mac.status).toBe(302)
    expect(mac.headers.get('location')).toBe('https://gh.example/mac.dmg')
    const linux = await app.request('/download/linux')
    expect(linux.headers.get('location')).toBe('https://github.com/acme/yt/releases/latest/download/Yogurt-linux-x86_64.AppImage')
    expect((await app.request('/download/beos')).status).toBe(404)
  })

  it('still renders when GitHub has no release or fails', async () => {
    const none = setup(() => new Response('{}', { status: 404 }))
    expect(await (await none.app.request('/')).text()).toContain('No release published yet.')
    const down = setup(() => new Response('', { status: 502 }))
    const r = await down.app.request('/')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Not available yet')
  })
})
