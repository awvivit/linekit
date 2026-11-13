import type { PerspectiveQuad, TraceView } from './limits.ts'
import { IMAGE_QUAD } from './perspective.ts'

export type Point = { x: number; y: number }

export type Stroke = {
  id: number
  points: Point[]
  closed: boolean
  /** Null uses the document smoothing when the stroke is drawn. */
  smoothing: number | null
  /** Original path data for an outline that has not been rewritten. */
  source: string | null
}

export type EditableModel = {
  width: number
  height: number
  penWidth: number
  kind: 'stroke' | 'fill'
  strokes: Stroke[]
}

export type EraserMark = {
  points: Point[]
  radius: number
}

export type FrozenTrace = {
  stamp: string
  rawSvg: string | null
  model: EditableModel | null
}

export type EditSnapshot = {
  straighten: boolean
  tolerance: number
  closeGaps: boolean
  gap: number
  erasers: EraserMark[]
  overrides: Record<string, number>
  perspectiveOn: boolean
  quad: PerspectiveQuad
  selectedId: number | null
  view: TraceView
  /** Restores a traced result without running the pipeline again. */
  frozen: FrozenTrace | null
}

export const DEFAULT_EDIT: EditSnapshot = {
  straighten: false,
  tolerance: 45,
  closeGaps: false,
  gap: 24,
  erasers: [],
  overrides: {},
  perspectiveOn: false,
  quad: IMAGE_QUAD,
  selectedId: null,
  view: 'auto',
  frozen: null,
}

export function sameSnapshot(left: EditSnapshot, right: EditSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function editsActive(edit: EditSnapshot): boolean {
  return (
    edit.straighten ||
    edit.closeGaps ||
    edit.erasers.some((mark) => mark.points.length > 0) ||
    Object.keys(edit.overrides).length > 0
  )
}

export function editableFromCenterline(model: {
  width: number
  height: number
  penWidth: number
  chains: ReadonlyArray<{ points: Point[]; closed: boolean }>
}): EditableModel {
  return {
    width: model.width,
    height: model.height,
    penWidth: model.penWidth,
    kind: 'stroke',
    strokes: model.chains.map((chain, id) => ({
      id,
      points: chain.points.map((point) => ({ x: point.x, y: point.y })),
      closed: chain.closed,
      smoothing: null,
      source: null,
    })),
  }
}

export function cloneModel(model: EditableModel): EditableModel {
  return {
    ...model,
    strokes: model.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
    })),
  }
}

/** Slider 0–100 becomes a gap in trace pixels, up to 12% of the long side. */
export function gapPixels(value: number, maxEdge: number): number {
  return (clamp(value, 0, 100) / 100) * Math.max(1, maxEdge) * 0.12
}

export function applyEdits(model: EditableModel, edit: EditSnapshot): EditableModel {
  let strokes = model.strokes.map((stroke) => {
    const override = edit.overrides[String(stroke.id)]
    return {
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
      smoothing: override === undefined ? stroke.smoothing : override,
    }
  })
  if (edit.closeGaps) {
    strokes = closeGapStrokes(strokes, gapPixels(edit.gap, Math.max(model.width, model.height)))
  }
  if (edit.straighten) {
    strokes = straightenStrokes(strokes, edit.tolerance, Math.min(model.width, model.height))
  }
  for (const mark of edit.erasers) {
    if (mark.points.length > 0 && mark.radius > 0) strokes = eraseNear(strokes, mark.points, mark.radius)
  }
  return { ...model, strokes }
}

/**
 * Snap near-straight strokes to lines, and near rectangles, circles, and
 * ellipses to those shapes. `tolerance` is 0–100. `shortSide` is the shorter
 * pixel side of the drawing, used to scale how far a point may stray.
 */
export function straightenStrokes(strokes: Stroke[], tolerance: number, shortSide: number): Stroke[] {
  const allowance = 0.75 + (clamp(tolerance, 0, 100) / 100) * Math.max(6, shortSide * 0.08)
  return strokes.map((stroke) => snapStroke(stroke, allowance) ?? stroke)
}

