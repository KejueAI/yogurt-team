import { describe, expect, it } from 'vitest'
import { escapeHtml, markdownToHtml } from '../src/markdown.js'

describe('markdown to HTML for Google Docs import', () => {
  const md = `# Launch planning

Discussed **pricing** and _timeline_ with \`code\`.

## Action items
- [ ] Ana: draft the post
- [x] Youssef: book the room
- Plain bullet
  - Nested bullet

1. First
2. Second

| Who | What |
| --- | --- |
| Ana | Copy |

> A quote

[Spec](https://example.com/spec?a=1&b=2)
`
  const out = markdownToHtml(md, 'Launch & planning')

  it('produces a full HTML document with a title', () => {
    expect(out).toMatch(/^<!doctype html>/i)
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain('<title>Launch &amp; planning</title>')
  })
  it('converts headings, emphasis, lists, tables, quotes and links', () => {
    expect(out).toContain('<h1>Launch planning</h1>')
    expect(out).toContain('<h2>Action items</h2>')
    expect(out).toContain('<strong>pricing</strong>')
    expect(out).toContain('<em>timeline</em>')
    expect(out).toContain('<code>code</code>')
    expect(out).toMatch(/<ul>[\s\S]*<li>Plain bullet[\s\S]*<ul>[\s\S]*Nested bullet/)
    expect(out).toMatch(/<ol>[\s\S]*<li>First<\/li>/)
    expect(out).toMatch(/<table>[\s\S]*<th>Who<\/th>[\s\S]*<td>Ana<\/td>/)
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<a href="https://example.com/spec?a=1&amp;b=2">Spec</a>')
  })
  it('renders task boxes as text characters Docs keeps', () => {
    expect(out).toContain('☐ Ana: draft the post')
    expect(out).toContain('☑ Youssef: book the room')
    expect(out).not.toContain('<input')
  })
  it('escapes raw HTML in the markdown', () => {
    const evil = markdownToHtml('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(evil).not.toContain('<script>')
    expect(evil).not.toContain('<img')
    expect(evil).toContain('&lt;script&gt;')
  })
  it('handles empty input', () => {
    expect(markdownToHtml('')).toContain('<body>')
  })
  it('escapes text', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})
