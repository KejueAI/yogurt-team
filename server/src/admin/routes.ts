import { Hono, type Context } from 'hono'
import { parseList } from '../access.js'
import { USER_COLUMNS, revokeUserSessions, toUser, type User } from '../auth.js'
import type { Deps, Env } from '../context.js'
import { folderUrl, type DriveFile, type SharedDrive } from '../google.js'
import { PLACEHOLDERS, isValidTimezone, renderFolderPath, renderPattern, validatePattern } from '../naming.js'
import { DEFAULT_MODEL, type DriveFolder, type TeamSettings } from '../settings.js'
import { adminFromCookie } from '../routes/auth.js'
import { formatTime, html, page, raw, type Notice, type Raw, type Section } from './layout.js'

const NOTICES: Record<string, Notice> = {
  connected: { kind: 'ok', text: 'Google Drive is connected. Now pick the folder meetings go in.' },
  cancelled: { kind: 'bad', text: 'Drive connection was cancelled.' },
  disconnected: { kind: 'ok', text: 'Google Drive was disconnected.' },
  folder: { kind: 'ok', text: 'Folder saved. New uploads go there.' },
  saved: { kind: 'ok', text: 'Saved.' },
  access: { kind: 'ok', text: 'Access rules saved.' },
  member: { kind: 'ok', text: 'Member updated.' },
  keySaved: { kind: 'ok', text: 'OpenRouter key saved.' },
  keyCleared: { kind: 'ok', text: 'OpenRouter key removed.' },
}

type Form = Record<string, string | File | (string | File)[]>

function str(form: Form, key: string): string {
  const v = form[key]
  return typeof v === 'string' ? v : ''
}

function noticeFrom(c: Context): Notice | null {
  const error = c.req.query('error')
  if (error) return { kind: 'bad', text: error }
  return NOTICES[c.req.query('notice') ?? ''] ?? null
}

function back(c: Context, path: string, notice: string): Response {
  return c.redirect(`${path}?notice=${encodeURIComponent(notice)}`, 303)
}

function backWithError(c: Context, path: string, message: string): Response {
  return c.redirect(`${path}?error=${encodeURIComponent(message)}`, 303)
}

function badge(status: string): Raw {
  const kind =
    status === 'complete' || status === 'deleted' ? 'ok' : status === 'failed' ? 'bad' : status === 'awaiting_audio' || status === 'processing' ? 'warn' : ''
  const label = status === 'awaiting_audio' ? 'awaiting audio' : status
  return html`<span class="badge ${kind}">${label}</span>`
}