export function closeGapStrokes(strokes: Stroke[], distance: number): Stroke[] {
  if (distance <= 0) return strokes
  let current = strokes.map(copyStroke)
  for (let guard = 0; guard < strokes.length + 2; guard += 1) {
    const pair = closestEnds(current, distance)
    if (!pair) break
    if (pair.left.index === pair.right.index) {
      const stroke = current[pair.left.index]
      if (!stroke) break
      current[pair.left.index] = { ...stroke, closed: true, source: null }
      continue
    }
    const left = current[pair.left.index]
    const right = current[pair.right.index]
    if (!left || !right) break
    const joined = stitch(left, pair.left.atStart, right, pair.right.atStart)
    const next = current.filter((_stroke, index) => index !== pair.left.index && index !== pair.right.index)
    next.push(joined)
    current = next
  }
  return current
}

/** Drop the parts of each stroke that pass within `radius` of the eraser. */
export function eraseNear(strokes: Stroke[], eraser: Point[], radius: number): Stroke[] {
  if (eraser.length === 0 || radius <= 0) return strokes
  const output: Stroke[] = []
  let nextId = strokes.reduce((max, stroke) => Math.max(max, stroke.id), 0) + 1
  for (const stroke of strokes) {
    const pieces = cutStroke(stroke, eraser, radius)
    if (!pieces) {
      output.push(stroke)
      continue
    }
    for (const points of pieces) {
      output.push({
        id: nextId,
        points,
        closed: false,
        smoothing: stroke.smoothing,
        source: null,
      })
      nextId += 1
    }
  }
  return output
}

export function nearestStroke(strokes: readonly Stroke[], point: Point, slop: number): number | null {
  let bestId: number | null = null
  let best = slop
  for (const stroke of strokes) {
    const distance = distanceToStroke(point, stroke.points, stroke.closed)
    if (distance <= best) {
      best = distance
      bestId = stroke.id
    }
  }
  return bestId
}

export function strokesFromSvg(svg: string): Stroke[] {
  const paths = [...svg.matchAll(/\bd="([^"]*)"/g)].flatMap((match) => (match[1] ? [match[1]] : []))
  const strokes: Stroke[] = []
  for (const data of paths) {
    const subpaths = parseSubpaths(data)
    const single = subpaths.length === 1
    for (const subpath of subpaths) {
      if (subpath.points.length < 2) continue
      strokes.push({
        id: strokes.length,
        points: subpath.points,
        closed: subpath.closed,
        smoothing: null,
        source: single ? data : null,
      })
    }
  }
  return strokes
}

export function renderPoints(stroke: Stroke): Point[] {
  if (stroke.smoothing === null) return stroke.points
  const epsilon = 0.35 + (clamp(stroke.smoothing, 0, 100) / 100) * 7
  return simplify(stroke.points, epsilon, stroke.closed)
}

function snapStroke(stroke: Stroke, allowance: number): Stroke | null {
  if (stroke.points.length < 3) return null
  if (stroke.closed) {
    const rectangle = snapRectangle(stroke.points, allowance)
    if (rectangle) return rewritten(stroke, rectangle, true)
    const circle = snapCircle(stroke.points, allowance)
    if (circle) return rewritten(stroke, circle, true)
    const ellipse = snapEllipse(stroke.points, allowance)
    if (ellipse) return rewritten(stroke, ellipse, true)
    return null
  }
  const line = snapLine(stroke.points, allowance)
  if (!line) return null
  return rewritten(stroke, line, false)
}

function rewritten(stroke: Stroke, points: Point[], closed: boolean): Stroke {
  return { ...stroke, points, closed, source: null }
}

function snapLine(points: Point[], allowance: number): Point[] | null {
  const fit = fitLine(points)
  if (!fit || fit.error > allowance) return null
  if (distance(fit.start, fit.end) <= allowance * 3) return null
  return [fit.start, fit.end]
}

