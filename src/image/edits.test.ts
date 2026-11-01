import { describe, expect, it } from 'vitest'
import { buildCenterline, skeletonCenterlineLength } from './centerline.ts'
import {
  applyEdits,
  closeGapStrokes,
  DEFAULT_EDIT,
  editableFromCenterline,
  eraseNear,
  nearestStroke,
  straightenStrokes,
  type Point,
  type Stroke,
} from './edits.ts'
import { commitHistory, createHistory, redoHistory, undoHistory } from './history.ts'
import type { BinaryImage } from './limits.ts'
import { renderEditable } from './render-edits.ts'

describe('straighten shapes', () => {
  it('snaps a slightly bowed stroke to a line and leaves a real curve curved', () => {
    const bowed = stroke(1, wavyLine(), false)
    const snapped = straightenStrokes([bowed], 80, 50)
    expect(snapped[0]?.points).toHaveLength(2)
    expect(maxDistanceToChord(wavyLine(), snapped[0]?.points ?? [])).toBeLessThan(2)

    const curved = stroke(2, hump(22), false)
    const kept = straightenStrokes([curved], 100, 80)
    expect(kept[0]?.points.length).toBeGreaterThan(2)
  })

  it('snaps a wobbly rectangle, circle, and ellipse to clean shapes', () => {
    const rectangle = straightenStrokes([stroke(1, wobblyRectangle(), true)], 60, 140)
    const rect = rectangle[0]
    expect(rect?.closed).toBe(true)
    expect(rect?.points).toHaveLength(4)
    expect(new Set(rect?.points.map((point) => point.x.toFixed(2))).size).toBe(2)
    expect(new Set(rect?.points.map((point) => point.y.toFixed(2))).size).toBe(2)

    const circle = straightenStrokes([stroke(2, oval(60, 60, 36, 36, 1.2), true)], 70, 140)[0]
    expect(circle?.points.length).toBeGreaterThanOrEqual(24)
    expect(radiusSpread(circle?.points ?? [])).toBeLessThan(0.05)

    const ellipse = straightenStrokes([stroke(3, oval(80, 50, 48, 18, 0.8), true)], 60, 160)[0]
    expect(ellipse?.points.length).toBeGreaterThanOrEqual(24)
    const box = bounds(ellipse?.points ?? [])
    expect((box.maxX - box.minX) / (box.maxY - box.minY)).toBeGreaterThan(1.8)
    expect(ellipseError(ellipse?.points ?? [])).toBeLessThan(0.2)
  })
})

describe('close gaps', () => {
  it('joins endpoints inside the gap and leaves a wider opening alone', () => {
    const left = stroke(1, [{ x: 0, y: 0 }, { x: 40, y: 0 }], false)
    const right = stroke(2, [{ x: 52, y: 0 }, { x: 100, y: 0 }], false)
    expect(closeGapStrokes([left, right], 14)).toHaveLength(1)
    expect(closeGapStrokes([left, right], 6)).toHaveLength(2)

    const almost = stroke(3, [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
      { x: 10, y: 18 },
    ], false)
    expect(closeGapStrokes([almost], 12)[0]?.closed).toBe(true)
    expect(closeGapStrokes([almost], 4)[0]?.closed).toBe(false)
  })

  it('does not join a stem into the middle of a bar', () => {
    const bar = stroke(1, [{ x: 0, y: 0 }, { x: 100, y: 0 }], false)
    const stem = stroke(2, [{ x: 50, y: 4 }, { x: 50, y: 40 }], false)
    expect(closeGapStrokes([bar, stem], 10)).toHaveLength(2)
  })

  it('reads the gap slider as a fraction of the long side', () => {
    const model = {
      width: 200,
      height: 40,
      penWidth: 2,
      kind: 'stroke' as const,
      strokes: [
        stroke(1, [{ x: 0, y: 10 }, { x: 40, y: 10 }], false),
        stroke(2, [{ x: 48, y: 10 }, { x: 90, y: 10 }], false),
      ],
    }
    expect(applyEdits(model, { ...DEFAULT_EDIT, closeGaps: true, gap: 100 }).strokes).toHaveLength(1)
    expect(applyEdits(model, { ...DEFAULT_EDIT, closeGaps: true, gap: 1 }).strokes).toHaveLength(2)
    expect(applyEdits(model, DEFAULT_EDIT).strokes).toHaveLength(2)
  })
})

