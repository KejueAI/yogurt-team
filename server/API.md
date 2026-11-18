# Yogurt Team server API

The contract between the desktop app (`app/src/main/team/`) and the server (`server/`). Both sides build against this file; change it here first.

All JSON. The desktop authenticates with `Authorization: Bearer <session token>`. Errors are `{ "error": "<code>", "message": "<text>" }` with a 4xx/5xx status. Codes the app handles: `unauthorized` (401: sign in again), `forbidden` (403: not allowed on this team), `not_configured` (409: admin hasn't connected Drive or set a key yet).

## Sign-in (desktop)

1. App starts a loopback HTTP listener on `127.0.0.1:<port>` and opens the system browser at
   `GET /auth/desktop/start?port=<port>&state=<random>`.
2. Server sends the browser through Google sign-in (scopes `openid email profile` only). It checks the email's domain against the allowed domains (and the allowlist/blocklist) on callback.
3. Server redirects the browser to `http://127.0.0.1:<port>/callback?code=<one-time code>&state=<state>` (or `?error=<code>&state=<state>`).
4. App calls `POST /api/desktop/exchange` `{ code }` → `{ token, user: { email, name, picture, isAdmin } }`. Codes expire after 5 minutes and work once.

`GET /api/me` → `{ user, team: { name, driveConnected, summariesEnabled, uploadAudio, uploadTranscript, uploadNotes, graceMinutes } }`.

`POST /api/desktop/signout` revokes the token.

## Upload

Uploads are keyed by `(meetingKey, recorder email)` and **replace** earlier files for the same key; calling twice is safe.

`POST /api/uploads` creates or updates the meeting's folder and the recorder's Google Docs.

```json
{
  "meetingId": "local yogurt meeting id",
  "calendarEventId": "optional, from the calendar binding",
  "title": "Launch planning",
  "startedAt": "2026-11-18T15:00:00Z",
  "endedAt": "2026-11-18T15:45:00Z",
  "attendees": ["a@kejue.co"],
  "notesMarkdown": "# ...",
  "transcriptMarkdown": "# ...",
  "audio": [{ "track": "me", "fileName": "me.m4a", "mimeType": "audio/mp4", "size": 1234567 }]
}
```

→ `{ uploadId, folderUrl, audio: [{ track, uploadUrl }] }`

Meetings with the same `calendarEventId`, or (when absent) the same title and start time within 10 minutes, share one folder. The server skips files the admin turned off; `audio` in the response then lists only tracks to upload.

The app `PUT`s each audio file's bytes straight to its `uploadUrl` (a Google resumable upload session; `Content-Length` must match `size`), then calls
`POST /api/uploads/:uploadId/complete` `{ audio: [{ track, ok, error? }] }`.

`DELETE /api/uploads/by-meeting/:meetingId` removes the recorder's files for a meeting (marking it private after it uploaded).

## Summaries (OpenRouter)

`POST /api/llm/chat` streams a chat completion through OpenRouter using the admin's key and model. Body: `{ messages: [{ role, content }], maxTokens?, temperature?, purpose: "summary" | "title" | "chat" | "other" }`. The response is `text/event-stream` with `data: {"delta":"..."}` lines and a final `data: {"done":true}`; an error mid-stream is `data: {"error":"..."}`.
Returns `not_configured` when no key is set; the app then uses its local model.

## Admin (web, cookie session; admins only)

Pages under `/admin`. Bootstrapped by `ADMIN_EMAILS` (comma-separated).

- Drive: connect Drive (admin OAuth, Drive scope, offline), pick a Shared Drive folder.
- Members: everyone who has signed in, last seen, remove (revokes tokens), make or remove admin. Allowed domains and an extra-emails allowlist.
- Uploads: log of every upload with recorder, meeting, status, error, link.
- Naming and contents: folder name pattern (default `{date} {title}`), file name pattern (default `{recorder} – {kind}`), toggles for audio, transcript, notes, grace period minutes.
- Summaries: OpenRouter key (write-only in the UI) and model.

## Server environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres |
| `PUBLIC_URL` | e.g. `https://yogurt.example.com` (OAuth redirects use it) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (Web application) |
| `ADMIN_EMAILS` | Comma-separated initial admins |
| `ALLOWED_DOMAINS` | Comma-separated, initial allowed sign-in domains (editable later) |
| `SECRET_KEY` | 32+ random bytes; encrypts stored Google refresh tokens and the OpenRouter key; signs cookies |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Optional; the admin page can set them instead |

Redirect URIs to register on the OAuth client: `<PUBLIC_URL>/auth/google/callback` (sign-in) and `<PUBLIC_URL>/auth/drive/callback` (admin Drive connect).

## Contract notes

Added by the server implementation. Nothing above was changed; these pin down details the contract leaves open.

- Error codes beyond the three listed: `bad_request` (400, invalid body or params), `not_found` (404, unknown upload id or one that belongs to another recorder), `upstream_error` (502, Google Drive or OpenRouter failed), `internal` (500). The app should treat any unknown code as a generic failure and show `message`.
- `GET /auth/desktop/start` error values sent to the loopback callback: `cancelled` (user backed out of Google), `forbidden` (domain/allowlist/blocked), `failed` (anything else). An invalid `port` (outside 1024–65535) or `state` gets a 400 HTML page instead, because there is nowhere safe to redirect.
- `POST /api/uploads/:uploadId/complete` returns `{ "uploadId": "...", "status": "complete" | "failed" }`. `DELETE /api/uploads/by-meeting/:meetingId` returns `{ "deleted": <number of Drive files removed> }` and is a no-op (`deleted: 0`) when nothing was uploaded.
- `POST /api/llm/chat` failures before the stream starts (no key, OpenRouter rejects the request) are normal JSON errors (`not_configured` 409, `upstream_error` 502) with a non-SSE content type; the app should check `response.ok` before reading the stream.
- Audio `uploadUrl` is a Google resumable session created for exactly `size` bytes. Send one `PUT` with `Content-Length: size` (a `Content-Type` equal to the declared `mimeType` is fine but not required). Google returns 200/201 on success; a different byte count fails. Sessions expire after about a week, so call `/complete` right after the PUTs, and re-run `POST /api/uploads` to get fresh URLs for a retry.
- Meeting matching by `calendarEventId` is limited to meetings starting within 18 hours of each other, so a recurring series that reuses one event id does not collapse into a single folder. Title matching is case/whitespace-insensitive.
- Re-uploading with `audio: []` keeps previously uploaded audio for that recorder; it is not treated as "delete audio".
