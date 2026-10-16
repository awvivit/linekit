import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatLicenseReport, scanInstalledPackages } from './check-licenses.mjs'
import { evaluateLicenseExpression, readLicenseField } from './license-policy.mjs'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('evaluateLicenseExpression', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'ISC',
    'BSD-3-Clause',
    '0BSD',
    'MIT OR Apache-2.0',
    '(MIT OR Apache-2.0)',
    '(MIT OR GPL-2.0-only)',
    '(GPL-3.0-only OR MIT)',
    'MIT AND ISC',
    'Apache-2.0 WITH LLVM-exception',
  ])('allows %s', (expression) => {
    expect(evaluateLicenseExpression(expression).verdict).toBe('allowed')
  })

  it.each([
    'GPL-3.0-only',
    'GPL-2.0-or-later',
    'GPL-2.0+',
    'AGPL-3.0-only',
    'LGPL-2.1-only',
    'LGPL-3.0-or-later',
    'SSPL-1.0',
    'GPLv3',
    '(MIT AND GPL-2.0-only)',
    '(GPL-2.0-only OR AGPL-3.0-only)',
    'GNU General Public License v2.0',
    'GNU Lesser General Public License',
    'Server Side Public License',
  ])('forbids %s', (expression) => {
    expect(evaluateLicenseExpression(expression).verdict).toBe('forbidden')
  })

  it.each([
    null,
    undefined,
    '',
    '   ',
    'UNLICENSED',
    'UNKNOWN',
    'NONE',
    'NOASSERTION',
    'SEE LICENSE IN LICENSE',
    'Made-Up-1.0',
    '(Made-Up-1.0 OR Also-Unknown)',
  ])('rejects unidentified %s', (expression) => {
    expect(evaluateLicenseExpression(expression).verdict).toBe('unknown')
  })
})

describe('readLicenseField', () => {
  it('reads string, legacy object, and licenses-array forms', () => {
    expect(readLicenseField({ license: 'MIT' })).toBe('MIT')
    expect(readLicenseField({ license: { type: 'ISC' } })).toBe('ISC')
    expect(readLicenseField({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT) OR (Apache-2.0)',
    )
    expect(readLicenseField({})).toBeNull()
    expect(readLicenseField(null)).toBeNull()
  })
})

describe('scanInstalledPackages', () => {
  it('reports forbidden and unknown packages and accepts an MIT package', () => {
    const root = mkdtempSync(join(tmpdir(), 'linekit-licenses-'))
    tempDirs.push(root)
    const modules = join(root, 'node_modules')
    writePackage(modules, 'kept', { name: 'kept', version: '1.0.0', license: 'MIT' })
    writePackage(modules, 'copyleft', {
      name: 'copyleft',
      version: '2.0.0',
      license: 'GPL-3.0-only',
    })
    writePackage(modules, 'mystery', { name: 'mystery', version: '0.1.0' })
    mkdirSync(join(modules, '@scope'), { recursive: true })
    writePackage(join(modules, '@scope'), 'widget', {
      name: '@scope/widget',
      version: '3.2.1',
      license: { type: 'ISC' },
    })

    const scan = scanInstalledPackages(modules)
    expect(scan.count).toBe(4)
    expect(scan.failures.map((failure) => failure.name).sort()).toEqual(['copyleft', 'mystery'])
    expect(formatLicenseReport(scan)).toContain('copyleft@2.0.0 [forbidden]')
    expect(formatLicenseReport(scan)).toContain('mystery@0.1.0 [unknown]')
  })
})

function writePackage(directory: string, folder: string, manifest: object) {
  const packageDir = join(directory, folder)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
}
