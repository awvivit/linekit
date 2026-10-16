/**
 * License policy for installed npm packages.
 *
 * An expression is allowed when every conjunct that must be accepted is an
 * identified, non-forbidden license. An SPDX OR is allowed when at least one
 * side is allowed, because that side can be chosen. Missing and unrecognized
 * licenses fail closed.
 */

/** @typedef {'allowed' | 'forbidden' | 'unknown'} LicenseVerdict */

/**
 * @typedef {Object} LicenseEvaluation
 * @property {LicenseVerdict} verdict
 * @property {string} reason
 */

const ALLOWED_LICENSES = new Set([
  '0bsd',
  'afl-2.1',
  'afl-3.0',
  'apache-2.0',
  'artistic-2.0',
  'blueoak-1.0.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsl-1.0',
  'cc-by-3.0',
  'cc-by-4.0',
  'cc0-1.0',
  'isc',
  'mit',
  'mit-0',
  'mpl-2.0',
  'ncsa',
  'ofl-1.1',
  'psf-2.0',
  'python-2.0',
  'unicode-3.0',
  'unicode-dfs-2016',
  'unlicense',
  'wtfpl',
  'x11',
  'zlib',
])

const ALLOWED_EXCEPTIONS = new Set(['llvm-exception'])

const FORBIDDEN_ID = /^(?:a?gpl|lgpl|sspl)(?:$|[-+.]|v\d)/i

const FORBIDDEN_PROSE =
  /server side public license|gnu affero general public license|gnu lesser general public license|gnu general public license|\bagpl\b|\blgpl\b|\bgpl\b|\bsspl\b/i

/**
 * @param {string} id
 * @returns {LicenseEvaluation}
 */
function classifyId(id) {
  const normalized = id.trim().toLowerCase()
  if (FORBIDDEN_ID.test(normalized) || FORBIDDEN_PROSE.test(normalized)) {
    return { verdict: 'forbidden', reason: `forbidden license ${id}` }
  }
  if (ALLOWED_LICENSES.has(normalized)) {
    return { verdict: 'allowed', reason: `allowed license ${id}` }
  }
  return { verdict: 'unknown', reason: `unknown license ${id}` }
}

/**
 * @param {string} input
 * @returns {string[]}
 */
function tokenize(input) {
  /** @type {string[]} */
  const tokens = []
  const pattern = /\(|\)|\bOR\b|\bAND\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/gi
  let match = pattern.exec(input)
  while (match) {
    const word = match[0]
    const upper = word.toUpperCase()
    if (upper === 'OR' || upper === 'AND' || upper === 'WITH') {
      tokens.push(upper)
    } else {
      tokens.push(word)
    }
    match = pattern.exec(input)
  }

  const stripped = input
    .replace(/\(|\)|\bOR\b|\bAND\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/gi, '')
    .replace(/\s+/g, '')
  if (stripped.length > 0) {
    throw new Error(`unexpected characters: ${stripped}`)
  }
  if (tokens.length === 0) {
    throw new Error('no tokens')
  }
  return tokens
}

/**
 * @typedef {{ type: 'id', id: string }} IdNode
 * @typedef {{ type: 'with', id: string, exception: string }} WithNode
 * @typedef {{ type: 'or', left: LicenseNode, right: LicenseNode }} OrNode
 * @typedef {{ type: 'and', left: LicenseNode, right: LicenseNode }} AndNode
 * @typedef {IdNode | WithNode | OrNode | AndNode} LicenseNode
 */

/**
 * @param {string[]} tokens
 * @returns {LicenseNode}
 */
function parseExpression(tokens) {
  let index = 0

  /** @returns {LicenseNode} */
  const parseOr = () => {
    let left = parseAnd()
    while (tokens[index] === 'OR') {
      index += 1
      const right = parseAnd()
      left = { type: 'or', left, right }
    }
    return left
  }

  /** @returns {LicenseNode} */
  const parseAnd = () => {
    let left = parseWith()
    while (tokens[index] === 'AND') {
      index += 1
      const right = parseWith()
      left = { type: 'and', left, right }
    }
    return left
  }

  /** @returns {LicenseNode} */
  const parseWith = () => {
    const base = parsePrimary()
    if (tokens[index] !== 'WITH') {
      return base
    }
    if (base.type !== 'id') {
      throw new Error('WITH must follow a license id')
    }
    index += 1
    const exception = tokens[index]
    if (
      exception === undefined ||
      exception === 'OR' ||
      exception === 'AND' ||
      exception === 'WITH' ||
      exception === '(' ||
      exception === ')'
    ) {
      throw new Error('missing exception id')
    }
    index += 1
    return { type: 'with', id: base.id, exception }
  }

  /** @returns {LicenseNode} */
  const parsePrimary = () => {
    const token = tokens[index]
    if (token === '(') {
      index += 1
      const expression = parseOr()
      if (tokens[index] !== ')') {
        throw new Error('missing )')
      }
      index += 1
      return expression
    }
    if (
      token === undefined ||
      token === 'OR' ||
      token === 'AND' ||
      token === 'WITH' ||
      token === ')'
    ) {
      throw new Error('expected license id')
    }
    index += 1
    return { type: 'id', id: token }
  }

  const expression = parseOr()
  if (index !== tokens.length) {
    throw new Error('trailing tokens')
  }
  return expression
}

