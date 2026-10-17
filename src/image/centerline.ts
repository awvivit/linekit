import { optimize } from 'svgo/browser'
import type { BinaryImage } from './limits.ts'
import { sanitizeSvg } from './sanitize.ts'
import { closeInk, estimatePenWidth, zhangSuenThin } from './skeleton.ts'

type Point = { x: number; y: number }

type Chain = {
  points: Point[]
  closed: boolean
}

type DrawCommand =
  | { kind: 'L'; point: Point }
  | { kind: 'C'; control1: Point; control2: Point; point: Point }

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

/**
 * Turn a binary drawing into stroked centerlines.
 * Parallel runs within about one pen width become one path, short spurs are
 * dropped, and each remaining run is fit with as few cubics as the smoothing
 * tolerance allows.
 */
export function traceCenterline(image: BinaryImage, smoothing: number): string {
  const penWidth = estimatePenWidth(image)
  const radius = Math.max(1, Math.round(penWidth * 0.5))
  const closed = closeInk(image, radius)
  let skeleton = zhangSuenThin(closed)
  if (inkCount(skeleton) === 0) skeleton = zhangSuenThin(image)
  clearBlocks(skeleton, image.width, image.height)
  let chains = traceChains(skeleton, image.width, image.height)
  const minLength = Math.max(8, penWidth * 2)
  chains = pruneShort(chains, minLength)
  chains = chains.map((chain) => ({
    points: trimHooks(chain.points, minLength, penWidth),
    closed: chain.closed,
  }))
  chains = pruneShort(chains, minLength)
  chains = mergeParallel(chains, penWidth * 2.15)
  chains = joinGaps(chains, Math.max(penWidth * 3.6, 14))
  chains = chains.filter((chain) => polylineLength(chain.points) >= Math.min(minLength, penWidth))
  return publishSvg(image.width, image.height, chains, penWidth, smoothing)
}

