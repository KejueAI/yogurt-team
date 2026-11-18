# Yogurt Team server

The team server for Yogurt Team. It signs desktop users in with Google (Workspace domain plus allowlist), stores meeting notes, transcripts and audio in a Shared Drive folder the admin picks, proxies summaries to OpenRouter, and serves a small admin site at `/admin`.

The contract with the desktop app is [`API.md`](./API.md).

Stack: Node 24, TypeScript, [Hono](https://hono.dev), Postgres via `pg`, plain SQL migrations in `migrations/` (run at startup), Google REST APIs via `fetch`, server-rendered admin HTML.

This folder is **not** part of the root pnpm workspace. It has its own `package.json` and `pnpm-lock.yaml`.

## Layout

```
server/
  API.md                   contract with the desktop app
  Dockerfile               multi-stage, non-root, listens on $PORT (8080)
  northflank-template.json Northflank template (project + Postgres + service)
  migrations/              plain SQL, applied in order at startup
  src/
    index.ts               entry: config, migrations, HTTP server
    app.ts                 routes + /healthz
    config.ts              env vars
    db.ts                  pool, migration runner
    crypto.ts              AES-256-GCM, token hashing, HMAC
    access.ts              domain/allowlist checks
    auth.ts                users, one-time codes, sessions, OAuth state
    google.ts              Google OAuth + Drive REST client
    settings.ts            team settings + encrypted secrets
    naming.ts              {date} {title} / {title} – {recorder} – {kind} patterns
    matching.ts            meeting folder matching
    markdown.ts            markdown → HTML for Google Docs import
    uploads.ts             upload/complete/delete logic
    llm.ts                 OpenRouter call + SSE re-emission
    routes/                auth, desktop API, (admin in admin/)
    admin/                 admin pages
  test/                    vitest
```

## Local development

Requirements: Node 24+, Docker (for Postgres).

```sh
cd server
corepack pnpm install --ignore-workspace
docker run -d --name ytpg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=yt -p 55432:5432 postgres:17-alpine
cp .env.example .env    # then fill it in
set -a; . ./.env; set +a
corepack pnpm dev       # http://localhost:8080
```

For local Google sign-in, add `http://localhost:8080/auth/google/callback` and `http://localhost:8080/auth/drive/callback` as redirect URIs on the OAuth client (see below).

Checks:

```sh
corepack pnpm typecheck
corepack pnpm test                                                        # unit tests
TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/yt corepack pnpm test   # + Postgres integration tests
```

The integration tests **drop and recreate the `public` schema** of `TEST_DATABASE_URL`. Point them at a throwaway database.

Build and run the image:

```sh
docker build -t yogurt-team-server .
docker run --rm -p 8080:8080 --env-file .env -e DATABASE_URL=postgres://postgres:pw@host.docker.internal:55432/yt yogurt-team-server
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. SSL is used only when it contains `sslmode=require`. |
| `PUBLIC_URL` | yes | Public base URL, e.g. `https://team.example.com`. Used for OAuth redirect URIs and the admin cookie's `Secure` flag. |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID (Web application). |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret. |
| `SECRET_KEY` | yes | 32+ characters. Encrypts the Drive refresh token and OpenRouter key (AES-256-GCM) and signs admin cookies. Changing it disconnects Drive and the admin-set OpenRouter key, and signs admins out. Generate with `openssl rand -base64 48`. |
| `ADMIN_EMAILS` | no | Comma-separated emails that are always admins and can always sign in. Set at least one for the first sign-in. |
| `ALLOWED_DOMAINS` | no | Comma-separated Google Workspace domains allowed to sign in. Admins can change this in the admin UI (the UI value wins once saved). |
| `OPENROUTER_API_KEY` | no | Fallback OpenRouter key. A key set in the admin UI takes precedence. |
| `OPENROUTER_MODEL` | no | Fallback model, default `openrouter/auto`. The admin UI value wins. |
| `PORT` | no | HTTP port, default `8080`. |

Access rule: a Google account may sign in if its email is verified, it isn't blocked, and it is in `ADMIN_EMAILS`, in the allowlist, or on an allowed domain.

## Google Cloud setup

1. In the [Google Cloud console](https://console.cloud.google.com), create (or pick) a project in your Workspace organisation.
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding/Audience): user type **Internal**. Internal means only accounts in your Workspace can sign in and the Drive scope needs no Google verification.
4. **Data access / Scopes**: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and `https://www.googleapis.com/auth/drive`.
5. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URIs:
   - `<PUBLIC_URL>/auth/google/callback` (sign-in for desktop and admin)
   - `<PUBLIC_URL>/auth/drive/callback` (admin connects Drive)
6. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Then sign in at `<PUBLIC_URL>/admin` with an `ADMIN_EMAILS` account, open **Drive → Connect Google Drive**, approve, and pick a folder inside a Shared Drive. The connecting account must be able to add files there (Content manager or above). Drive access uses offline access with `prompt=consent`, so a refresh token is always issued; it is stored encrypted.

## How uploads work

1. The app `POST /api/uploads`. The server finds or creates the meeting folder (same `calendarEventId`, or with no event, same title and a start within 10 minutes), then creates or replaces the recorder's Notes and Transcript Google Docs. Markdown is converted to HTML on the server and uploaded as `text/html` for Google to convert, which formats more predictably than Drive's markdown import.
2. For each audio track, the server opens a Drive resumable upload session (parent = meeting folder) and returns its URL. The app PUTs the bytes to it with no extra auth.
3. The app `POST /api/uploads/:id/complete`. The server then deletes the recorder's previous file for each track it re-sent. Tracks not re-sent are kept.

Every upload is in the admin **Uploads** log.

## Deploying to Northflank

You can import `northflank-template.json` (Templates → Import) or set it up by hand:

1. **Project**: create a project in your preferred region.
2. **Addon**: add a **PostgreSQL** addon (version 17). Nothing needs to be public.
3. **Service**: create a **Combined service** (build + deploy):
   - Repository: `KejueAI/yogurt-team`, branch `main`.
   - Build type **Dockerfile**, build context `/server`, Dockerfile path `/server/Dockerfile`.
   - Port `8080`, protocol HTTP, **public**. Health check: HTTP `GET /healthz` on 8080.
   - Resources: the smallest plan is enough to start.
4. **Environment**:
   - Link the Postgres addon's connection string to `DATABASE_URL` (Addon → Connection details → "Link to service" / secret group, using the `POSTGRES_URI` (internal) connection string).
   - Set `PUBLIC_URL` to the service's public URL (or your custom domain), and `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SECRET_KEY`, `ADMIN_EMAILS`, `ALLOWED_DOMAINS` as secrets.
5. Add the two redirect URIs for that `PUBLIC_URL` to the Google OAuth client.
6. Deploy. Migrations run at startup. Visit `<PUBLIC_URL>/healthz`, then `<PUBLIC_URL>/admin`.

Point the desktop app at `PUBLIC_URL`.

## Security notes

- Desktop and admin session tokens are random 256-bit values; only their SHA-256 hashes are stored. One-time sign-in codes last 5 minutes and work once.
- The Drive refresh token and admin OpenRouter key are AES-256-GCM encrypted with a key derived from `SECRET_KEY`. The admin UI never shows the OpenRouter key.
- Admin pages use an HMAC-signed, HttpOnly, SameSite=Lax cookie and reject cross-origin form posts.
- Resumable upload URLs are bearer capabilities for one file; they expire after about a week.
