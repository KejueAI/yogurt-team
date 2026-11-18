import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db, Queryable } from './db.js'
import { withTransaction } from './db.js'
import { GoogleApiError, folderUrl, type DriveClient } from './google.js'
import { matchMeeting, EVENT_MATCH_WINDOW_MS } from './matching.js'
import { markdownToHtml } from './markdown.js'
import { renderFolderPath, renderPattern, withExtension } from './naming.js'
import type { TeamSettings } from './settings.js'
import type { User } from './auth.js'

export type Drive = Pick<
  DriveClient,
  'getFile' | 'createFolder' | 'createDoc' | 'updateDoc' | 'createResumableSession' | 'findByAppProperty' | 'countChildren' | 'deleteFile'
>

export const uploadRequestSchema = z.object({
  meetingId: z.string().min(1).max(200),
  calendarEventId: z.string().max(1024).nullish(),
  title: z.string().max(1000).default(''),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullish(),
  attendees: z.array(z.string()).max(500).default([]),
  notesMarkdown: z.string().max(5_000_000).default(''),
  transcriptMarkdown: z.string().max(20_000_000).default(''),
  audio: z
    .array(
      z.object({
        track: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(255),
        size: z.number().int().positive(),
      }),
    )
    .max(8)
    .default([]),
})
export type UploadRequest = z.infer<typeof uploadRequestSchema>

export const completeRequestSchema = z.object({
  audio: z
    .array(z.object({ track: z.string().min(1), ok: z.boolean(), error: z.string().max(2000).nullish() }))
    .default([]),
})
export type CompleteRequest = z.infer<typeof completeRequestSchema>

export interface AudioEntry {
  track: string
  fileName: string
  mimeType: string
  size: number
  status: 'pending' | 'uploaded' | 'failed'
  error?: string
}

interface RecordingRow {
  id: string
  meeting_id: string | null
  notes_file_id: string | null
  transcript_file_id: string | null
  audio_files: Record<string, string>
}

interface MeetingRow {
  id: string
  calendar_event_id: string | null
  title: string
  started_at: Date
  folder_id: string
  folder_name: string
  root_folder_id: string
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'not_found' | 'upstream_error',
  ) {
    super(message)
  }
}

/** appProperties tag that lets /complete find the audio file the app uploaded. */
export const AUDIO_TAG = 'yogurtTeamAudio'

