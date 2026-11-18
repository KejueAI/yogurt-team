# Yogurt Team fork notes

Yogurt Team is a permanent fork of [FrigadeHQ/yogurt](https://github.com/FrigadeHQ/yogurt). Upstream changes are merged daily by `.github/workflows/upstream-sync.yml` into the `upstream-sync` branch, which opens a pull request (or, where the organization forbids that, an issue linking to one).

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
| `app/src/main/index.ts` | `app.setName('Yogurt Team')`, Windows AppUserModelId; `hookTeam(...)` before `hookNotes`, whose `summarized` hands the meeting to the team upload queue (which runs upstream's recording deletion once the audio is uploaded); wraps the notes model with `createTeamNotes` (team/llm.ts) using `teamSession`, so the notes queue and Ask don't wait for a local model while the team server writes notes |
| `app/src/main/paths.ts` | Data folder `Yogurt Team` |
| `app/test/paths.test.ts` | Expects the `Yogurt Team` data folder |
| `app/scripts/release-mac.sh` | Checks the new bundle identifier and the `Yogurt Team.app` path |
| `.github/workflows/preview.yml` | Top-level env `MAIN_VITE_YOGURT_TEAM_SERVER` from repo variable `YOGURT_TEAM_SERVER` |
| `.github/workflows/release.yml` | Top-level env `MAIN_VITE_YOGURT_TEAM_SERVER` from repo variable `YOGURT_TEAM_SERVER`; `Yogurt Team.app` paths; repo variable `ALLOW_UNSIGNED_MAC=true` allows pilot releases without Apple secrets; without a certificate the Mac app is ad-hoc signed with hardened runtime off |
| `app/src/preload/index.ts` | `import './team'`, which exposes `window.yogurtTeam` |
| `app/src/renderer/src/screens/Settings.tsx` | `<TeamSettings />` section |
| `app/src/renderer/src/screens/Note.tsx` | `<TeamMeeting />` private toggle and upload status in the note's metadata row |
| `app/test/catalog.test.ts` | Network allowlist includes `main/team/api.ts`, `signIn.ts`, `uploads.ts`, `llm.ts` |
| `app/src/main/notes/enhance.ts` | Optional `Llm.partTokens` so the cloud model (team/llm.ts) splits long meetings into bigger parts |
| `app/src/main/setup.ts` | `remoteNotes` dep: when the team server writes notes, skip the notes model download (speech and embedding still download); `startLocalNotes()` resumes it |

## Merge rules

- Never take upstream's version of the lines above; re-apply the fork's values.
- `app/package.json` keeps upstream's version with a `-team.N` suffix.
