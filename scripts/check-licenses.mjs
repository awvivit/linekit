import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateLicenseExpression, readLicenseField } from './license-policy.mjs'

/**
 * @typedef {Object} LicenseFailure
 * @property {string} name
 * @property {string} version
 * @property {'forbidden' | 'unknown'} verdict
 * @property {string} license
 * @property {string} reason
 */

/**
 * @typedef {Object} LicenseScan
 * @property {number} count
 * @property {LicenseFailure[]} failures
 */

/**
 * @param {string} fullPath
 * @param {import('node:fs').Dirent} entry
 */
function isDirectory(fullPath, entry) {
  if (entry.isDirectory()) {
    return true
  }
  if (!entry.isSymbolicLink()) {
    return false
  }
  try {
    return statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} nodeModulesDir
 * @returns {LicenseScan}
 */
export function scanInstalledPackages(nodeModulesDir) {
  /** @type {LicenseFailure[]} */
  const failures = []
  /** @type {Set<string>} */
  const seen = new Set()
  let count = 0

  /**
   * @param {string} packageDir
   */
  const consider = (packageDir) => {
    let realPath
    try {
      realPath = realpathSync(packageDir)
    } catch {
      return
    }
    if (seen.has(realPath)) {
      return
    }
    seen.add(realPath)

    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) {
      return
    }

    /** @type {unknown} */
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      failures.push({
        name: packageDir,
        version: 'unknown',
        verdict: 'unknown',
        license: '(unreadable)',
        reason: 'could not read package.json',
      })
      return
    }

    const name =
      typeof manifest === 'object' &&
      manifest !== null &&
      'name' in manifest &&
      typeof manifest.name === 'string'
        ? manifest.name
        : packageDir
    const version =
      typeof manifest === 'object' &&
      manifest !== null &&
      'version' in manifest &&
      typeof manifest.version === 'string'
        ? manifest.version
        : 'unknown'
    const license = readLicenseField(manifest)
    const evaluation = evaluateLicenseExpression(license)
    count += 1
    if (evaluation.verdict !== 'allowed') {
      failures.push({
        name,
        version,
        verdict: evaluation.verdict,
        license: license ?? '(missing)',
        reason: evaluation.reason,
      })
    }

    const nested = join(packageDir, 'node_modules')
    if (existsSync(nested)) {
      walk(nested)
    }
  }

  /**
   * @param {string} directory
   */
  const walk = (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name.startsWith('.')) {
        continue
      }
      const fullPath = join(directory, entry.name)
      if (!isDirectory(fullPath, entry)) {
        continue
      }
      if (entry.name.startsWith('@')) {
        let scoped
        try {
          scoped = readdirSync(fullPath, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of scoped) {
          const childPath = join(fullPath, child.name)
          if (isDirectory(childPath, child)) {
            consider(childPath)
          }
        }
        continue
      }
      consider(fullPath)
    }
  }

  walk(nodeModulesDir)
  return { count, failures }
}

/**
 * @param {LicenseScan} scan
 */
export function formatLicenseReport(scan) {
  if (scan.count === 0) {
    return 'License check scanned 0 packages.'
  }
  if (scan.failures.length === 0) {
    return `License check passed (${scan.count} packages).`
  }
  const lines = scan.failures.map(
    (failure) =>
      `- ${failure.name}@${failure.version} [${failure.verdict}] ${failure.license} — ${failure.reason}`,
  )
  return `License check failed (${scan.failures.length}):\n${lines.join('\n')}`
}

const isDirectRun = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isDirectRun) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const scan = scanInstalledPackages(join(root, 'node_modules'))
  const report = formatLicenseReport(scan)
  if (scan.count === 0 || scan.failures.length > 0) {
    console.error(report)
    process.exit(1)
  }
  console.log(report)
}