/**
 * @param {LicenseNode} node
 * @returns {LicenseEvaluation}
 */
function evaluateNode(node) {
  if (node.type === 'id') {
    return classifyId(node.id)
  }
  if (node.type === 'with') {
    if (!ALLOWED_EXCEPTIONS.has(node.exception.toLowerCase())) {
      return { verdict: 'unknown', reason: `unknown license exception ${node.exception}` }
    }
    return classifyId(node.id)
  }

  const left = evaluateNode(node.left)
  const right = evaluateNode(node.right)
  if (node.type === 'or') {
    if (left.verdict === 'allowed') {
      return left
    }
    if (right.verdict === 'allowed') {
      return right
    }
    if (left.verdict === 'forbidden' || right.verdict === 'forbidden') {
      return {
        verdict: 'forbidden',
        reason: `no allowed alternative (${left.reason}; ${right.reason})`,
      }
    }
    return {
      verdict: 'unknown',
      reason: `no identified alternative (${left.reason}; ${right.reason})`,
    }
  }

  if (left.verdict === 'forbidden' || right.verdict === 'forbidden') {
    return {
      verdict: 'forbidden',
      reason: `forbidden term in conjunction (${left.reason}; ${right.reason})`,
    }
  }
  if (left.verdict === 'unknown' || right.verdict === 'unknown') {
    return {
      verdict: 'unknown',
      reason: `unidentified term in conjunction (${left.reason}; ${right.reason})`,
    }
  }
  return { verdict: 'allowed', reason: `${left.reason}; ${right.reason}` }
}

/**
 * @param {string | null | undefined} expression
 * @returns {LicenseEvaluation}
 */
export function evaluateLicenseExpression(expression) {
  if (expression == null) {
    return { verdict: 'unknown', reason: 'missing license' }
  }
  const trimmed = expression.trim()
  if (trimmed === '') {
    return { verdict: 'unknown', reason: 'empty license' }
  }

  const upper = trimmed.toUpperCase()
  if (
    upper === 'UNLICENSED' ||
    upper === 'UNKNOWN' ||
    upper === 'NONE' ||
    upper === 'NOASSERTION' ||
    upper.startsWith('SEE LICENSE')
  ) {
    return { verdict: 'unknown', reason: `unidentified license: ${trimmed}` }
  }

  if (FORBIDDEN_PROSE.test(trimmed) && !/[()]|\bOR\b|\bAND\b/i.test(trimmed)) {
    return { verdict: 'forbidden', reason: `forbidden license text: ${trimmed}` }
  }

  try {
    return evaluateNode(parseExpression(tokenize(trimmed)))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'parse error'
    if (FORBIDDEN_PROSE.test(trimmed)) {
      return { verdict: 'forbidden', reason: `forbidden license in "${trimmed}"` }
    }
    return { verdict: 'unknown', reason: `could not parse license "${trimmed}": ${message}` }
  }
}

/**
 * @param {unknown} pkg
 * @returns {string | null}
 */
export function readLicenseField(pkg) {
  if (typeof pkg !== 'object' || pkg === null) {
    return null
  }
  if (!('license' in pkg) && !('licenses' in pkg)) {
    return null
  }

  const license = 'license' in pkg ? pkg.license : undefined
  if (typeof license === 'string') {
    return license
  }
  if (
    typeof license === 'object' &&
    license !== null &&
    'type' in license &&
    typeof license.type === 'string'
  ) {
    return license.type
  }

  const licenses = 'licenses' in pkg ? pkg.licenses : undefined
  if (!Array.isArray(licenses)) {
    return null
  }

  /** @type {string[]} */
  const parts = []
  for (const item of licenses) {
    if (typeof item === 'string') {
      parts.push(item)
    } else if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      typeof item.type === 'string'
    ) {
      parts.push(item.type)
    }
  }
  if (parts.length === 0) {
    return null
  }
  if (parts.length === 1) {
    return parts[0] ?? null
  }
  return parts.map((part) => `(${part})`).join(' OR ')
}