function describe(err: unknown): string {
  if (err instanceof GoogleApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

async function getRecording(db: Queryable, userId: number, localId: string): Promise<RecordingRow> {
  const { rows } = await db.query<RecordingRow>(
    `INSERT INTO recordings (user_id, local_meeting_id) VALUES ($1, $2)
     ON CONFLICT (user_id, local_meeting_id) DO UPDATE SET updated_at = now()
     RETURNING id, meeting_id, notes_file_id, transcript_file_id, audio_files`,
    [userId, localId],
  )
  return rows[0]!
}

/**
 * Finds the meeting folder for this upload or creates it. The recording's previous meeting
 * wins (so a renamed meeting keeps its folder); otherwise another recorder's folder is matched
 * by calendar event id or by title and start time. Creation is serialised per root folder so
 * two recorders uploading at once end up in the same folder.
 */
export async function resolveMeeting(
  db: Db,
  drive: Drive,
  root: string,
  req: UploadRequest,
  settings: TeamSettings,
  previousMeetingId: string | null,
): Promise<MeetingRow> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meetings:${root}`])
    let meeting: MeetingRow | undefined
    if (previousMeetingId) {
      const { rows } = await tx.query<MeetingRow>('SELECT * FROM meetings WHERE id = $1 AND root_folder_id = $2', [previousMeetingId, root])
      meeting = rows[0]
    }
    if (!meeting) {
      const { rows } = await tx.query<MeetingRow>(
        `SELECT * FROM meetings WHERE root_folder_id = $1 AND started_at BETWEEN $2 AND $3`,
        [root, new Date(req.startedAt.getTime() - EVENT_MATCH_WINDOW_MS), new Date(req.startedAt.getTime() + EVENT_MATCH_WINDOW_MS)],
      )
      const candidates = rows.map((r) => ({ ...r, id: Number(r.id), calendarEventId: r.calendar_event_id, startedAt: r.started_at }))
      const match = matchMeeting(candidates, { calendarEventId: req.calendarEventId, title: req.title, startedAt: req.startedAt })
      meeting = match ? rows.find((r) => Number(r.id) === match.id) : undefined
    }
    if (meeting) {
      // The folder may have been deleted or trashed in Drive since; recreate it if so.
      const existing = await drive.getFile(meeting.folder_id)
      if (existing && !existing.trashed) {
        if (!meeting.calendar_event_id && req.calendarEventId) {
          await tx.query('UPDATE meetings SET calendar_event_id = $2 WHERE id = $1', [meeting.id, req.calendarEventId])
        }
        return meeting
      }
      const path = meeting.folder_name.split('/')
      const parent = await ensureParents(drive, root, path.slice(0, -1))
      const folder = await drive.createFolder(path[path.length - 1]!, parent)
      await tx.query('UPDATE meetings SET folder_id = $2 WHERE id = $1', [meeting.id, folder.id])
      return { ...meeting, folder_id: folder.id }
    }
    const path = renderFolderPath(settings.folderPattern, { title: req.title, startedAt: req.startedAt, timezone: settings.timezone })
    const parent = await ensureParents(drive, root, path.slice(0, -1))
    const folder = await drive.createFolder(path[path.length - 1]!, parent)
    const name = path.join('/')
    const { rows } = await tx.query<MeetingRow>(
      `INSERT INTO meetings (root_folder_id, calendar_event_id, title, started_at, folder_id, folder_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [root, req.calendarEventId || null, req.title || 'Untitled meeting', req.startedAt, folder.id, name],
    )
    return rows[0]!
  })
}

/**
 * Finds or creates the grouping folders (year, month…) above a meeting folder. They are tagged with an
 * appProperty so a folder someone renames by hand is still found. Callers hold the root's advisory lock.
 */
export async function ensureParents(drive: Pick<Drive, 'createFolder' | 'findByAppProperty'>, root: string, names: string[]): Promise<string> {
  let parent = root
  for (const name of names) {
    const [found] = await drive.findByAppProperty(parent, 'yogurtGroup', name)
    parent = found ? found.id : (await drive.createFolder(name, parent, { yogurtGroup: name })).id
  }
  return parent
}

/** Creates the Doc, or replaces the content of the one uploaded before (moving it if needed). */
async function putDoc(drive: Drive, previousId: string | null, name: string, folderId: string, html: string): Promise<string> {
  if (previousId) {
    const prev = await drive.getFile(previousId)
    if (prev && !prev.trashed) {
      const parents = prev.parents ?? []
      const move = parents.includes(folderId) ? undefined : { addParent: folderId, removeParents: parents }
      const updated = await drive.updateDoc(previousId, name, html, move)
      return updated.id
    }
  }
  const created = await drive.createDoc(name, folderId, html)
  return created.id
}

export interface UploadResult {
  uploadId: string
  folderUrl: string
  audio: { track: string; uploadUrl: string }[]
}

