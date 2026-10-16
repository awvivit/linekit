import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { site } from './brand.ts'

describe('site', () => {
  it('keeps the public name and Pages base path together', () => {
    expect(site.name).toBe('Linekit')
    expect(site.packageName).toBe('linekit')
    expect(site.basePath).toBe('/linekit/')

    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('name' in parsed) ||
      typeof parsed.name !== 'string'
    ) {
      throw new Error('package.json is missing a name')
    }
    expect(parsed.name).toBe(site.packageName)
  })

  it('keeps the production CSP on this origin only', () => {
    expect(site.contentSecurityPolicy).toContain("default-src 'self'")
    expect(site.contentSecurityPolicy).toContain("script-src 'self'")
    expect(site.contentSecurityPolicy).toContain("style-src 'self'")
    expect(site.contentSecurityPolicy).not.toContain('unsafe-inline')
    expect(site.contentSecurityPolicy).not.toContain('unsafe-eval')
    expect(site.contentSecurityPolicy).not.toMatch(/https?:/)
    expect(site.contentSecurityPolicy).not.toContain('data:')
  })
})