function fitLine(points: Point[]): { start: Point; end: Point; error: number } | null {
  const center = centroid(points)
  let xx = 0
  let xy = 0
  let yy = 0
  for (const point of points) {
    const dx = point.x - center.x
    const dy = point.y - center.y
    xx += dx * dx
    xy += dx * dy
    yy += dy * dy
  }
  const direction = principalAxis(xx, xy, yy)
  if (!direction) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let error = 0
  for (const point of points) {
    const along = dot(subtract(point, center), direction)
    min = Math.min(min, along)
    max = Math.max(max, along)
    const projected = add(center, scale(direction, along))
    error = Math.max(error, distance(point, projected))
  }
  return {
    start: add(center, scale(direction, min)),
    end: add(center, scale(direction, max)),
    error,
  }
}

function snapRectangle(points: Point[], allowance: number): Point[] | null {
  const aligned = snapAxisAlignedRectangle(points, allowance)
  if (aligned) return aligned
  return snapRotatedRectangle(points, allowance)
}

function snapAxisAlignedRectangle(points: Point[], allowance: number): Point[] | null {
  const box = bounds(points)
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  if (width < allowance * 2 || height < allowance * 2) return null
  const spans = { left: emptySpan(), right: emptySpan(), top: emptySpan(), bottom: emptySpan() }
  for (const point of points) {
    const left = Math.abs(point.x - box.minX)
    const right = Math.abs(point.x - box.maxX)
    const top = Math.abs(point.y - box.minY)
    const bottom = Math.abs(point.y - box.maxY)
    const nearest = Math.min(left, right, top, bottom)
    if (nearest > allowance) return null
    if (nearest === left) cover(spans.left, point.y)
    else if (nearest === right) cover(spans.right, point.y)
    else if (nearest === top) cover(spans.top, point.x)
    else cover(spans.bottom, point.x)
  }
  if (spans.left.max - spans.left.min < height * 0.45) return null
  if (spans.right.max - spans.right.min < height * 0.45) return null
  if (spans.top.max - spans.top.min < width * 0.45) return null
  if (spans.bottom.max - spans.bottom.min < width * 0.45) return null
  return [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ]
}

function snapRotatedRectangle(points: Point[], allowance: number): Point[] | null {
  const corners = cornerIndexes(points, allowance)
  if (corners.length !== 4) return null
  const cornerPoints = corners.map((index) => points[index]).filter((point): point is Point => point !== undefined)
  if (cornerPoints.length !== 4) return null
  for (let index = 0; index < 4; index += 1) {
    const start = cornerPoints[index]
    const end = cornerPoints[(index + 1) % 4]
    const from = corners[index]
    const to = corners[(index + 1) % 4]
    if (start === undefined || end === undefined || from === undefined || to === undefined) return null
    if (sideError(points, from, to, start, end) > allowance) return null
    const next = cornerPoints[(index + 2) % 4]
    if (!next) return null
    const first = unit(subtract(end, start))
    const second = unit(subtract(next, end))
    if (!first || !second || Math.abs(dot(first, second)) > 0.45) return null
  }
  const snapped = orthogonalCorners(cornerPoints)
  if (!snapped) return null
  for (let index = 0; index < 4; index += 1) {
    const original = cornerPoints[index]
    const next = snapped[index]
    if (!original || !next || distance(original, next) > allowance) return null
  }
  return snapped
}

function cornerIndexes(points: Point[], allowance: number): number[] {
  const count = points.length
  const span = Math.max(1, Math.min(4, Math.floor(count / 16)))
  const turns: number[] = []
  for (let index = 0; index < count; index += 1) {
    turns.push(turnAngle(points, index, span))
  }
  const found: number[] = []
  for (let index = 0; index < count; index += 1) {
    const angle = turns[index] ?? 0
    if (angle < 0.7) continue
    const previous = turns[(index - 1 + count) % count] ?? 0
    const next = turns[(index + 1) % count] ?? 0
    if (angle < previous || angle < next) continue
    const last = found[found.length - 1]
    if (last !== undefined && Math.min(Math.abs(index - last), count - Math.abs(index - last)) <= span * 2) {
      if (angle > (turns[last] ?? 0)) found[found.length - 1] = index
      continue
    }
    found.push(index)
  }
  if (found.length > 1) {
    const first = found[0]
    const last = found[found.length - 1]
    if (first !== undefined && last !== undefined && Math.min(Math.abs(first - last), count - Math.abs(first - last)) <= span * 2) {
      if ((turns[last] ?? 0) > (turns[first] ?? 0)) found.shift()
      else found.pop()
    }
  }
  if (found.length !== 4) return []
  const separated = found.every((index, position) => {
    const next = found[(position + 1) % found.length]
    if (next === undefined) return false
    const gap = Math.min(Math.abs(next - index), count - Math.abs(next - index))
    return gap > allowance
  })
  return separated ? found : []
}