export function adminRoutes(deps: Deps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()
  const publicOrigin = new URL(deps.config.publicUrl).origin

  app.use('*', async (c, next) => {
    // Cookies are SameSite=Lax, but also refuse cross-origin form posts outright.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      const selfOrigin = new URL(c.req.url).origin
      if (origin && origin !== publicOrigin && origin !== selfOrigin) return c.text('Cross-origin request refused.', 403)
    }
    const user = await adminFromCookie(deps, c)
    if (!user) return c.req.method === 'GET' ? c.redirect('/admin/login') : c.text('Sign in again.', 401)
    c.set('user', user)
    await next()
  })

  async function render(c: Context<Env>, section: Section, title: string, body: Raw) {
    const settings = await deps.settings.get(db)
    return c.html(page({ title, section, teamName: settings.teamName, adminEmail: c.get('user').email, notice: noticeFrom(c), body }))
  }

  app.get('/', (c) => c.redirect('/admin/drive'))

  // ---------- Drive ----------

  app.get('/drive', async (c) => {
    const settings = await deps.settings.get(db)
    const connected = !!(await deps.settings.getSecret(db, 'driveRefreshToken'))
    const folder = settings.driveFolder
    const status = html`<section class="card">
  <h2>Connection</h2>
  ${
    connected
      ? html`<p>Connected as <strong>${settings.driveAccountEmail ?? 'unknown account'}</strong>. Uploads are written with this account, so it needs edit access to the folder below.</p>
  <div class="actions">
    <form class="inline" method="post" action="/auth/drive/start"><button type="submit">Reconnect</button></form>
    <form class="inline" method="post" action="/admin/drive/disconnect" onsubmit="return confirm('Disconnect Google Drive? Uploads stop until it is connected again.')"><button class="danger" type="submit">Disconnect</button></form>
  </div>`
      : html`<p>Connect the Google account that uploads go through. Use an account that can add files to the team's Shared Drive.</p>
  <form method="post" action="/auth/drive/start"><button class="primary" type="submit">Connect Google Drive</button></form>`
  }
</section>
<section class="card">
  <h2>Meetings folder</h2>
  ${
    folder
      ? html`<p>Meetings go in <a href="${folderUrl(folder.id)}" target="_blank" rel="noopener"><strong>${folder.path || folder.name}</strong></a>.</p>`
      : html`<p class="muted">No folder picked yet. Desktop apps won't upload until one is.</p>`
  }
  ${connected ? html`<a class="button${folder ? '' : ' primary'}" href="/admin/drive/pick">${folder ? 'Change folder' : 'Pick a folder'}</a>` : ''}
</section>`
    return render(c, 'drive', 'Drive', status)
  })

  app.post('/drive/disconnect', async (c) => {
    await deps.settings.setSecret(db, 'driveRefreshToken', null)
    await deps.settings.update(db, { driveAccountEmail: null })
    return back(c, '/admin/drive', 'disconnected')
  })

  // Folder picker: /admin/drive/pick lists Shared Drives (and My Drive); ?parent=&drive=&path= browses inside.
  app.get('/drive/pick', async (c) => {
    const drive = await deps.drive()
    if (!drive) return c.redirect('/admin/drive')
    const parent = c.req.query('parent')
    const driveId = c.req.query('drive') || undefined
    const path = c.req.query('path') || ''
    let body: Raw
    try {
      if (!parent) {
        const drives: SharedDrive[] = await drive.listSharedDrives()
        body = html`<section class="card">
  <h2>Choose where to start</h2>
  <ul class="picker">
    ${drives.map(
      (d) => html`<li><a href="/admin/drive/pick?${new URLSearchParams({ parent: d.id, drive: d.id, path: d.name }).toString()}">${d.name}</a><span class="badge">Shared Drive</span></li>`,
    )}
    <li><a href="/admin/drive/pick?${new URLSearchParams({ parent: 'root', path: 'My Drive' }).toString()}">My Drive</a><span class="badge">personal</span></li>
  </ul>
  ${drives.length ? '' : html`<p class="hint">This account can't see any Shared Drives. Add it as a member of one, or use a folder in My Drive.</p>`}
</section>`
      } else {
        const folders: DriveFile[] = await drive.listFolders(parent, driveId)
        const choose = (f: DriveFolder, label: string, primary = false) => html`<form class="inline" method="post" action="/admin/drive/folder">
  <input type="hidden" name="id" value="${f.id}"><input type="hidden" name="name" value="${f.name}">
  <input type="hidden" name="driveId" value="${f.driveId ?? ''}"><input type="hidden" name="path" value="${f.path ?? ''}">
  <button type="submit" class="${primary ? 'primary' : ''}">${label}</button></form>`
        const currentName = path.split(' / ').pop() || path
        const canChooseCurrent = parent !== 'root'
        body = html`<section class="card">
  <div class="crumbs"><a href="/admin/drive/pick">All drives</a> / ${path}</div>
  ${canChooseCurrent ? html`<div class="actions" style="margin:0 0 12px">${choose({ id: parent, name: currentName, driveId, path }, `Use “${currentName}”`, true)}</div>` : ''}
  <ul class="picker">
    ${folders.map((f) => {
      const childPath = `${path} / ${f.name}`
      const q = new URLSearchParams({ parent: f.id, path: childPath })
      if (driveId) q.set('drive', driveId)
      return html`<li><a href="/admin/drive/pick?${q.toString()}">${f.name}</a>${choose({ id: f.id, name: f.name, driveId, path: childPath }, 'Use this folder')}</li>`
    })}
  </ul>
  ${folders.length ? '' : html`<p class="muted">No folders here.</p>`}
  <p class="hint">Meeting folders are created inside the folder you pick.</p>
</section>`
      }
    } catch (err) {
      body = html`<section class="card"><p>Couldn't list folders: ${err instanceof Error ? err.message : String(err)}</p>
<p><a href="/admin/drive/pick">Start again</a> or <a href="/admin/drive">reconnect Drive</a>.</p></section>`
    }
    return render(c, 'drive', 'Pick a folder', html`<h1>Pick the meetings folder</h1><p class="lead">Browse to a folder in a Shared Drive.</p>${body}`)
  })

  app.post('/drive/folder', async (c) => {
    const form = await c.req.parseBody()
    const id = str(form, 'id')
    if (!id) return backWithError(c, '/admin/drive', 'No folder was chosen.')
    const drive = await deps.drive()
    if (!drive) return c.redirect('/admin/drive', 303)
    // Check the folder exists and is reachable before saving it.
    const file = await drive.getFile(id).catch(() => null)
    if (!file || file.trashed) return backWithError(c, '/admin/drive', 'That folder is not reachable with the connected account.')
    const folder: DriveFolder = { id, name: file.name || str(form, 'name'), path: str(form, 'path') || file.name }
    const driveId = file.driveId || str(form, 'driveId')
    if (driveId) folder.driveId = driveId
    await deps.settings.update(db, { driveFolder: folder })
    return back(c, '/admin/drive', 'folder')
  })

  // ---------- Members ----------

  app.get('/members', async (c) => {
    const settings = await deps.settings.get(db)
    const me = c.get('user')
    const { rows } = await db.query(
      `SELECT ${USER_COLUMNS},
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.kind = 'desktop' AND s.revoked_at IS NULL AND s.expires_at > now())::int AS devices
       FROM users u ORDER BY u.last_seen_at DESC NULLS LAST, u.email`,
    )
    const users = rows.map((r: Record<string, unknown>) => ({ ...toUser(r as never), devices: Number(r.devices) }))
    const bootstrap = deps.config.adminEmails
    const action = (u: User, path: string, label: string, opts: { danger?: boolean; confirm?: string } = {}) =>
      html`<form class="inline" method="post" action="/admin/members/${u.id}/${path}"${opts.confirm ? raw(` onsubmit="return confirm('${opts.confirm.replace(/['"\\<>&]/g, '')}')"`) : ''}><button type="submit" class="${opts.danger ? 'danger' : ''}">${label}</button></form>`
    const body = html`<h1>Members</h1>
