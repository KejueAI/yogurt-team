# Yogurt Team fork notes

Yogurt Team is a permanent fork of [FrigadeHQ/yogurt](https://github.com/FrigadeHQ/yogurt). Upstream changes are merged in daily by `.github/workflows/upstream-sync.yml`, which opens a pull request.

To keep merges painless, fork code lives in its own files and folders. When a merge conflicts, the conflict will be in one of the upstream files listed below.

## Fork-only files and folders

- `PLAN.md`, `FORK.md`
- `.github/workflows/upstream-sync.yml`
- `server/` (the team server: sign-in, Drive, admin page, summaries)
- `app/src/main/team/` (desktop: sign-in, upload, OpenRouter summaries)
- `app/src/renderer/src/team/` (desktop UI for team features)

## Upstream files the fork edits

| File | Change |
|---|---|
| `app/electron-builder.yml` | App ID `co.kejue.yogurtteam`, product name "Yogurt Team", update feed points at this repo, permission text no longer says "Nothing leaves your Mac", Windows executable name pinned to `Yogurt`, disk image title |
| `app/src/main/index.ts` | `app.setName('Yogurt Team')`, Windows AppUserModelId |
| `app/src/main/paths.ts` | Data folder `Yogurt Team` |
| `app/test/paths.test.ts` | Expects the `Yogurt Team` data folder |
| `app/scripts/release-mac.sh` | Checks the new bundle identifier and the `Yogurt Team.app` path |
| `.github/workflows/release.yml` | `Yogurt Team.app` paths; repo variable `ALLOW_UNSIGNED_MAC=true` allows pilot releases without Apple secrets; without a certificate the Mac app is ad-hoc signed with hardened runtime off |

## Merge rules

- Never take upstream's version of the lines above; re-apply the fork's values.
- `app/package.json` keeps upstream's version with a `-team.N` suffix.
