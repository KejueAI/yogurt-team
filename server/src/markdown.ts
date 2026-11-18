import { Marked, type Tokens } from 'marked'

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in notes is shown as text: predictable output, and nothing odd reaches Drive.
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text)
    },
    // Google Docs drops <input> elements, so task-list boxes become characters.
    checkbox({ checked }: Tokens.Checkbox) {
      return checked ? '☑ ' : '☐ '
    },
  },
})

/**
 * Markdown to a complete HTML document for Drive's HTML → Google Docs conversion,
 * which keeps headings, lists, bold/italic, links, tables and code more reliably than
 * Drive's own Markdown import.
 */
export function markdownToHtml(markdown: string, title?: string): string {
  const body = marked.parse(markdown ?? '', { async: false }) as string
  const head = `<meta charset="utf-8">${title ? `<title>${escapeHtml(title)}</title>` : ''}`
  const style =
    '<style>body{font-family:Arial,sans-serif;font-size:11pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}pre,code{font-family:"Roboto Mono",monospace}</style>'
  return `<!DOCTYPE html><html><head>${head}${style}</head><body>${body}</body></html>`
}
