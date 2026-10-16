export type LicenseFailure = {
  name: string
  version: string
  verdict: 'forbidden' | 'unknown'
  license: string
  reason: string
}

export type LicenseScan = {
  count: number
  failures: LicenseFailure[]
}

export function scanInstalledPackages(nodeModulesDir: string): LicenseScan

export function formatLicenseReport(scan: LicenseScan): string