function turnAngle(points: Point[], index: number, span: number): number {
  const count = points.length
  const previous = points[(index - span + count) % count]
  const current = points[index]
  const next = points[(index + span) % count]
  if (!previous || !current || !next) return 0
  const incoming = unit(subtract(current, previous))
  const outgoing = unit(subtract(next, current))
  if (!incoming || !outgoing) return 0
  return Math.atan2(Math.abs(cross(incoming, outgoing)), dot(incoming, outgoing))
}

function sideError(points: Point[], from: number, to: number, start: Point, end: Point): number {
  const count = points.length
  let error = 0
  let index = from
  let guard = 0
  while (index !== to && guard <= count) {
    const point = points[index]
    if (point) error = Math.max(error, pointSegmentDistance(point, start, end))
    index = (index + 1) % count
    guard += 1
  }
  return error
}

function orthogonalCorners(corners: Point[]): Point[] | null {
  const origin = corners[0]
  const across = corners[1]
  const opposite = corners[2]
  const back = corners[3]
  if (!origin || !across || !opposite || !back) return null
  const forward = unit(subtract(across, origin))
  const other = unit(subtract(opposite, back))
  if (!forward || !other) return null
  const sign = dot(forward, other) < 0 ? -1 : 1
  const axis = unit({ x: forward.x + sign * other.x, y: forward.y + sign * other.y })
  if (!axis) return null
  let normal = { x: -axis.y, y: axis.x }
  if (dot(subtract(back, origin), normal) < 0) normal = scale(normal, -1)
  const projected = corners.map((point) => ({
    x: dot(subtract(point, origin), axis),
    y: dot(subtract(point, origin), normal),
  }))
  const minX = Math.min(...projected.map((point) => point.x))
  const maxX = Math.max(...projected.map((point) => point.x))
  const minY = Math.min(...projected.map((point) => point.y))
  const maxY = Math.max(...projected.map((point) => point.y))
  const local = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  const world = local.map((point) => add(origin, add(scale(axis, point.x), scale(normal, point.y))))
  let shift = 0
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < 4; index += 1) {
    const point = world[index]
    if (!point) continue
    const gap = distance(point, origin)
    if (gap < best) {
      best = gap
      shift = index
    }
  }
  return [0, 1, 2, 3].flatMap((offset) => {
    const point = world[(offset + shift) % 4]
    return point ? [point] : []
  })
}

function snapCircle(points: Point[], allowance: number): Point[] | null {
  const center = centroid(points)
  let radius = 0
  for (const point of points) radius += distance(point, center)
  radius /= points.length
  if (radius < allowance * 2) return null
  let error = 0
  for (const point of points) error = Math.max(error, Math.abs(distance(point, center) - radius))
  if (error > allowance) return null
  const box = bounds(points)
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  if (Math.abs(width - height) > allowance * 2) return null
  return polygon(center, radius, radius, { x: 1, y: 0 }, 48)
}

