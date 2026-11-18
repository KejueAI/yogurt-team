import { describe, expect, it } from 'vitest'
import { cleanName, firstName, isValidTimezone, renderPattern, validatePattern, withExtension } from '../src/naming.js'

const base = { title: 'Launch planning', startedAt: new Date('2026-11-18T23:30:00Z'), timezone: 'UTC', recorderName: 'Youssef Abdelsalam', recorderEmail: 'youssef@kejue.co' }

describe('naming', () => {
  it('renders the default patterns', () => {
    expect(renderPattern('{date} {title}', base)).toBe('2026-11-18 Launch planning')
    expect(renderPattern('{recorder} – {kind}', { ...base, kind: 'Notes' })).toBe('Youssef – Notes')
  })
  it('uses the team time zone for date and time', () => {
    expect(renderPattern('{date} {time}', { ...base, timezone: 'Asia/Tokyo' })).toBe('2026-11-19 08.30')
    expect(renderPattern('{date}', { ...base, timezone: 'America/Los_Angeles' })).toBe('2026-11-18')
  })
  it('supports full name and email, keeps unknown placeholders', () => {
    expect(renderPattern('{recorderFull} <{email}> {nope}', base)).toBe('Youssef Abdelsalam <youssef@kejue.co> {nope}')
  })
  it('falls back for missing title and name', () => {
    expect(renderPattern('{title}', { ...base, title: '  ' })).not.toBe('')
    expect(firstName(null, 'ana.maria@kejue.co')).toMatch(/^Ana/i)
    expect(firstName('  Ana   Maria ', undefined)).toBe('Ana')
  })
  it('cleans names for Drive', () => {
    expect(cleanName('a\n\tb   c')).toBe('a b c')
    expect(cleanName('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
  it('adds the extension from the uploaded file name', () => {
    expect(withExtension('Youssef – mic', 'mic.m4a')).toBe('Youssef – mic.m4a')
    expect(withExtension('Youssef – mic', 'noext')).toBe('Youssef – mic')
  })
  it('validates patterns and time zones', () => {
    expect(validatePattern('{date} {title}')).toBeNull()
    expect(validatePattern('')).not.toBeNull()
    expect(validatePattern('{date} {bogus}')).not.toBeNull()
    expect(isValidTimezone('Europe/London')).toBe(true)
    expect(isValidTimezone('Mars/Base')).toBe(false)
  })
})