export async function startUpload(
  db: Db,
  drive: Drive | null,
  settings: TeamSettings,
  user: User,
  req: UploadRequest,
): Promise<UploadResult> {
  const root = settings.driveFolder?.id
  if (!drive || !root) throw new UploadError('An admin has not connected Google Drive yet.', 'not_configured')

  const recording = await getRecording(db, user.id, req.meetingId)
  const uploadId = randomUUID()
  const wantedAudio = settings.uploadAudio ? req.audio : []
  const audioLog: AudioEntry[] = wantedAudio.map((a) => ({ ...a, status: 'pending' }))
  const title = req.title.trim() || 'Untitled meeting'
  await db.query(
    `INSERT INTO uploads (id, recording_id, user_id, meeting_title, status, audio) VALUES ($1, $2, $3, $4, 'processing', $5)`,
    [uploadId, recording.id, user.id, title, JSON.stringify(audioLog)],
  )

  try {
    const meeting = await resolveMeeting(db, drive, root, req, settings, recording.meeting_id)
    const fileName = (kind: string) =>
      renderPattern(settings.filePattern, {
        title,
        startedAt: req.startedAt,
        timezone: settings.timezone,
        recorderName: user.name,
        recorderEmail: user.email,
        kind,
      })

    let notesId = recording.notes_file_id
    let transcriptId = recording.transcript_file_id
    if (settings.uploadNotes) {
      const name = fileName('Notes')
      notesId = await putDoc(drive, notesId, name, meeting.folder_id, markdownToHtml(req.notesMarkdown, name))
    }
    if (settings.uploadTranscript) {
      const name = fileName('Transcript')
      transcriptId = await putDoc(drive, transcriptId, name, meeting.folder_id, markdownToHtml(req.transcriptMarkdown, name))
    }

    const sessions: { track: string; uploadUrl: string }[] = []
    for (const a of wantedAudio) {
      const uploadUrl = await drive.createResumableSession({
        name: withExtension(fileName(a.track), a.fileName),
        parentId: meeting.folder_id,
        mimeType: a.mimeType,
        size: a.size,
        appProperties: { [AUDIO_TAG]: `${uploadId}:${a.track}` },
      })
      sessions.push({ track: a.track, uploadUrl })
    }

    await db.query(
      `UPDATE recordings SET meeting_id = $2, notes_file_id = $3, transcript_file_id = $4, deleted_at = NULL, updated_at = now() WHERE id = $1`,
      [recording.id, meeting.id, notesId, transcriptId],
    )
    await db.query(`UPDATE uploads SET status = $2, folder_id = $3, updated_at = now() WHERE id = $1`, [
      uploadId,
      sessions.length ? 'awaiting_audio' : 'complete',
      meeting.folder_id,
    ])
    return { uploadId, folderUrl: folderUrl(meeting.folder_id), audio: sessions }
  } catch (err) {
    const message = describe(err)
    await db.query(`UPDATE uploads SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [uploadId, message])
    throw new UploadError(message, 'upstream_error')
  }
}

/**
 * Records which audio tracks reached Drive. Each uploaded track replaces the recorder's
 * earlier file for that track, which is deleted.
 */
export async function completeUpload(
  db: Db,
  drive: Drive | null,
  user: User,
  uploadId: string,
  req: CompleteRequest,
): Promise<{ uploadId: string; status: 'complete' | 'failed' }> {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new UploadError('Upload not found.', 'not_found')
  const { rows } = await db.query<{ recording_id: string; folder_id: string | null; audio: AudioEntry[]; status: string }>(
    'SELECT recording_id, folder_id, audio, status FROM uploads WHERE id = $1 AND user_id = $2',
    [uploadId, user.id],
  )
  const upload = rows[0]
  if (!upload) throw new UploadError('Upload not found.', 'not_found')
  if (!drive) throw new UploadError('An admin has not connected Google Drive yet.', 'not_configured')

  const audio = upload.audio.map((a) => ({ ...a }))
  const errors: string[] = []
  const replaced: Record<string, string> = {}
  for (const entry of audio) {
    const report = req.audio.find((r) => r.track === entry.track)
    if (!report) {
      if (entry.status === 'pending') {
        entry.status = 'failed'
        entry.error = 'The app did not report this track.'
      }
    } else if (!report.ok) {
      entry.status = 'failed'
      entry.error = report.error || 'Upload failed in the app.'
    } else if (upload.folder_id) {
      try {
        const [file] = await drive.findByAppProperty(upload.folder_id, AUDIO_TAG, `${uploadId}:${entry.track}`)
        if (file) {
          replaced[entry.track] = file.id
          entry.status = 'uploaded'
          delete entry.error
        } else {
          entry.status = 'failed'
          entry.error = 'The file is not in Drive.'
        }
      } catch (err) {
        entry.status = 'failed'
        entry.error = describe(err)
      }
    }
    if (entry.status === 'failed') errors.push(`${entry.track}: ${entry.error}`)
  }

  const rec = await db.query<{ audio_files: Record<string, string> }>('SELECT audio_files FROM recordings WHERE id = $1', [
    upload.recording_id,
  ])
  const files = { ...(rec.rows[0]?.audio_files ?? {}) }
  for (const [track, newId] of Object.entries(replaced)) {
    const oldId = files[track]
    if (oldId && oldId !== newId) {
      try {
        await drive.deleteFile(oldId)
      } catch (err) {
        errors.push(`${track}: could not remove the earlier file (${describe(err)})`)
      }
    }
    files[track] = newId
  }
  await db.query('UPDATE recordings SET audio_files = $2, updated_at = now() WHERE id = $1', [upload.recording_id, JSON.stringify(files)])

  const status = audio.every((a) => a.status === 'uploaded') ? 'complete' : 'failed'
  await db.query('UPDATE uploads SET status = $2, error = $3, audio = $4, updated_at = now() WHERE id = $1', [
    uploadId,
    status,
    errors.length ? errors.join('; ') : null,
    JSON.stringify(audio),
  ])
  return { uploadId, status }
}

/** The private-meeting delete: removes the recorder's Docs and audio, and the folder if it ends up empty. */
export async function deleteRecording(
  db: Db,
  drive: Drive | null,
  user: User,
  localMeetingId: string,
): Promise<{ deleted: number }> {
  const { rows } = await db.query<RecordingRow & { title: string | null; folder_id: string | null }>(
    `SELECT r.id, r.meeting_id, r.notes_file_id, r.transcript_file_id, r.audio_files, m.title, m.folder_id
     FROM recordings r LEFT JOIN meetings m ON m.id = r.meeting_id
     WHERE r.user_id = $1 AND r.local_meeting_id = $2`,
    [user.id, localMeetingId],
  )
  const rec = rows[0]
  const fileIds = rec ? [rec.notes_file_id, rec.transcript_file_id, ...Object.values(rec.audio_files ?? {})].filter((x): x is string => !!x) : []
  if (!rec || (!fileIds.length && !rec.meeting_id)) return { deleted: 0 }
  if (!drive) throw new UploadError('An admin has not connected Google Drive yet.', 'not_configured')

  // Audio sessions handed out but never completed may still have produced files; catch them too.
  if (rec.folder_id) {
    const { rows: pending } = await db.query<{ id: string; audio: AudioEntry[] }>(
      `SELECT id, audio FROM uploads WHERE recording_id = $1 AND status IN ('awaiting_audio', 'failed')`,
      [rec.id],
    )
    for (const u of pending) {
      for (const a of u.audio) {
        try {
          for (const f of await drive.findByAppProperty(rec.folder_id, AUDIO_TAG, `${u.id}:${a.track}`)) fileIds.push(f.id)
        } catch {
          // best effort
        }
      }
    }
  }

  let deleted = 0
  const errors: string[] = []
  for (const id of new Set(fileIds)) {
    try {
      const result = await drive.deleteFile(id)
      if (result !== 'missing') deleted++
    } catch (err) {
      errors.push(describe(err))
    }
  }
  if (rec.folder_id && rec.meeting_id && !errors.length) {
    try {
      if ((await drive.countChildren(rec.folder_id)) === 0) {
        await drive.deleteFile(rec.folder_id)
        await db.query('DELETE FROM meetings WHERE id = $1', [rec.meeting_id])
      }
    } catch {
      // leaving an empty folder behind is harmless
    }
  }

  await db.query(
    `UPDATE recordings SET notes_file_id = NULL, transcript_file_id = NULL, audio_files = '{}', meeting_id = NULL, deleted_at = now(), updated_at = now()
     WHERE id = $1`,
    [rec.id],
  )
  await db.query(
    `INSERT INTO uploads (id, recording_id, user_id, meeting_title, folder_id, status, error) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), rec.id, user.id, rec.title ?? 'Meeting', rec.folder_id, errors.length ? 'failed' : 'deleted', errors.join('; ') || null],
  )
  if (errors.length) throw new UploadError(`Some files could not be removed: ${errors.join('; ')}`, 'upstream_error')
  return { deleted }
}
