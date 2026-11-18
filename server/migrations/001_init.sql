-- Yogurt Team server schema.

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,          -- always lower case
  name          text,
  given_name    text,
  picture       text,
  is_admin      boolean NOT NULL DEFAULT false,
  blocked       boolean NOT NULL DEFAULT false, -- "removed" by an admin
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

-- Desktop bearer tokens and admin cookie sessions. Only SHA-256 hashes are stored.
CREATE TABLE sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('desktop', 'admin')),
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One-time desktop sign-in codes (5 minutes, single use).
CREATE TABLE login_codes (
  code_hash     text PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

-- In-flight Google OAuth requests (sign-in and Drive connect).
CREATE TABLE oauth_states (
  state_hash    text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('desktop', 'admin', 'drive')),
  data          jsonb NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL
);

-- Key/value team settings (patterns, toggles, Drive folder, encrypted secrets).
CREATE TABLE settings (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per meeting folder in Drive. Recorders of the same meeting share it.
CREATE TABLE meetings (
  id                bigserial PRIMARY KEY,
  root_folder_id    text NOT NULL,
  calendar_event_id text,
  title             text NOT NULL,
  started_at        timestamptz NOT NULL,
  folder_id         text NOT NULL,
  folder_name       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_event_idx ON meetings (root_folder_id, calendar_event_id);
CREATE INDEX meetings_start_idx ON meetings (root_folder_id, started_at);

-- One row per (recorder, local meeting): the files currently in Drive for that key.
CREATE TABLE recordings (
  id                  bigserial PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_meeting_id    text NOT NULL,
  meeting_id          bigint REFERENCES meetings(id) ON DELETE SET NULL,
  notes_file_id       text,
  transcript_file_id  text,
  audio_files         jsonb NOT NULL DEFAULT '{}', -- { "<track>": "<drive file id>" }
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_meeting_id)
);

-- The upload log: one row per POST /api/uploads (and per private delete).
CREATE TABLE uploads (
  id              uuid PRIMARY KEY,
  recording_id    bigint NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_title   text NOT NULL,
  folder_id       text,
  status          text NOT NULL CHECK (status IN ('processing', 'awaiting_audio', 'complete', 'failed', 'deleted')),
  error           text,
  audio           jsonb NOT NULL DEFAULT '[]', -- [{ track, fileName, mimeType, size, status, error? }]
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_created_idx ON uploads (created_at DESC);
