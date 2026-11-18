/**
 * What a meeting sends to the team: the notes and the transcript as Markdown, built with upstream's export helpers
 * so they read the same as an exported file, and the audio tracks on disk.
 */
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { toMarkdownFile, transcriptDoc } from '../../shared/exportNotes'
import { docToMd, escapeText } from '../../shared/markdown'
import { trackFile, type AudioExt } from '../audio'
import type { Meeting, Notes, Segment } from '../store'
import type { UploadAudio } from './api'

const MIME: Record<string, string> = { m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' }

/** The notes the person sees: the enhanced ones when there are any, else their own */
export function notesMarkdown(m: Meeting, n: Notes): string {
  return toMarkdownFile(m, n.enhanced ?? n.mine, [])
}

export function transcriptMarkdown(m: Meeting, segments: Segment[]): string {
  const title = m.title.replace(/\s+/g, ' ').trim()
  const body = segments.length ? docToMd(transcriptDoc(segments, { gap: true })) : ''
  return `# ${escapeText(title)} (transcript)\n\n${body}`.trimEnd() + '\n'
}

export type AudioFile = UploadAudio & { path: string }

/** The meeting's tracks that are on disk and not empty */
export function audioFiles(dir: string, exts: readonly AudioExt[]): AudioFile[] {
  const out: AudioFile[] = []
  for (const track of ['me', 'them'] as const) {
    const path = trackFile(dir, track, exts)
    if (!path) continue
    let size = 0
    try { size = statSync(path).size } catch { continue }
    if (size <= 0) continue
    const ext = path.slice(path.lastIndexOf('.') + 1)
    out.push({ track, fileName: basename(path), mimeType: MIME[ext] ?? 'application/octet-stream', size, path })
  }
  return out
}

export const attendeeEmails = (m: Meeting): string[] =>
  [...new Set(m.attendees.map(a => a.email?.trim().toLowerCase()).filter((e): e is string => !!e))]