function publishSvg(
  width: number,
  height: number,
  chains: Chain[],
  penWidth: number,
  smoothing: number,
): string {
  const tolerance = 0.45 + (clamp(smoothing, 0, 100) / 100) * 5.5
  const stroke = formatNumber(clamp(penWidth, 0.75, Math.max(width, height) / 2))
  const paths = chains
    .map((chain) => chainToPath(chain, tolerance, penWidth))
    .filter((path): path is string => path.length > 0)
    .map(
      (data) =>
        `<path fill="none" stroke="#000000" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" d="${data}"/>`,
    )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join('')}</svg>`
  const optimized = optimize(svg, {
    multipass: true,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            removeDesc: { removeAny: true },
            mergePaths: false,
          },
        },
      },
      { name: 'removeDesc', params: { removeAny: true } },
      'removeTitle',
      'removeMetadata',
      'removeComments',
      'removeRasterImages',
      'removeScripts',
      'removeStyleElement',
      'removeEditorsNSData',
    ],
  }).data
  return sanitizeSvg(optimized)
}

function chainToPath(chain: Chain, tolerance: number, penWidth: number): string {
  const simplified = simplify(dedupe(chain.points), 0.55)
  if (simplified.length < 2) return ''
  const pieces = splitAtCorners(simplified, chain.closed, Math.max(1, Math.round(penWidth * 0.45)))
  const commands: DrawCommand[] = []
  for (const piece of pieces) {
    commands.push(...fitPiece(piece, tolerance, 0))
  }
  const first = pieces[0]
  if (!first || commands.length === 0) return ''
  const start = at(first, 0)
  let data = `M${formatNumber(start.x)} ${formatNumber(start.y)}`
  for (const command of commands) {
    if (command.kind === 'L') {
      data += `L${formatNumber(command.point.x)} ${formatNumber(command.point.y)}`
    } else {
      data += `C${formatNumber(command.control1.x)} ${formatNumber(command.control1.y)} ${formatNumber(command.control2.x)} ${formatNumber(command.control2.y)} ${formatNumber(command.point.x)} ${formatNumber(command.point.y)}`
    }
  }
  if (chain.closed) data += 'Z'
  return data
}

/**
 * Least-squares cubic Bézier fitting.
 *
 * Schneider, P. J. "An Algorithm for Automatically Fitting Digitized Curves."
 * Graphics Gems, Academic Press, 1990.
 * Original implementation of the published method, with corner splits so a
 * sharp turn is not smoothed into one curve. Graphics Gems source was not copied.
 */
function fitPiece(points: Point[], tolerance: number, depth: number): DrawCommand[] {
  if (points.length < 2) return []
  if (points.length === 2 || maxChordDistance(points) <= tolerance) {
    return [{ kind: 'L', point: at(points, points.length - 1) }]
  }
  if (depth > 16) {
    return [{ kind: 'L', point: at(points, points.length - 1) }]
  }
  const fitted = fitCubic(points)
  if (
    fitted.error <= tolerance &&
    curveStaysNear(points, at(points, 0), fitted.control1, fitted.control2, at(points, points.length - 1), tolerance)
  ) {
    return [{ kind: 'C', control1: fitted.control1, control2: fitted.control2, point: at(points, points.length - 1) }]
  }
  let split = fitted.index
  if (split <= 1 || split >= points.length - 2) split = Math.floor(points.length / 2)
  if (split <= 0 || split >= points.length - 1) {
    return [{ kind: 'L', point: at(points, points.length - 1) }]
  }
  return [
    ...fitPiece(points.slice(0, split + 1), tolerance, depth + 1),
    ...fitPiece(points.slice(split), tolerance, depth + 1),
  ]
}

function fitCubic(points: Point[]): {
  control1: Point
  control2: Point
  error: number
  index: number
} {
  const start = at(points, 0)
  const end = at(points, points.length - 1)
  const parameters = chordParameters(points)
  const left = unit(subtract(at(points, Math.min(points.length - 1, tangentSpan(points))), start)) ?? { x: 1, y: 0 }
  const right =
    unit(subtract(at(points, Math.max(0, points.length - 1 - tangentSpan(points))), end)) ?? { x: -1, y: 0 }
  let alpha = distance(start, end) / 3
  let beta = alpha
  let controls = controlsFromTangents(start, end, left, right, alpha, beta)
  let parametersNow = parameters
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const solved = solveTangents(points, parametersNow, start, end, left, right)
    alpha = solved?.alpha ?? distance(start, end) / 3
    beta = solved?.beta ?? alpha
    if (alpha <= 0 || beta <= 0) {
      alpha = distance(start, end) / 3
      beta = alpha
    }
    controls = controlsFromTangents(start, end, left, right, alpha, beta)
    parametersNow = parametersNow.map((parameter, index) =>
      refineParameter(start, controls.control1, controls.control2, end, parameter, at(points, index)),
    )
  }
  const error = maxCurveDistance(points, start, controls.control1, controls.control2, end, parametersNow)
  return { control1: controls.control1, control2: controls.control2, error: error.distance, index: error.index }
}

function solveTangents(
  points: Point[],
  parameters: number[],
  start: Point,
  end: Point,
  left: Point,
  right: Point,
): { alpha: number; beta: number } | null {
  let c11 = 0
  let c12 = 0
  let c22 = 0
  let x1 = 0
  let x2 = 0
  const tangentDot = dot(left, right)
  for (let index = 0; index < points.length; index += 1) {
    const t = parameters[index] ?? 0
    const a1 = 3 * (1 - t) * (1 - t) * t
    const a2 = 3 * (1 - t) * t * t
    const anchor = add(scale(start, (1 - t) ** 3), scale(end, t ** 3))
    const residual = subtract(at(points, index), anchor)
    c11 += a1 * a1
    c12 += a1 * a2 * tangentDot
    c22 += a2 * a2
    x1 += a1 * dot(residual, left)
    x2 += a2 * dot(residual, right)
  }
  const determinant = c11 * c22 - c12 * c12
  if (Math.abs(determinant) < 1e-8 || c11 < 1e-8 || c22 < 1e-8) return null
  return {
    alpha: (x1 * c22 - x2 * c12) / determinant,
    beta: (c11 * x2 - c12 * x1) / determinant,
  }
}

function controlsFromTangents(
  start: Point,
  end: Point,
  left: Point,
  right: Point,
  alpha: number,
  beta: number,
): { control1: Point; control2: Point } {
  return {
    control1: add(start, scale(left, alpha)),
    control2: add(end, scale(right, beta)),
  }
}

function refineParameter(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  parameter: number,
  point: Point,
): number {
  let t = clamp(parameter, 0, 1)
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const curve = bezier(start, control1, control2, end, t)
    const first = bezierDerivative(start, control1, control2, end, t)
    const second = bezierSecond(start, control1, control2, end, t)
    const delta = subtract(curve, point)
    const denominator = dot(first, first) + dot(delta, second)
    if (Math.abs(denominator) < 1e-8) break
    t = clamp(t - dot(delta, first) / denominator, 0, 1)
  }
  return t
}

function maxCurveDistance(
  points: Point[],
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  parameters: number[],
): { distance: number; index: number } {
  let farthest = 0
  let index = 0
  for (let pointIndex = 1; pointIndex < points.length - 1; pointIndex += 1) {
    const parameter = parameters[pointIndex] ?? pointIndex / (points.length - 1)
    const projected = bezier(start, control1, control2, end, parameter)
    const error = distance(projected, at(points, pointIndex))
    if (error > farthest) {
      farthest = error
      index = pointIndex
    }
  }
  return { distance: farthest, index }
}

/** A least-squares cubic can bulge far from the ink when the tangent system is ill-conditioned. */
function curveStaysNear(
  points: Point[],
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  tolerance: number,
): boolean {
  const limit = tolerance * 1.5 + 0.75
  for (let step = 1; step < 8; step += 1) {
    const sample = bezier(start, control1, control2, end, step / 8)
    if (distanceToPolyline(sample, points) > limit) return false
  }
  return true
}

function distanceToPolyline(point: Point, points: Point[]): number {
  let nearest = Infinity
  for (let index = 1; index < points.length; index += 1) {
    nearest = Math.min(nearest, pointLineDistance(point, at(points, index - 1), at(points, index)))
  }
  return nearest
}

function maxChordDistance(points: Point[]): number {
  const start = at(points, 0)
  const end = at(points, points.length - 1)
  let farthest = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    farthest = Math.max(farthest, pointLineDistance(at(points, index), start, end))
  }
  return farthest
}

function splitAtCorners(points: Point[], closed: boolean, span: number): Point[][] {
  if (points.length < 3) return [points]
  const step = closed ? span : Math.min(span, Math.max(1, Math.floor((points.length - 1) / 4)))
  const corners: number[] = []
  const last = closed ? points.length : points.length - 1
  for (let index = closed ? 0 : step; index < last; index += 1) {
    if (!closed && (index < step || index > points.length - 1 - step)) continue
    const turn = turnDot(points, index, step, closed)
    if (turn < Math.cos((52 * Math.PI) / 180)) corners.push(index)
  }
  const kept = suppressCorners(points, corners, step, closed)
  if (kept.length === 0) {
    if (!closed) return [points]
    const middle = Math.floor(points.length / 2)
    return [wrap(points, 0, middle), wrap(points, middle, points.length)]
  }
  if (!closed) {
    const bounds = [0, ...kept, points.length - 1]
    const pieces: Point[][] = []
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const from = bounds[index] ?? 0
      const to = bounds[index + 1] ?? from
      pieces.push(points.slice(from, to + 1))
    }
    return pieces.filter((piece) => piece.length >= 2)
  }
  const pieces: Point[][] = []
  for (let index = 0; index < kept.length; index += 1) {
    const from = kept[index] ?? 0
    const to = kept[(index + 1) % kept.length] ?? from
    pieces.push(wrap(points, from, to))
  }
  return pieces.filter((piece) => piece.length >= 2)
}

function suppressCorners(points: Point[], corners: number[], span: number, closed: boolean): number[] {
  const kept: number[] = []
  for (const corner of corners) {
    const previous = kept[kept.length - 1]
    if (previous === undefined || indexDistance(points.length, previous, corner, closed) > span) {
      kept.push(corner)
      continue
    }
    const previousTurn = turnDot(points, previous, span, closed)
    const nextTurn = turnDot(points, corner, span, closed)
    if (nextTurn < previousTurn) kept[kept.length - 1] = corner
  }
  if (closed && kept.length > 1) {
    const first = kept[0] ?? 0
    const last = kept[kept.length - 1] ?? 0
    if (indexDistance(points.length, last, first, true) <= span) {
      const firstTurn = turnDot(points, first, span, true)
      const lastTurn = turnDot(points, last, span, true)
      if (firstTurn < lastTurn) kept.pop()
      else kept.shift()
    }
  }
  return kept
}

function turnDot(points: Point[], index: number, span: number, closed: boolean): number {
  const count = points.length
  const previous = closed ? (index - span + count) % count : Math.max(0, index - span)
  const next = closed ? (index + span) % count : Math.min(count - 1, index + span)
  const incoming = unit(subtract(at(points, index), at(points, previous)))
  const outgoing = unit(subtract(at(points, next), at(points, index)))
  if (!incoming || !outgoing) return 1
  return dot(incoming, outgoing)
}

function wrap(points: Point[], from: number, to: number): Point[] {
  if (to > from) return points.slice(from, to + 1)
  return [...points.slice(from), ...points.slice(0, to + 1)]
}

function indexDistance(count: number, from: number, to: number, closed: boolean): number {
  const direct = Math.abs(to - from)
  if (!closed) return direct
  return Math.min(direct, count - direct)
}

function traceChains(skeleton: Uint8Array, width: number, height: number): Chain[] {
  const degree = new Uint8Array(skeleton.length)
  for (let index = 0; index < skeleton.length; index += 1) {
    if (skeleton[index] === 1) degree[index] = neighborIndexes(skeleton, width, height, index).length
  }
  const visited = new Set<string>()
  const chains: Chain[] = []
  const walkFrom = (start: number) => {
    for (const next of neighborIndexes(skeleton, width, height, start)) {
      if (visited.has(edgeKey(start, next))) continue
      chains.push(walk(skeleton, degree, visited, width, height, start, next))
    }
  }
  for (let index = 0; index < skeleton.length; index += 1) {
    if (skeleton[index] !== 1) continue
    const count = degree[index] ?? 0
    if (count !== 2) walkFrom(index)
  }
  for (let index = 0; index < skeleton.length; index += 1) {
    if (skeleton[index] === 1 && (degree[index] ?? 0) === 2) walkFrom(index)
  }
  return chains
}

function walk(
  skeleton: Uint8Array,
  degree: Uint8Array,
  visited: Set<string>,
  width: number,
  height: number,
  start: number,
  next: number,
): Chain {
  const points = [pixelCenter(start, width), pixelCenter(next, width)]
  visited.add(edgeKey(start, next))
  let previous = start
  let current = next
  for (let guard = 0; guard < skeleton.length; guard += 1) {
    if (current === start) break
    if ((degree[current] ?? 0) !== 2) break
    let candidate = -1
    for (const neighbor of neighborIndexes(skeleton, width, height, current)) {
      if (neighbor === previous || visited.has(edgeKey(current, neighbor))) continue
      candidate = neighbor
      break
    }
    if (candidate < 0) break
    visited.add(edgeKey(current, candidate))
    previous = current
    current = candidate
    points.push(pixelCenter(current, width))
    if (current === start) break
  }
  const closed = points.length > 3 && samePoint(at(points, 0), at(points, points.length - 1))
  return { points: closed ? points.slice(0, -1) : dedupe(points), closed }
}

function pruneShort(chains: Chain[], minLength: number): Chain[] {
  let edges = chains.map((chain) => ({ points: chain.points.slice(), closed: chain.closed }))
  for (let guard = 0; guard < chains.length + 2; guard += 1) {
    const degree = new Map<string, number>()
    for (const edge of edges) {
      if (edge.closed || edge.points.length < 2) continue
      bump(degree, pointKey(at(edge.points, 0)))
      bump(degree, pointKey(at(edge.points, edge.points.length - 1)))
    }
    let removed = false
    edges = edges.filter((edge) => {
      const length = polylineLength(edge.points)
      if (edge.closed) {
        if (length < minLength) {
          removed = true
          return false
        }
        return true
      }
      if (edge.points.length < 2) {
        removed = true
        return false
      }
      const startDegree = degree.get(pointKey(at(edge.points, 0))) ?? 0
      const endDegree = degree.get(pointKey(at(edge.points, edge.points.length - 1))) ?? 0
      const dangling = startDegree <= 1 || endDegree <= 1
      if (dangling && length < minLength) {
        removed = true
        return false
      }
      return true
    })
    const merged = weldJoints(edges)
    const changed = removed || merged.length !== edges.length
    edges = merged
    if (!changed) break
  }
  return edges
}

function weldJoints(edges: Chain[]): Chain[] {
  let current = edges.slice()
  for (let guard = 0; guard < edges.length + 2; guard += 1) {
    const groups = new Map<string, number[]>()
    current.forEach((edge, index) => {
      if (edge.closed || edge.points.length < 2) return
      pushGroup(groups, pointKey(at(edge.points, 0)), index)
      pushGroup(groups, pointKey(at(edge.points, edge.points.length - 1)), index)
    })
    let welded = false
    for (const indexes of groups.values()) {
      if (indexes.length !== 2) continue
      const firstIndex = indexes[0] ?? -1
      const secondIndex = indexes[1] ?? -1
      if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) continue
      const first = current[firstIndex]
      const second = current[secondIndex]
      if (!first || !second || first.closed || second.closed) continue
      const joined = joinChains(first, second)
      if (!joined) continue
      current = current.filter((_, index) => index !== firstIndex && index !== secondIndex)
      current.push(joined)
      welded = true
      break
    }
    if (!welded) break
  }
  return current
}

function joinChains(first: Chain, second: Chain): Chain | null {
  const variants = [
    { left: first.points, right: second.points },
    { left: first.points, right: [...second.points].reverse() },
    { left: [...first.points].reverse(), right: second.points },
    { left: [...first.points].reverse(), right: [...second.points].reverse() },
  ]
  for (const variant of variants) {
    if (!samePoint(at(variant.left, variant.left.length - 1), at(variant.right, 0))) continue
    const points = dedupe([...variant.left, ...variant.right])
    const closed = points.length > 3 && samePoint(at(points, 0), at(points, points.length - 1))
    return { points: closed ? points.slice(0, -1) : points, closed }
  }
  return null
}

function trimHooks(points: Point[], maxHook: number, penWidth: number): Point[] {
  const trimmed = trimHookEnd([...trimHookEnd(points, maxHook, penWidth)].reverse(), maxHook, penWidth)
  return trimmed.reverse()
}

function trimHookEnd(points: Point[], maxHook: number, penWidth: number): Point[] {
  if (points.length < 8) return points
  const tip = at(points, 0)
  let arc = 0
  let farthest = 0
  let farthestDistance = 0
  for (let index = 1; index < points.length; index += 1) {
    arc += distance(at(points, index - 1), at(points, index))
    const tipDistance = distance(tip, at(points, index))
    if (tipDistance > farthestDistance) {
      farthestDistance = tipDistance
      farthest = index
    }
    if (arc <= maxHook && tipDistance < penWidth * 0.85 && farthestDistance > tipDistance * 1.8 && farthest > 2) {
      return points.slice(farthest)
    }
    if (arc > maxHook) break
  }
  return points
}

function mergeParallel(chains: Chain[], maxDistance: number): Chain[] {
  let current = chains.slice()
  for (let guard = 0; guard < chains.length + 1; guard += 1) {
    let merged = false
    for (let left = 0; left < current.length && !merged; left += 1) {
      for (let right = left + 1; right < current.length; right += 1) {
        const a = current[left]
        const b = current[right]
        if (!a || !b) continue
        const result = tryMerge(a, b, maxDistance)
        if (!result) continue
        current = current.filter((_, index) => index !== left && index !== right)
        current.push(result)
        merged = true
        break
      }
    }
    if (!merged) break
  }
  return current
}

function tryMerge(first: Chain, second: Chain, maxDistance: number): Chain | null {
  if (first.closed || second.closed) return null
  if (!boundsOverlap(first.points, second.points, maxDistance)) return null
  const primary = polylineLength(first.points) >= polylineLength(second.points) ? first : second
  const secondary = primary === first ? second : first
  const oriented = orientParallel(primary.points, secondary.points)
  if (!oriented) return null
  const hits = primary.points.map((point) => nearestAligned(oriented, point, maxDistance))
  const run = longestRun(hits)
  if (!run || run.end - run.start < 4) return null
  const matched = hits.slice(run.start, run.end + 1).filter((hit) => hit !== null).length
  if (matched < (run.end - run.start + 1) * 0.7) return null
  const secondaryIndexes = hits
    .slice(run.start, run.end + 1)
    .flatMap((hit) => (hit ? [hit.index] : []))
  if (secondaryIndexes.length === 0) return null
  const secondaryStart = Math.min(...secondaryIndexes)
  const secondaryEnd = Math.max(...secondaryIndexes)
  if (secondaryEnd - secondaryStart + 1 < oriented.length * 0.55) return null
  const points = primary.points.map((point, index) => {
    const hit = hits[index]
    if (!hit || index < run.start || index > run.end) return point
    return midpoint(point, hit.point)
  })
  const prefix = oriented.slice(0, secondaryStart)
  const suffix = oriented.slice(secondaryEnd + 1)
  const withPrefix = prefix.length > 1 ? dedupe([...prefix, ...points]) : points
  const combined = suffix.length > 1 ? dedupe([...withPrefix, ...suffix]) : withPrefix
  return { points: combined, closed: false }
}

function boundsOverlap(left: Point[], right: Point[], pad: number): boolean {
  const a = boundsOf(left)
  const b = boundsOf(right)
  return a.maxX + pad >= b.minX && b.maxX + pad >= a.minX && a.maxY + pad >= b.minY && b.maxY + pad >= a.minY
}

function boundsOf(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function orientParallel(primary: Point[], secondary: Point[]): Point[] | null {
  if (primary.length < 2 || secondary.length < 2) return null
  const origin = at(primary, Math.floor(primary.length / 2))
  const primaryTangent = tangentAt(primary, Math.floor(primary.length / 2))
  let nearest = 0
  let nearestDistance = Infinity
  for (let index = 0; index < secondary.length; index += 1) {
    const gap = distance(origin, at(secondary, index))
    if (gap < nearestDistance) {
      nearestDistance = gap
      nearest = index
    }
  }
  const secondaryTangent = tangentAt(secondary, nearest)
  if (!primaryTangent || !secondaryTangent) return null
  if (Math.abs(dot(primaryTangent, secondaryTangent)) < Math.cos((32 * Math.PI) / 180)) return null
  return dot(primaryTangent, secondaryTangent) < 0 ? [...secondary].reverse() : secondary.slice()
}

function nearestAligned(
  points: Point[],
  point: Point,
  maxDistance: number,
): { point: Point; index: number } | null {
  let best = -1
  let bestDistance = maxDistance
  for (let index = 0; index < points.length; index += 1) {
    const gap = distance(point, at(points, index))
    if (gap <= bestDistance) {
      bestDistance = gap
      best = index
    }
  }
  if (best < 0) return null
  return { point: at(points, best), index: best }
}

function longestRun(hits: Array<{ point: Point; index: number } | null>): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null
  let start = -1
  for (let index = 0; index <= hits.length; index += 1) {
    const matched = index < hits.length && hits[index] !== null
    if (matched && start < 0) start = index
    if ((!matched || index === hits.length) && start >= 0) {
      const end = index - 1
      if (!best || end - start > best.end - best.start) best = { start, end }
      start = -1
    }
  }
  return best
}

type Endpoint = { chain: number; atStart: boolean }

function joinGaps(chains: Chain[], maxGap: number): Chain[] {
  let current = chains.map((chain) => ({ points: chain.points.slice(), closed: chain.closed }))
  for (let guard = 0; guard < chains.length + 2; guard += 1) {
    const pair = closestEndpoints(current, maxGap)
    if (!pair) break
    const left = current[pair.left.chain]
    const right = current[pair.right.chain]
    if (!left || !right) break
    if (pair.left.chain === pair.right.chain) {
      if (left.closed || polylineLength(left.points) < maxGap * 2) break
      current[pair.left.chain] = { points: bridgeEnds(left.points), closed: true }
      continue
    }
    const joined = concatEndpoints(left, pair.left.atStart, right, pair.right.atStart)
    const dropLeft = pair.left.chain
    const dropRight = pair.right.chain
    current = current.filter((_, index) => index !== dropLeft && index !== dropRight)
    current.push(joined)
  }
  return current
}

function closestEndpoints(
  chains: Chain[],
  maxGap: number,
): { left: Endpoint; right: Endpoint; gap: number } | null {
  let best: { left: Endpoint; right: Endpoint; gap: number } | null = null
  const ends: Endpoint[] = []
  chains.forEach((chain, index) => {
    if (chain.closed || chain.points.length < 2) return
    ends.push({ chain: index, atStart: true }, { chain: index, atStart: false })
  })
  for (let left = 0; left < ends.length; left += 1) {
    for (let right = left + 1; right < ends.length; right += 1) {
      const a = ends[left]
      const b = ends[right]
      if (!a || !b) continue
      if (a.chain === b.chain && a.atStart === b.atStart) continue
      const chainA = chains[a.chain]
      const chainB = chains[b.chain]
      if (!chainA || !chainB) continue
      const pointA = endpointPoint(chainA, a.atStart)
      const pointB = endpointPoint(chainB, b.atStart)
      const gap = distance(pointA, pointB)
      if (gap > maxGap) continue
      if (gap < 0.75 && a.chain !== b.chain) continue
      if (a.chain === b.chain && polylineLength(chainA.points) < maxGap * 2) continue
      const toward = gap < maxGap * 0.45 || (faces(chainA, a.atStart, pointB) && faces(chainB, b.atStart, pointA))
      if (!toward) continue
      if (!best || gap < best.gap) best = { left: a, right: b, gap }
    }
  }
  return best
}

function bridgeEnds(points: Point[]): Point[] {
  const start = at(points, 0)
  const end = at(points, points.length - 1)
  const outwardStart = outwardTangent(points, true)
  const outwardEnd = outwardTangent(points, false)
  const corner =
    outwardStart && outwardEnd ? rayHit(start, outwardStart, end, outwardEnd, distance(start, end) * 2) : null
  if (corner) return dedupe([...points, corner])
  return points
}

function concatEndpoints(left: Chain, leftStart: boolean, right: Chain, rightStart: boolean): Chain {
  const a = leftStart ? [...left.points].reverse() : left.points.slice()
  const b = rightStart ? right.points.slice() : [...right.points].reverse()
  const end = at(a, a.length - 1)
  const start = at(b, 0)
  const tangentA = outwardTangent(a, false)
  const tangentB = outwardTangent(b, true)
  const corner = tangentA && tangentB ? rayHit(end, tangentA, start, tangentB, distance(end, start) * 2) : null
  const points = corner ? dedupe([...a, corner, ...b]) : dedupe([...a, ...b])
  return { points, closed: false }
}

function faces(chain: Chain, atStart: boolean, target: Point): boolean {
  const origin = endpointPoint(chain, atStart)
  const tangent = outwardTangent(chain.points, atStart)
  const toward = unit(subtract(target, origin))
  if (!tangent || !toward) return true
  return dot(tangent, toward) > 0.05
}

function endpointPoint(chain: Chain, atStart: boolean): Point {
  return atStart ? at(chain.points, 0) : at(chain.points, chain.points.length - 1)
}

function outwardTangent(points: Point[], atStart: boolean): Point | null {
  if (points.length < 2) return null
  const span = Math.min(tangentSpan(points), points.length - 1)
  if (atStart) return unit(subtract(at(points, 0), at(points, span)))
  return unit(subtract(at(points, points.length - 1), at(points, points.length - 1 - span)))
}

function rayHit(originA: Point, directionA: Point, originB: Point, directionB: Point, limit: number): Point | null {
  const cross = directionA.x * directionB.y - directionA.y * directionB.x
  if (Math.abs(cross) < 1e-3) return null
  const dx = originB.x - originA.x
  const dy = originB.y - originA.y
  const t = (dx * directionB.y - dy * directionB.x) / cross
  const u = (dx * directionA.y - dy * directionA.x) / cross
  if (t <= 0.2 || u <= 0.2 || t > limit || u > limit) return null
  return add(originA, scale(directionA, t))
}

function clearBlocks(skeleton: Uint8Array, width: number, height: number): void {
  let changed = true
  while (changed) {
    changed = false
    for (let y = 0; y < height - 1; y += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const topLeft = y * width + x
        if (
          skeleton[topLeft] === 1 &&
          skeleton[topLeft + 1] === 1 &&
          skeleton[topLeft + width] === 1 &&
          skeleton[topLeft + width + 1] === 1
        ) {
          skeleton[topLeft + width + 1] = 0
          changed = true
        }
      }
    }
  }
}

function neighborIndexes(skeleton: Uint8Array, width: number, height: number, index: number): number[] {
  const x = index % width
  const y = (index - x) / width
  const found: number[] = []
  for (const offset of NEIGHBORS) {
    const nextX = x + (offset[0] ?? 0)
    const nextY = y + (offset[1] ?? 0)
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
    const next = nextY * width + nextX
    if (skeleton[next] === 1) found.push(next)
  }
  return found
}

function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points
  const start = at(points, 0)
  const end = at(points, points.length - 1)
  let farthest = 0
  let index = 0
  for (let pointIndex = 1; pointIndex < points.length - 1; pointIndex += 1) {
    const gap = pointLineDistance(at(points, pointIndex), start, end)
    if (gap > farthest) {
      farthest = gap
      index = pointIndex
    }
  }
  if (farthest <= epsilon || index === 0) return [start, end]
  const left = simplify(points.slice(0, index + 1), epsilon)
  const right = simplify(points.slice(index), epsilon)
  return [...left.slice(0, -1), ...right]
}

function chordParameters(points: Point[]): number[] {
  const parameters = [0]
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += distance(at(points, index - 1), at(points, index))
    parameters.push(total)
  }
  if (total === 0) return points.map((_, index) => index / Math.max(1, points.length - 1))
  return parameters.map((value) => value / total)
}

function tangentSpan(points: Point[]): number {
  return Math.max(1, Math.min(6, Math.floor(points.length / 8)))
}

function tangentAt(points: Point[], index: number): Point | null {
  const span = tangentSpan(points)
  const from = Math.max(0, index - span)
  const to = Math.min(points.length - 1, index + span)
  return unit(subtract(at(points, to), at(points, from)))
}

function pixelCenter(index: number, width: number): Point {
  const x = index % width
  const y = (index - x) / width
  return { x: x + 0.5, y: y + 0.5 }
}

function polylineLength(points: Point[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += distance(at(points, index - 1), at(points, index))
  }
  return length
}

function dedupe(points: Point[]): Point[] {
  const result: Point[] = []
  for (const point of points) {
    const previous = result[result.length - 1]
    if (!previous || !samePoint(previous, point)) result.push(point)
  }
  return result
}

function pointLineDistance(point: Point, start: Point, end: Point): number {
  const length = distance(start, end)
  if (length < 1e-6) return distance(point, start)
  const t = clamp(dot(subtract(point, start), subtract(end, start)) / (length * length), 0, 1)
  return distance(point, add(start, scale(subtract(end, start), t)))
}

function bezier(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const u = 1 - t
  return add(
    add(scale(start, u * u * u), scale(control1, 3 * u * u * t)),
    add(scale(control2, 3 * u * t * t), scale(end, t * t * t)),
  )
}

function bezierDerivative(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const u = 1 - t
  return add(
    add(scale(subtract(control1, start), 3 * u * u), scale(subtract(control2, control1), 6 * u * t)),
    scale(subtract(end, control2), 3 * t * t),
  )
}

function bezierSecond(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const left = add(subtract(control2, scale(control1, 2)), start)
  const right = add(subtract(end, scale(control2, 2)), control1)
  return add(scale(left, 6 * (1 - t)), scale(right, 6 * t))
}

function inkCount(ink: Uint8Array): number {
  let count = 0
  for (const pixel of ink) if (pixel === 1) count += 1
  return count
}

function edgeKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`
}

function pointKey(point: Point): string {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
}

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) < 0.2 && Math.abs(left.y - right.y) < 0.2
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function pushGroup(groups: Map<string, number[]>, key: string, index: number): void {
  const existing = groups.get(key)
  if (existing) existing.push(index)
  else groups.set(key, [index])
}

function midpoint(left: Point, right: Point): Point {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
}

function add(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y }
}

function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y }
}

function scale(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor }
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function unit(point: Point): Point | null {
  const length = Math.hypot(point.x, point.y)
  if (length < 1e-6) return null
  return { x: point.x / length, y: point.y / length }
}

function at(points: readonly Point[], index: number): Point {
  const point = points[index]
  if (!point) throw new Error('point index out of range')
  return point
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