describe('eraser', () => {
  it('splits a stroke where the eraser crosses and drops a stroke it covers', () => {
    const line = stroke(1, [{ x: 0, y: 0 }, { x: 100, y: 0 }], false)
    const speck = stroke(2, [{ x: 10, y: 20 }, { x: 16, y: 20 }], false)
    const split = eraseNear([line], [{ x: 50, y: 0 }], 8)
    expect(split).toHaveLength(2)
    const ends = split.map((piece) => piece.points.map((point) => point.x))
    expect(Math.max(...(ends[0] ?? [0]))).toBeLessThan(48)
    expect(Math.min(...(ends[1] ?? [0]))).toBeGreaterThan(52)

    const removed = eraseNear([line, speck], [{ x: 13, y: 20 }], 8)
    expect(removed).toHaveLength(1)
    expect(removed[0]?.id).toBe(1)
  })

  it('opens a closed shape instead of deleting the rest of it', () => {
    const square = stroke(3, [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ], true)
    const opened = eraseNear([square], [{ x: 20, y: 0 }], 6)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.closed).toBe(false)
    expect(opened[0]?.points.length).toBeGreaterThan(2)
  })
})

describe('per-path smoothing', () => {
  it('flattens the selected line without flattening the other', () => {
    const model = {
      width: 120,
      height: 80,
      penWidth: 2,
      kind: 'stroke' as const,
      strokes: [
        { ...stroke(1, wave(12, 4), false), smoothing: 0 },
        { ...stroke(2, wave(48, 4), false), smoothing: 100 },
      ],
    }
    const heights = pathHeights(renderEditable(model, 0))
    expect(Math.max(...heights)).toBeGreaterThan(2)
    expect(Math.min(...heights)).toBeLessThan(1.2)
  })

  it('hits the nearest stroke', () => {
    const strokes = [stroke(4, [{ x: 0, y: 0 }, { x: 40, y: 0 }], false), stroke(5, [{ x: 0, y: 20 }, { x: 40, y: 20 }], false)]
    expect(nearestStroke(strokes, { x: 12, y: 3 }, 8)).toBe(4)
    expect(nearestStroke(strokes, { x: 12, y: 30 }, 8)).toBeNull()
  })
})

describe('undo', () => {
  it('restores and reapplies a straighten, and a new edit drops the redo tail', () => {
    const model = {
      width: 140,
      height: 40,
      penWidth: 2,
      kind: 'stroke' as const,
      strokes: [stroke(1, wavyLine(), false)],
    }
    let history = createHistory(DEFAULT_EDIT)
    history = commitHistory(history, { ...DEFAULT_EDIT, straighten: true, tolerance: 80 })
    expect(applyEdits(model, history.present).strokes[0]?.points).toHaveLength(2)
    history = undoHistory(history)
    expect(applyEdits(model, history.present).strokes[0]?.points.length).toBeGreaterThan(2)
    history = redoHistory(history)
    expect(applyEdits(model, history.present).strokes[0]?.points).toHaveLength(2)
    history = undoHistory(history)
    history = commitHistory(history, { ...DEFAULT_EDIT, closeGaps: true, gap: 30 })
    expect(history.future).toEqual([])
    expect(history.present.closeGaps).toBe(true)
    history = undoHistory(history)
    expect(history.present).toEqual(DEFAULT_EDIT)
  })

  it('undoes an eraser mark', () => {
    const model = {
      width: 120,
      height: 20,
      penWidth: 2,
      kind: 'stroke' as const,
      strokes: [stroke(1, [{ x: 0, y: 5 }, { x: 100, y: 5 }], false)],
    }
    let history = createHistory(DEFAULT_EDIT)
    history = commitHistory(history, {
      ...DEFAULT_EDIT,
      erasers: [{ points: [{ x: 50, y: 5 }], radius: 8 }],
    })
    expect(applyEdits(model, history.present).strokes).toHaveLength(2)
    history = undoHistory(history)
    expect(applyEdits(model, history.present).strokes).toHaveLength(1)
  })
})