function snapEllipse(points: Point[], allowance: number): Point[] | null {
  const center = centroid(points)
  let xx = 0
  let xy = 0
  let yy = 0
  for (const point of points) {
    const dx = point.x - center.x
    const dy = point.y - center.y
    xx += dx * dx
    xy += dx * dy
    yy += dy * dy
  }
  const count = points.length
  xx /= count
  xy /= count
  yy /= count
  const axis = principalAxis(xx, xy, yy)
  if (!axis) return null
  const majorVariance = axisVariance(xx, xy, yy, axis)
  const minorAxis = { x: -axis.y, y: axis.x }
  const minorVariance = axisVariance(xx, xy, yy, minorAxis)
  const major = Math.sqrt(Math.max(0, 2 * majorVariance))
  const minor = Math.sqrt(Math.max(0, 2 * minorVariance))
  if (major < allowance * 2 || minor < allowance * 2) return null
  if (Math.abs(major - minor) <= allowance) return null
  let error = 0
  for (const point of points) {
    const offset = subtract(point, center)
    const along = dot(offset, axis)
    const across = dot(offset, minorAxis)
    const radial = Math.hypot(along / major, across / minor)
    error = Math.max(error, Math.abs(radial - 1) * ((major + minor) / 2))
  }
  if (error > allowance) return null
  return polygon(center, major, minor, axis, 48)
}

function polygon(center: Point, major: number, minor: number, axis: Point, count: number): Point[] {
  const normal = { x: -axis.y, y: axis.x }
  const points: Point[] = []
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2
    const along = Math.cos(angle) * major
    const across = Math.sin(angle) * minor
    points.push(add(center, add(scale(axis, along), scale(normal, across))))
  }
  return points
}

type EndRef = { index: number; atStart: boolean }

function closestEnds(
  strokes: Stroke[],
  distanceLimit: number,
): { left: EndRef; right: EndRef; gap: number } | null {
  const ends: EndRef[] = []
  strokes.forEach((stroke, index) => {
    if (stroke.closed || stroke.points.length < 2) return
    ends.push({ index, atStart: true }, { index, atStart: false })
  })
  let best: { left: EndRef; right: EndRef; gap: number } | null = null
  for (let left = 0; left < ends.length; left += 1) {
    for (let right = left + 1; right < ends.length; right += 1) {
      const a = ends[left]
      const b = ends[right]
      if (!a || !b) continue
      if (a.index === b.index && a.atStart === b.atStart) continue
      if (a.index === b.index) {
        const stroke = strokes[a.index]
        if (!stroke || stroke.points.length < 4 || polylineLength(stroke.points) <= distanceLimit) continue
      }
      const pointA = endpoint(strokes[a.index], a.atStart)
      const pointB = endpoint(strokes[b.index], b.atStart)
      if (!pointA || !pointB) continue
      const gap = distance(pointA, pointB)
      if (gap > distanceLimit) continue
      if (!best || gap < best.gap) best = { left: a, right: b, gap }
    }
  }
  return best
}

function stitch(left: Stroke, leftAtStart: boolean, right: Stroke, rightAtStart: boolean): Stroke {
  const lead = leftAtStart ? [...left.points].reverse() : [...left.points]
  const follow = rightAtStart ? [...right.points] : [...right.points].reverse()
  const points = joinPolylines(lead, follow)
  const smoothing = left.smoothing ?? right.smoothing
  return { id: left.id, points, closed: false, smoothing, source: null }
}

function joinPolylines(lead: Point[], follow: Point[]): Point[] {
  const points = [...lead]
  const first = follow[0]
  const last = points[points.length - 1]
  const start = first && last && distance(last, first) <= 0.5 ? 1 : 0
  for (let index = start; index < follow.length; index += 1) {
    const point = follow[index]
    if (point) points.push(point)
  }
  return points
}

function cutStroke(stroke: Stroke, eraser: Point[], radius: number): Point[][] | null {
  const dense = densify(stroke.points, stroke.closed, Math.max(1.5, radius / 3))
  if (dense.length < 2) return null
  const dead = dense.map((point) => nearPolyline(point, eraser, false) <= radius)
  if (dead.every((marked) => !marked)) return null
  if (dead.every(Boolean)) return []
  const open = stroke.closed ? rotateToCut(dense, dead) : { points: dense, dead }
  const pieces: Point[][] = []
  let run: Point[] = []
  for (let index = 0; index < open.points.length; index += 1) {
    const point = open.points[index]
    if (!point) continue
    if (open.dead[index]) {
      if (run.length >= 2 && polylineLength(run) > radius * 0.35) pieces.push(run)
      run = []
      continue
    }
    run.push(point)
  }
  if (run.length >= 2 && polylineLength(run) > radius * 0.35) pieces.push(run)
  return pieces
}

