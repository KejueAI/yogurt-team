import { describe, expect, it } from 'vitest'
import { ensureParents } from '../src/uploads.js'

type F = { id: string; name: string; parent: string; appProperties?: Record<string, string> }

function fakeDrive() {
  const files: F[] = []
  return {
    files,
    async createFolder(name: string, parent: string, appProperties?: Record<string, string>) {
      const f = { id: `f${files.length + 1}`, name, parent, appProperties }
      files.push(f)
      return { id: f.id, name }
    },
    async findByAppProperty(parent: string, key: string, value: string) {
      return files.filter((f) => f.parent === parent && f.appProperties?.[key] === value).map((f) => ({ id: f.id, name: f.name }))
    },
  }
}

describe('date folders', () => {
  it('creates year and month folders once and reuses them', async () => {
    const drive = fakeDrive()
    const a = await ensureParents(drive as never, 'root', ['2026', '11 November'])
    const b = await ensureParents(drive as never, 'root', ['2026', '11 November'])
    const c = await ensureParents(drive as never, 'root', ['2026', '12 December'])
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(drive.files.map((f) => `${f.parent}>${f.name}`)).toEqual(['root>2026', 'f1>11 November', 'f1>12 December'])
  })
  it('finds a grouping folder someone renamed', async () => {
    const drive = fakeDrive()
    const id = await ensureParents(drive as never, 'root', ['2026'])
    drive.files[0]!.name = '2026 (archive)'
    expect(await ensureParents(drive as never, 'root', ['2026'])).toBe(id)
  })
  it('with no grouping levels the meeting goes in the root', async () => {
    expect(await ensureParents(fakeDrive() as never, 'root', [])).toBe('root')
  })
})