describe('centerline length regression', () => {
  it('keeps at least 95% of centerline length when straighten and close-gaps are off', () => {
    const image = blank(120, 120)
    fill(image, 20, 20, 80, 6)
    fill(image, 20, 94, 80, 6)
    fill(image, 20, 20, 6, 80)
    fill(image, 94, 20, 6, 80)
    const baseline = skeletonCenterlineLength(image)
    expect(baseline).toBeGreaterThan(20)
    const model = editableFromCenterline(buildCenterline(image))
    const svg = renderEditable(applyEdits(model, DEFAULT_EDIT), 28)
    expect(pathLength(svg)).toBeGreaterThanOrEqual(baseline * 0.95)
    expect(svg).toMatch(/[Zz]/)
  })
})

function stroke(id: number, points: Point[], closed: boolean): Stroke {
  return { id, points, closed, smoothing: null, source: null }
}

function wavyLine(): Point[] {
  const points: Point[] = []
  for (let index = 0; index <= 24; index += 1) {
    points.push({ x: 8 + index * 4, y: 20 + (index % 2 === 0 ? 1.1 : -1.1) })
  }
  return points
}

function hump(amplitude: number): Point[] {
  const points: Point[] = []
  for (let index = 0; index <= 30; index += 1) {
    const t = index / 30
    points.push({ x: 10 + t * 100, y: 40 + Math.sin(t * Math.PI) * amplitude })
  }
  return points
}

function wave(y: number, amplitude: number): Point[] {
  return hump(amplitude).map((point) => ({ x: point.x, y: point.y - 40 + y }))
}

function wobblyRectangle(): Point[] {
  const corners = [
    { x: 20, y: 20 },
    { x: 120, y: 20 },
    { x: 120, y: 110 },
    { x: 20, y: 110 },
  ]
  const points: Point[] = []
  for (let side = 0; side < corners.length; side += 1) {
    const start = corners[side]
    const end = corners[(side + 1) % corners.length]
    if (!start || !end) continue
    for (let step = 0; step < 12; step += 1) {
      const t = step / 12
      const wobble = step % 2 === 0 ? 1.4 : -1.2
      const horizontal = side % 2 === 0
      points.push({
        x: start.x + (end.x - start.x) * t + (horizontal ? 0 : wobble),
        y: start.y + (end.y - start.y) * t + (horizontal ? wobble : 0),
      })
    }
  }
  return points
}

function oval(cx: number, cy: number, rx: number, ry: number, noise: number): Point[] {
  const points: Point[] = []
  for (let index = 0; index < 40; index += 1) {
    const angle = (index / 40) * Math.PI * 2
    const wobble = index % 2 === 0 ? noise : -noise
    points.push({
      x: cx + Math.cos(angle) * (rx + wobble),
      y: cy + Math.sin(angle) * (ry + wobble),
    })
  }
  return points
}

function maxDistanceToChord(points: Point[], chord: Point[]): number {
  const start = chord[0]
  const end = chord[1]
  if (!start || !end) return Number.POSITIVE_INFINITY
  let max = 0
  for (const point of points) max = Math.max(max, pointSegmentDistance(point, start, end))
  return max
}

function radiusSpread(points: Point[]): number {
  const center = centroid(points)
  const radii = points.map((point) => Math.hypot(point.x - center.x, point.y - center.y))
  return Math.max(...radii) - Math.min(...radii)
}