function rotateToCut(points: Point[], dead: boolean[]): { points: Point[]; dead: boolean[] } {
  const start = dead.findIndex(Boolean)
  if (start <= 0) return { points, dead }
  return {
    points: [...points.slice(start), ...points.slice(0, start)],
    dead: [...dead.slice(start), ...dead.slice(0, start)],
  }
}

function densify(points: Point[], closed: boolean, step: number): Point[] {
  if (points.length < 2) return points.map((point) => ({ ...point }))
  const output: Point[] = []
  const count = closed ? points.length : points.length - 1
  for (let index = 0; index < count; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (!start || !end) continue
    const length = distance(start, end)
    const segments = Math.max(1, Math.ceil(length / step))
    for (let part = 0; part < segments; part += 1) {
      output.push(lerp(start, end, part / segments))
    }
  }
  if (!closed) {
    const last = points[points.length - 1]
    if (last) output.push({ ...last })
  }
  return output
}

function parseSubpaths(data: string): { points: Point[]; closed: boolean }[] {
  const pattern = /([MmLlHhVvCcQqZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g
  const subpaths: { points: Point[]; closed: boolean }[] = []
  let command = ''
  let relative = false
  const numbers: number[] = []
  let cursor = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  let current: Point[] = []
  let closed = false
  const push = (point: Point) => {
    const last = current[current.length - 1]
    if (!last || distance(last, point) > 0.05) current.push(point)
    cursor = point
  }
  const finish = () => {
    if (current.length >= 2) subpaths.push({ points: current, closed })
    current = []
    closed = false
  }
  const flush = () => {
    const arity =
      command === 'M' || command === 'L' ? 2 : command === 'H' || command === 'V' ? 1 : command === 'C' ? 6 : command === 'Q' ? 4 : 0
    while (command && arity > 0 && numbers.length >= arity) {
      const take = numbers.splice(0, arity)
      if (command === 'M') {
        finish()
        const point = absolute(cursor, take[0] ?? 0, take[1] ?? 0, relative)
        start = point
        push(point)
        command = 'L'
      } else if (command === 'L') {
        push(absolute(cursor, take[0] ?? 0, take[1] ?? 0, relative))
      } else if (command === 'H') {
        const x = relative ? cursor.x + (take[0] ?? 0) : (take[0] ?? 0)
        push({ x, y: cursor.y })
      } else if (command === 'V') {
        const y = relative ? cursor.y + (take[0] ?? 0) : (take[0] ?? 0)
        push({ x: cursor.x, y })
      } else if (command === 'C') {
        const control1 = absolute(cursor, take[0] ?? 0, take[1] ?? 0, relative)
        const control2 = absolute(cursor, take[2] ?? 0, take[3] ?? 0, relative)
        const end = absolute(cursor, take[4] ?? 0, take[5] ?? 0, relative)
        const origin = cursor
        for (let step = 1; step <= 8; step += 1) push(cubic(origin, control1, control2, end, step / 8))
      } else if (command === 'Q') {
        const control = absolute(cursor, take[0] ?? 0, take[1] ?? 0, relative)
        const end = absolute(cursor, take[2] ?? 0, take[3] ?? 0, relative)
        const origin = cursor
        for (let step = 1; step <= 8; step += 1) push(quadratic(origin, control, end, step / 8))
      }
    }
  }
  for (const match of data.matchAll(pattern)) {
    const piece = match[0] ?? ''
    if (/[a-zA-Z]/.test(piece)) {
      flush()
      relative = piece === piece.toLowerCase()
      command = piece.toUpperCase()
      if (command === 'Z') {
        closed = true
        finish()
        cursor = start
        command = ''
      }
      continue
    }
    numbers.push(Number(piece))
  }
  flush()
  finish()
  return subpaths
}

function absolute(cursor: Point, x: number, y: number, relative: boolean): Point {
  return relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y }
}

function cubic(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const inverse = 1 - t
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y,
  }
}

