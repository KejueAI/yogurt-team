# Yogurt Team: plan

Yogurt Team is a fork of [FrigadeHQ/yogurt](https://github.com/FrigadeHQ/yogurt) that adds a standard team record of meetings. Teammates sign in with Google and record as usual; each meeting's audio, transcript and notes then land in a shared Google Drive folder chosen by an admin.

Status: plan agreed 2026-11-18. The fork exists at `Youssef-Abdelsalam-2005/yogurt-team` with `upstream` pointing at FrigadeHQ/yogurt. Nothing else is built yet.

## Goals

- One standard way for the team to record meetings, with recordings, transcripts and notes in Google Drive.
- Google sign-in for teammates.
- An admin page, open to admins only, that controls where files go and who has access.
- Open source and easy for another team to set up.
- Keep pulling updates from upstream Yogurt.

## Decisions

| Area | Decision |
|---|---|
| Base | Public GitHub fork of yogurt (MIT). Treated as a permanent fork: upstream is local-only and account-free, so it is unlikely to take team features. |
| Architecture | Desktop app plus one small self-hosted server. |
| Hosting | Northflank, using the `northflank` CLI. Postgres addon for storage. |
| Team | All on the `kejue.co` Google Workspace. Apple Silicon Macs and Windows; Linux builds kept; no Intel Macs. |
| Sign-in | Google sign-in in the system browser, restricted to an allowed domain. Identity only: teammates grant no Drive access. |
| Admin | Bootstrapped from an `ADMIN_EMAILS` environment variable (first admin: youssef@kejue.co). Admins can add other admins. |
| Drive home | A Shared Drive folder, picked by the admin. Files belong to the organisation, not a person. |
| Upload policy | Automatic once the summary is ready, unless the recorder marks the meeting private. |
| Visibility | Everyone with access to the Drive folder sees everything. |
| File format | Notes and transcript as Google Docs (one-way). Audio as recorded: two tracks, the recorder's mic and the other side. |
| Duplicates | One folder per meeting, matched by calendar event. Each recorder's files sit inside under their name. |
| Summaries | Through OpenRouter, with the key and model set by the admin and held on the server. No local LLM download; only the transcription models are downloaded. |
| Ask chat | Also through OpenRouter. |
| Recording consent | No extra prompt. |
| Mac signing | Unsigned for the pilot. Apple Developer ID ($99/yr) and notarized builds before teammates install. |
| Windows signing | Unsigned. One SmartScreen click; auto-update still works. |

## How it works

### Sign-in

1. The app opens the server's sign-in page in the system browser.
2. The teammate signs in with Google. The server checks the email's domain against the allowed list.
3. The browser hands a one-time code back to the app on a local port, and the app exchanges it for a session token.
4. The token is stored encrypted with the operating system's keychain (Electron `safeStorage`), in a separate `team.json`.

### Upload

1. Yogurt finishes a meeting's summary. The fork hooks the existing "summary finished" callback.
2. The app waits a short grace period (default 10 minutes) so the recorder can mark the meeting private.
3. The app sends the notes and transcript to the server, which creates or updates the Google Docs in the meeting's folder.
4. For each audio track, the server asks Google for a one-time upload link and passes it to the app. The app uploads the audio straight to Google, so large files never pass through the server.
5. The server records the result in the upload log.

Rules that follow from how yogurt behaves:

- **Uploads replace, never duplicate.** Yogurt can finish a summary more than once per meeting (rewrite, resume, attendee change), so each upload is keyed by meeting and recorder and updates the same files.
- **Audio is not deleted before it is uploaded.** Yogurt can delete audio in the same callback if the user turned "keep recordings" off, so the fork holds that deletion until the upload is confirmed.
- **Failed uploads retry.** A local queue retries when the computer is back online, and the admin log shows anything stuck.

### Drive layout

```
<chosen Shared Drive folder>/
  2026-11-18 Launch planning/
    Youssef – Notes            (Google Doc)
    Youssef – Transcript       (Google Doc)
    Youssef – mic.m4a
    Youssef – others.m4a
    Sara – Notes
    ...
```

Meetings are matched by calendar event. On Windows, where yogurt reads calendars from a private link, the fallback match is title plus start time. The naming pattern is editable on the admin page.

### Summaries

- The app sends the transcript and yogurt's own prompt to the server, which calls OpenRouter and streams the result back.
- Teammates never see the OpenRouter key.
- Setup skips the LLM download and keeps the transcription download.
- If the server has no OpenRouter key, the app falls back to upstream's local models, so another team can run the project without a paid key.

### Admin page

A web page served by the server, open to admins only.

- **Drive:** connect Drive, pick the folder.
- **Members and access:** who has signed in, allowed domains or an allowlist, remove people, add admins.
- **Uploads:** every upload with who, when and whether it succeeded.
- **Naming and contents:** folder and file naming pattern; toggles for audio, transcript and notes.
- **Summaries:** OpenRouter key and model.

## Staying mergeable with upstream

Upstream ships about two releases a day, so the fork keeps its footprint in upstream files as small as possible.

- **Fork code lives in new folders:** `server/`, `app/src/main/team/`, and a renderer `team/` folder with its own CSS and English-only strings.
- **Separate settings:** `team.json`, not new keys in upstream's settings.
- **Separate bridge to the UI:** `window.yogurtTeam`, so upstream's preload types stay untouched.
- **Separate storage:** a fork-owned table or file for upload state, not new columns in upstream's tables.
- **Few edits to upstream files:** one-line hooks only, each listed in `FORK.md`. The main one is in `app/src/main/index.ts`, upstream's most-changed file, so small conflicts there are expected.
- **`server/` is outside the pnpm workspace** with its own lockfile, as upstream's `site/` is, so the root lockfile does not conflict.
- **Daily sync:** a GitHub Action merges `upstream/main` into a pull request and runs CI.
- **Versions:** upstream's version plus a suffix, e.g. `0.3.45-team.1`.

Identity changes, so installed copies never update to upstream builds or collide with an upstream install: app ID, product name, update feed (this repo's GitHub Releases), data folder, and the permission text that currently says "Nothing leaves your Mac".

## Phases

### 1. Fork and identity

- Rename the app, change the app ID and data folder, repoint the updater.
- Reword the permission text.
- Unsigned build running on one Mac.
- Upstream-sync Action and `FORK.md`.

### 2. Server core

- Server skeleton in `server/` (TypeScript, Postgres).
- Google sign-in, domain restriction, admin bootstrap.
- Connect Drive and pick a folder.
- Deploy to Northflank.

### 3. Upload

- Desktop sign-in.
- Upload on summary-ready, private toggle and grace period.
- Retry queue.
- Upload log on the admin page.

### 4. OpenRouter summaries

- Spike: find the cleanest swap point in yogurt's engine layer.
- Route summaries and Ask through the server.
- Skip the LLM download in setup; keep the local fallback.

### 5. Admin controls

- Members and access.
- Naming pattern and content toggles.
- Duplicate grouping by calendar event.

### 6. Release

- Apple Developer ID, notarized Mac builds, auto-update.
- Windows and Linux builds from CI.
- Setup guide and a Northflank template for other teams.

## To verify before relying on it

- **Drive permission scope.** Whether Google's narrow "only files this app creates or is given" scope can create files inside a picked Shared Drive folder. Fallback: a service account added as a member of the Shared Drive.
- **Markdown to Google Docs.** Whether Drive's conversion keeps headings and lists well enough, or the server should upload HTML.
- **OpenRouter swap.** Yogurt's engine and setup code have not been read closely. This may need more than one-line hooks.
- **Shared Drives on kejue.co.** They need Workspace Business Standard or above.
- **Unsigned Mac behaviour.** That permissions reset on each unsigned update is expected from how macOS ties grants to signatures, not yet observed on this app.

## Needs a person

These steps cannot be done from the command line by an agent.

- Create the Google OAuth client in Google Cloud Console (type "Internal" for a Workspace) and provide its ID and secret.
- Provide an OpenRouter API key.
- Enrol in the Apple Developer Program before team rollout.