<p class="lead">Everyone who has signed in. Signing someone out revokes their app's token; blocking also stops them signing back in.</p>
<section class="card table-wrap">
  <table>
    <thead><tr><th>Member</th><th>Last seen</th><th>Devices</th><th>Role</th><th></th></tr></thead>
    <tbody>
    ${users.map(
      (u) => html`<tr>
      <td><strong>${u.name || u.email}</strong><div class="small muted">${u.email}</div></td>
      <td class="small">${formatTime(u.lastSeenAt)}</td>
      <td>${u.devices}</td>
      <td>${u.blocked ? html`<span class="badge bad">blocked</span>` : u.isAdmin ? html`<span class="badge ok">admin</span>` : html`<span class="badge">member</span>`}</td>
      <td><div class="actions" style="margin:0">
        ${u.devices ? action(u, 'signout', 'Sign out') : ''}
        ${
          u.id === me.id
            ? html`<span class="small muted">you</span>`
            : html`${u.isAdmin ? (bootstrap.includes(u.email) ? html`<span class="small muted" title="Listed in ADMIN_EMAILS">bootstrap admin</span>` : action(u, 'unadmin', 'Remove admin')) : action(u, 'admin', 'Make admin')}
        ${u.blocked ? action(u, 'unblock', 'Unblock') : action(u, 'block', 'Block', { danger: true, confirm: `Block ${u.email}? They are signed out and can't sign back in.` })}`
        }
      </div></td>
    </tr>`,
    )}
    </tbody>
  </table>
  ${users.length ? '' : html`<p class="muted">Nobody has signed in yet.</p>`}
