export type LicenseVerdict = 'allowed' | 'forbidden' | 'unknown'

export type LicenseEvaluation = {
  verdict: LicenseVerdict
  reason: string
}

export function evaluateLicenseExpression(
  expression: string | null | undefined,
): LicenseEvaluation

export function readLicenseField(pkg: unknown): string | null
