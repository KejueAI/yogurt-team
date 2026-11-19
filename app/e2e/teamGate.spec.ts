// Yogurt Team: with a team server set and no one signed in, the app shows only the sign-in screen
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

test('a signed-out copy with a team server opens to Sign in with Google', async () => {
  const app = await electron.launch({ args: [main], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_TEAM_SERVER: 'http://127.0.0.1:9', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-team-gate-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('team-gate')).toBeVisible()
    await expect(page.getByTestId('team-gate-sign-in')).toHaveText('Sign in with Google')
    await expect(page.getByTestId('home')).toHaveCount(0)
    await page.screenshot({ path: join(tmpdir(), 'yogurt-team-gate.png') })
  } finally { await app.close() }
})