</section>
<section class="card">
  <h2>Who can sign in</h2>
  <form method="post" action="/admin/members/access">
    <label for="domains">Allowed domains</label>
    <textarea id="domains" name="allowedDomains" placeholder="kejue.co">${settings.allowedDomains.join('\n')}</textarea>
    <div class="hint">Anyone with a verified Google account on these domains can sign in. One per line.</div>
    <label for="allowlist">Extra email addresses</label>
    <textarea id="allowlist" name="allowlist" placeholder="contractor@example.com">${settings.allowlist.join('\n')}</textarea>
    <div class="hint">People outside those domains who may also sign in.</div>
    <div class="actions"><button class="primary" type="submit">Save access rules</button></div>
  </form>
  <p class="hint">Admins from <code>ADMIN_EMAILS</code> (${bootstrap.join(', ') || 'none'}) can always sign in and are always admins.</p>
</section>`
    return render(c, 'members', 'Members', body)
  })

  app.post('/members/access', async (c) => {
    const form = await c.req.parseBody()
    await deps.settings.update(db, {
      allowedDomains: parseList(str(form, 'allowedDomains'), 'domain'),
      allowlist: parseList(str(form, 'allowlist'), 'email'),
    })
    return back(c, '/admin/members', 'access')
  })

  app.post('/members/:id/:action', async (c) => {
    const me = c.get('user')
    const id = Number(c.req.param('id'))
    const act = c.req.param('action')
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [id])
    if (!rows[0]) return backWithError(c, '/admin/members', 'No such member.')
    const target = toUser(rows[0])
    if (target.id === me.id && act !== 'signout') return backWithError(c, '/admin/members', "You can't change your own role or block yourself.")
    if ((act === 'unadmin' || act === 'block') && deps.config.adminEmails.includes(target.email)) {
      return backWithError(c, '/admin/members', `${target.email} is in ADMIN_EMAILS; remove them there first.`)
    }
    switch (act) {
      case 'signout':
        await revokeUserSessions(db, id)
        break
      case 'admin':
        await db.query('UPDATE users SET is_admin = true WHERE id = $1', [id])
        break
      case 'unadmin':
        await db.query('UPDATE users SET is_admin = false WHERE id = $1', [id])
        await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'admin' AND revoked_at IS NULL`, [id])
        break
      case 'block':
        await db.query('UPDATE users SET blocked = true WHERE id = $1', [id])
        await revokeUserSessions(db, id)
        break
      case 'unblock':
        await db.query('UPDATE users SET blocked = false WHERE id = $1', [id])
        break
      default:
        return c.notFound()
    }
    deps.log('member updated', { admin: me.email, target: target.email, action: act })
    return back(c, '/admin/members', 'member')
  })

  // ---------- Uploads ----------

  app.get('/uploads', async (c) => {
    const status = c.req.query('status') || ''
    const params: unknown[] = []
    let where = ''
    if (['processing', 'awaiting_audio', 'complete', 'failed', 'deleted'].includes(status)) {
      params.push(status)
      where = 'WHERE up.status = $1'
    }
    const { rows } = await db.query<{
      id: string
      meeting_title: string
      folder_id: string | null
      status: string
      error: string | null
      audio: { track: string; status: string }[]
      created_at: Date
      updated_at: Date
      email: string
      name: string | null
    }>(
      `SELECT up.id, up.meeting_title, up.folder_id, up.status, up.error, up.audio, up.created_at, up.updated_at, u.email, u.name
       FROM uploads up JOIN users u ON u.id = up.user_id ${where}
       ORDER BY up.created_at DESC LIMIT 300`,
      params,
    )
    const filters = ['', 'complete', 'awaiting_audio', 'failed', 'deleted'].map(
      (s) => html`<a class="button${s === status ? ' primary' : ''}" href="/admin/uploads${s ? `?status=${s}` : ''}">${s ? s.replace('_', ' ') : 'all'}</a>`,
    )
    const body = html`<h1>Uploads</h1>
<p class="lead">Every upload from the desktop apps, newest first. Re-uploads of the same meeting replace the recorder's earlier files.</p>
<div class="actions" style="margin:0 0 16px">${filters}</div>
<section class="card table-wrap">
  <table>
    <thead><tr><th>When</th><th>Recorder</th><th>Meeting</th><th>Status</th><th>Folder</th></tr></thead>
    <tbody>
    ${rows.map(
      (r) => html`<tr>
      <td class="small">${formatTime(r.created_at)}</td>
      <td>${r.name || r.email}<div class="small muted">${r.email}</div></td>
      <td>${r.meeting_title}${
        r.audio?.length ? html`<div class="small muted">audio: ${r.audio.map((a) => `${a.track} ${a.status}`).join(', ')}</div>` : ''
      }</td>
      <td>${badge(r.status)}${r.error ? html`<div class="small" style="color:var(--bad)">${r.error}</div>` : ''}</td>
      <td>${r.folder_id && r.status !== 'deleted' ? html`<a href="${folderUrl(r.folder_id)}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
    </tr>`,
    )}
    </tbody>
  </table>
  ${rows.length ? '' : html`<p class="muted">No uploads yet.</p>`}
</section>`
    return render(c, 'uploads', 'Uploads', body)
  })

  // ---------- Naming and contents ----------

  app.get('/naming', async (c) => {
    const s = await deps.settings.get(db)
    const me = c.get('user')
    const sample = { title: 'Launch planning', startedAt: new Date(), timezone: s.timezone, recorderName: me.name, recorderEmail: me.email }
    const check = (name: keyof TeamSettings, label: string, hint: string) =>
      html`<label class="check"><input type="checkbox" name="${name}" value="1"${s[name] ? raw(' checked') : ''}> ${label}</label><div class="hint" style="margin:-6px 0 6px 26px">${hint}</div>`
    const body = html`<h1>Naming and contents</h1>
<p class="lead">How meeting folders and files are named in Drive, and what each recorder uploads.</p>
<form method="post" action="/admin/naming">
<section class="card">
  <h2>Names</h2>
  <label for="teamName">Team name</label>
  <input id="teamName" type="text" name="teamName" value="${s.teamName}" required maxlength="100">
  <label for="folderPattern">Meeting folder</label>
  <input id="folderPattern" type="text" name="folderPattern" value="${s.folderPattern}" required>
  <div class="hint">Example: <code>${renderFolderPath(s.folderPattern, sample).join(' / ')}</code>. Use <code>/</code> for nested folders, e.g. <code>{year}/{month} {monthName}/{date} {title}</code> groups meetings by year and month.</div>
  <label for="filePattern">Files</label>
  <input id="filePattern" type="text" name="filePattern" value="${s.filePattern}" required>
  <div class="hint">Example: <code>${renderPattern(s.filePattern, { ...sample, kind: 'Notes' })}</code>, <code>${renderPattern(s.filePattern, { ...sample, kind: 'mic' })}.m4a</code></div>
  <div class="hint">Placeholders: ${PLACEHOLDERS.map((p) => html`<code>{${p}}</code> `)}. <code>{recorder}</code> is the first name; <code>{kind}</code> is Notes, Transcript or the audio track (mic, others).</div>
  <label for="timezone">Time zone for {date} and {time}</label>
  <input id="timezone" type="text" name="timezone" value="${s.timezone}" placeholder="Europe/London">
</section>
<section class="card">
  <h2>What gets uploaded</h2>
  ${check('uploadNotes', 'Notes', 'The summary notes, as a Google Doc.')}
  ${check('uploadTranscript', 'Transcript', 'The full transcript, as a Google Doc.')}
  ${check('uploadAudio', 'Audio', 'Two tracks per recorder: their microphone and everyone else.')}
  <label for="graceMinutes">Grace period (minutes)</label>
  <input id="graceMinutes" type="number" name="graceMinutes" min="0" max="1440" value="${s.graceMinutes}" style="max-width:120px">
  <div class="hint">How long the app waits after the summary before uploading, so a recorder can mark the meeting private.</div>
</section>
<div class="actions"><button class="primary" type="submit">Save</button></div>
</form>`
    return render(c, 'naming', 'Naming and contents', body)
  })

  app.post('/naming', async (c) => {
    const form = await c.req.parseBody()
    const folderPattern = str(form, 'folderPattern').trim()
    const filePattern = str(form, 'filePattern').trim()
    const timezone = str(form, 'timezone').trim() || 'UTC'
    const teamName = str(form, 'teamName').trim()
    const grace = Number(str(form, 'graceMinutes'))
    const problem =
      validatePattern(folderPattern) ??
      validatePattern(filePattern) ??
      (!filePattern.includes('{kind}') ? 'The file pattern needs {kind}, or Notes and Transcript would get the same name.' : null) ??
      (!isValidTimezone(timezone) ? `Unknown time zone "${timezone}".` : null) ??
      (!teamName ? 'Team name is required.' : null) ??
      (!Number.isInteger(grace) || grace < 0 || grace > 1440 ? 'Grace period must be a whole number of minutes, 0–1440.' : null)
    if (problem) return backWithError(c, '/admin/naming', problem)
    await deps.settings.update(db, {
      teamName,
      folderPattern,
      filePattern,
      timezone,
      graceMinutes: grace,
      uploadNotes: str(form, 'uploadNotes') === '1',
      uploadTranscript: str(form, 'uploadTranscript') === '1',
      uploadAudio: str(form, 'uploadAudio') === '1',
    })
    return back(c, '/admin/naming', 'saved')
  })

  // ---------- Summaries ----------

  app.get('/summaries', async (c) => {
    const s = await deps.settings.get(db)
    const or = await deps.settings.openrouter(db)
    const state =
      or.source === 'admin'
        ? html`<span class="badge ok">key set</span>`
        : or.source === 'env'
          ? html`<span class="badge ok">key from OPENROUTER_API_KEY</span>`
          : html`<span class="badge warn">no key</span>`
    const body = html`<h1>Summaries</h1>
<p class="lead">The desktop apps send summary and chat requests through this server to OpenRouter. Without a key, apps fall back to their local model.</p>
<section class="card">
  <h2>OpenRouter key ${state}</h2>
  <form method="post" action="/admin/summaries/key" autocomplete="off">
    <label for="key">${or.source === 'admin' ? 'Replace key' : 'Key'}</label>
    <input id="key" type="password" name="key" placeholder="sk-or-…" autocomplete="new-password" required>
    <div class="hint">Stored encrypted. It is never shown again.</div>
    <div class="actions"><button class="primary" type="submit">Save key</button></div>
  </form>
  ${
    or.source === 'admin'
      ? html`<form method="post" action="/admin/summaries/key/clear" onsubmit="return confirm('Remove the OpenRouter key?')"><div class="actions"><button class="danger" type="submit">Remove key</button></div></form>`
      : ''
  }
</section>
<section class="card">
  <h2>Model</h2>
  <form method="post" action="/admin/summaries/model">
    <label for="model">OpenRouter model</label>
    <input id="model" type="text" name="model" value="${s.openrouterModel ?? ''}" placeholder="${deps.config.openrouterModel || DEFAULT_MODEL}">
    <div class="hint">For example <code>anthropic/claude-sonnet-4.5</code> or <code>google/gemini-2.5-flash</code>. Leave empty for ${deps.config.openrouterModel ? html`<code>OPENROUTER_MODEL</code> (${deps.config.openrouterModel})` : html`<code>${DEFAULT_MODEL}</code>`}. In use: <code>${or.model}</code>.</div>
    <div class="actions"><button class="primary" type="submit">Save model</button></div>
  </form>
</section>`
    return render(c, 'summaries', 'Summaries', body)
  })

  app.post('/summaries/key', async (c) => {
    const key = str(await c.req.parseBody(), 'key').trim()
    if (!key) return backWithError(c, '/admin/summaries', 'Enter a key.')
    if (key.length > 500 || /\s/.test(key)) return backWithError(c, '/admin/summaries', "That doesn't look like an OpenRouter key.")
    await deps.settings.setSecret(db, 'openrouterKey', key)
    deps.log('openrouter key set', { admin: c.get('user').email })
    return back(c, '/admin/summaries', 'keySaved')
  })

  app.post('/summaries/key/clear', async (c) => {
    await deps.settings.setSecret(db, 'openrouterKey', null)
    return back(c, '/admin/summaries', 'keyCleared')
  })

  app.post('/summaries/model', async (c) => {
    const model = str(await c.req.parseBody(), 'model').trim()
    if (model && !/^[\w.:/-]{1,200}$/.test(model)) return backWithError(c, '/admin/summaries', 'Model ids look like "provider/model".')
    await deps.settings.update(db, { openrouterModel: model || null })
    return back(c, '/admin/summaries', 'saved')
  })

  return app
}