function ellipseError(points: Point[]): number {
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
  xx /= points.length
  xy /= points.length
  yy /= points.length
  const trace = xx + yy
  const det = xx * yy - xy * xy
  const gap = Math.sqrt(Math.max(0, (trace * trace) / 4 - det))
  const majorVariance = trace / 2 + gap
  const minorVariance = trace / 2 - gap
  const major = Math.sqrt(Math.max(1e-6, 2 * majorVariance))
  const minor = Math.sqrt(Math.max(1e-6, 2 * minorVariance))
  const axis = Math.abs(xy) < 1e-8 ? { x: xx >= yy ? 1 : 0, y: xx >= yy ? 0 : 1 } : unit({ x: xy, y: majorVariance - xx })
  let error = 0
  for (const point of points) {
    const dx = point.x - center.x
    const dy = point.y - center.y
    const along = dx * axis.x + dy * axis.y
    const across = dx * -axis.y + dy * axis.x
    error = Math.max(error, Math.abs(Math.hypot(along / major, across / minor) - 1))
  }
  return error
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

function centroid(points: Point[]): Point {
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / Math.max(1, points.length), y: y / Math.max(1, points.length) }
}

function unit(point: Point): Point {
  const length = Math.hypot(point.x, point.y) || 1
  return { x: point.x / length, y: point.y / length }
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  if (length < 1e-6) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / (length * length)),
  )
  return Math.hypot(point.x - (start.x + (end.x - start.x) * t), point.y - (start.y + (end.y - start.y) * t))
}

function pathHeights(svg: string): number[] {
  return [...svg.matchAll(/\bd="([^"]*)"/g)].flatMap((match) => {
    const data = match[1]
    if (!data) return []
    const sampled = sample(data)
    if (sampled.length === 0) return []
    const ys = sampled.map((point) => point.y)
    return [Math.max(...ys) - Math.min(...ys)]
  })
}

function pathLength(svg: string): number {
  return [...svg.matchAll(/\bd="([^"]*)"/g)].reduce((sum, match) => sum + polylineLength(sample(match[1] ?? '')), 0)
}

function sample(data: string): Point[] {
  const pattern = /([MLCZ])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi
  let command = ''
  let relative = false
  const numbers: number[] = []
  let cursor = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  const points: Point[] = []
  const push = (point: Point) => {
    points.push(point)
    cursor = point
  }
  const flush = () => {
    const arity = command === 'M' || command === 'L' ? 2 : command === 'C' ? 6 : 0
    while (command && arity > 0 && numbers.length >= arity) {
      const take = numbers.splice(0, arity)
      if (command === 'M' || command === 'L') {
        const point = {
          x: relative ? cursor.x + (take[0] ?? 0) : (take[0] ?? 0),
          y: relative ? cursor.y + (take[1] ?? 0) : (take[1] ?? 0),
        }
        if (command === 'M') start = point
        push(point)
        if (command === 'M') command = 'L'
      } else if (command === 'C') {
        const control1 = {
          x: relative ? cursor.x + (take[0] ?? 0) : (take[0] ?? 0),
          y: relative ? cursor.y + (take[1] ?? 0) : (take[1] ?? 0),
        }
        const control2 = {
          x: relative ? cursor.x + (take[2] ?? 0) : (take[2] ?? 0),
          y: relative ? cursor.y + (take[3] ?? 0) : (take[3] ?? 0),
        }
        const end = {
          x: relative ? cursor.x + (take[4] ?? 0) : (take[4] ?? 0),
          y: relative ? cursor.y + (take[5] ?? 0) : (take[5] ?? 0),
        }
        const origin = cursor
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8
          const inverse = 1 - t
          push({
            x: inverse ** 3 * origin.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
            y: inverse ** 3 * origin.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y,
          })
        }
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
        push(start)
        command = ''
      }
      continue
    }
    numbers.push(Number(piece))
  }
  flush()
  return points
}

function polylineLength(points: Point[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (start && end) length += Math.hypot(end.x - start.x, end.y - start.y)
  }
  return length
}

function blank(width: number, height: number): BinaryImage {
  return { width, height, ink: new Uint8Array(width * height) }
}

function fill(image: BinaryImage, x: number, y: number, width: number, height: number): void {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(image.width, x + width); column += 1) {
      image.ink[row * image.width + column] = 1
    }
  }
}