function quadratic(start: Point, control: Point, end: Point, t: number): Point {
  const inverse = 1 - t
  return {
    x: inverse ** 2 * start.x + 2 * inverse * t * control.x + t ** 2 * end.x,
    y: inverse ** 2 * start.y + 2 * inverse * t * control.y + t ** 2 * end.y,
  }
}

function simplify(points: Point[], epsilon: number, closed: boolean): Point[] {
  if (points.length < 3 || epsilon <= 0) return points.map((point) => ({ ...point }))
  const ring = closed ? [...points, points[0] ?? points[points.length - 1] ?? { x: 0, y: 0 }] : points
  const kept = ramer(ring, 0, ring.length - 1, epsilon)
  const simplified = kept.map((index) => ring[index]).filter((point): point is Point => point !== undefined)
  if (closed && simplified.length > 1) simplified.pop()
  return simplified.length >= 2 ? simplified : points.map((point) => ({ ...point }))
}

function ramer(points: Point[], start: number, end: number, epsilon: number): number[] {
  const from = points[start]
  const to = points[end]
  if (!from || !to || end <= start + 1) return [start, end]
  let farthest = 0
  let index = start
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const point = points[cursor]
    if (!point) continue
    const gap = pointSegmentDistance(point, from, to)
    if (gap > farthest) {
      farthest = gap
      index = cursor
    }
  }
  if (farthest <= epsilon || index === start || index === end) return [start, end]
  const left = ramer(points, start, index, epsilon)
  const right = ramer(points, index, end, epsilon)
  return [...left.slice(0, -1), ...right]
}

function principalAxis(xx: number, xy: number, yy: number): Point | null {
  if (Math.abs(xy) < 1e-8 && Math.abs(xx) < 1e-8 && Math.abs(yy) < 1e-8) return null
  if (Math.abs(xy) < 1e-8) return unit(xx >= yy ? { x: 1, y: 0 } : { x: 0, y: 1 })
  const trace = xx + yy
  const det = xx * yy - xy * xy
  const gap = Math.sqrt(Math.max(0, (trace * trace) / 4 - det))
  const larger = trace / 2 + gap
  return unit({ x: xy, y: larger - xx })
}

function axisVariance(xx: number, xy: number, yy: number, axis: Point): number {
  return axis.x * axis.x * xx + 2 * axis.x * axis.y * xy + axis.y * axis.y * yy
}

type Span = { min: number; max: number }

function emptySpan(): Span {
  return { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
}

function cover(span: Span, value: number): void {
  span.min = Math.min(span.min, value)
  span.max = Math.max(span.max, value)
}

function bounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function endpoint(stroke: Stroke | undefined, atStart: boolean): Point | null {
  if (!stroke || stroke.points.length === 0) return null
  return atStart ? (stroke.points[0] ?? null) : (stroke.points[stroke.points.length - 1] ?? null)
}

function copyStroke(stroke: Stroke): Stroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) }
}

function distanceToStroke(point: Point, points: Point[], closed: boolean): number {
  return nearPolyline(point, points, closed)
}

function nearPolyline(point: Point, points: Point[], closed: boolean): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY
  if (points.length === 1) return distance(point, points[0] ?? point)
  let nearest = Number.POSITIVE_INFINITY
  const count = closed ? points.length : points.length - 1
  for (let index = 0; index < count; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (!start || !end) continue
    nearest = Math.min(nearest, pointSegmentDistance(point, start, end))
  }
  return nearest
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const length = distance(start, end)
  if (length < 1e-6) return distance(point, start)
  const t = clamp(dot(subtract(point, start), subtract(end, start)) / (length * length), 0, 1)
  return distance(point, add(start, scale(subtract(end, start), t)))
}

function polylineLength(points: Point[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (start && end) length += distance(start, end)
  }
  return length
}

function centroid(points: Point[]): Point {
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  const count = Math.max(1, points.length)
  return { x: x / count, y: y / count }
}

function lerp(start: Point, end: Point, t: number): Point {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
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

function cross(left: Point, right: Point): number {
  return left.x * right.y - left.y * right.x
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function unit(point: Point): Point | null {
  const length = Math.hypot(point.x, point.y)
  if (length < 1e-8) return null
  return { x: point.x / length, y: point.y / length }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
