import { describe, expect, it } from 'vitest'
import { skeletonCenterlineLength, traceCenterline } from './centerline.ts'
import { CLEANUP_TIMEOUT_MESSAGE, type BinaryImage } from './limits.ts'
import { estimatePenWidth } from './skeleton.ts'
import { vectorize } from './vectorize.ts'

describe('centerline cleanup', () => {
  it('merges a doubled stroke into one open centerline', () => {
    const image = blank(100, 48)
    fill(image, 8, 16, 84, 6)
    fill(image, 8, 26, 84, 6)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke-linecap="round"')
    expect(svg).toContain('stroke-linejoin="round"')
    const width = strokeWidth(svg)
    expect(width).toBeGreaterThan(3)
    expect(width).toBeLessThan(12)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(false)
    expect(sampled.length).toBeGreaterThan(60)
    expect(sampled.length).toBeLessThan(120)
    const ys = sampled.points.map((point) => point.y)
    expect(average(ys)).toBeGreaterThan(18)
    expect(average(ys)).toBeLessThan(30)
    expect(spread(ys)).toBeLessThan(6)
  })

  it('merges a scribbled corner into one line and keeps the corner', () => {
    const image = blank(90, 90)
    drawCorner(image, 18, 18, 52, 5)
    drawCorner(image, 20, 16, 54, 5)
    drawCorner(image, 16, 21, 50, 6)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(false)
    const turn = sharpestTurn(sampled.points, 8)
    expect(turn).toBeGreaterThan(50)
    expect(turn).toBeLessThan(140)
  })

  it('closes a square whose ends nearly touch', () => {
    const image = blank(84, 84)
    drawOpenSquare(image, 12, 12, 60, 6, 8)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(true)
    expect(sampled.length).toBeGreaterThan(140)
  })

  it('fits a straight run as a line with no cubic curves', () => {
    const image = blank(100, 36)
    fill(image, 8, 14, 84, 6)
    const svg = traceCenterline(image, 28)
    const data = paths(svg)
    expect(data).toHaveLength(1)
    expect(curveCount(data[0] ?? '')).toBe(0)
    const sampled = sample(data[0] ?? '')
    expect(spread(sampled.points.map((point) => point.y))).toBeLessThan(2)
    expect(Math.max(...sampled.points.map((point) => point.x)) - Math.min(...sampled.points.map((point) => point.x))).toBeGreaterThan(70)
  })

  it('keeps a sharp corner sharp', () => {
    const image = blank(90, 80)
    fill(image, 14, 50, 62, 6)
    fill(image, 14, 12, 6, 44)
    const svg = traceCenterline(image, 40)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(false)
    const turn = sharpestTurn(sampled.points, 10)
    expect(turn).toBeGreaterThan(55)
    expect(turn).toBeLessThan(130)
    expect(near(sampled.points, 70, 53, 12)).toBe(true)
    expect(near(sampled.points, 17, 16, 12)).toBe(true)
  })

  it('joins four square segments into one closed path with sharp corners', () => {
    const image = blank(100, 100)
    fill(image, 20, 20, 60, 6)
    fill(image, 20, 74, 60, 6)
    fill(image, 20, 20, 6, 60)
    fill(image, 74, 20, 6, 60)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(true)
    expect(sampled.length).toBeGreaterThan(160)
    expect(cornerCount(sampled.points, 50)).toBe(4)
  })

  it('keeps a crossing as two separate paths', () => {
    const image = blank(80, 80)
    fill(image, 12, 36, 56, 8)
    fill(image, 36, 12, 8, 56)
    const svg = traceCenterline(image, 28)
    const data = paths(svg)
    expect(data).toHaveLength(2)
    for (const path of data) {
      const sampled = sample(path)
      expect(sampled.closed).toBe(false)
      expect(sampled.length).toBeGreaterThan(40)
    }
  })

  it('keeps a square closed when a corner is a thick blob', () => {
    const image = blank(120, 120)
    fill(image, 24, 24, 72, 8)
    fill(image, 24, 88, 72, 8)
    fill(image, 24, 24, 8, 72)
    fill(image, 88, 24, 8, 72)
    fill(image, 78, 78, 26, 26)
    fill(image, 84, 20, 8, 76)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(true)
    expect(sampled.length).toBeGreaterThan(180)
    expect(cornerCount(sampled.points, 45)).toBeGreaterThanOrEqual(4)
  })

  it('keeps a doubled tip as one open stroke', () => {
    const image = blank(110, 48)
    fill(image, 8, 16, 90, 6)
    fill(image, 52, 26, 46, 6)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.closed).toBe(false)
    expect(sampled.length).toBeGreaterThan(70)
  })

  it('drops stray dots and keeps the stroke', () => {
    const image = blank(100, 40)
    fill(image, 10, 16, 70, 5)
    fill(image, 4, 4, 2, 2)
    fill(image, 88, 6, 3, 3)
    fill(image, 80, 30, 2, 2)
    const svg = traceCenterline(image, 28)
    expect(paths(svg)).toHaveLength(1)
    const sampled = sample(paths(svg)[0] ?? '')
    expect(sampled.length).toBeGreaterThan(50)
    expect(near(sampled.points, 5, 5, 6)).toBe(false)
    expect(near(sampled.points, 89, 7, 6)).toBe(false)
  })

  it('joins a 7px edge gap and an 8px corner into one closed path', () => {
    const image = blank(140, 140)
    fill(image, 20, 20, 50, 6)
    fill(image, 77, 20, 40, 6)
    fill(image, 111, 34, 6, 76)
    fill(image, 20, 104, 97, 6)
    fill(image, 20, 20, 6, 90)
    const data = paths(traceCenterline(image, 28))
    expect(data).toHaveLength(1)
    const path = data[0] ?? ''
    expect(path).toMatch(/[Zz]/)
    expect(openEnds(path)).toHaveLength(0)
    const sampled = sample(path)
    expect(sampled.closed).toBe(true)
    expect(cornerCount(sampled.points, 45)).toBeGreaterThanOrEqual(4)
  })

  it('keeps a T junction as a crossbar and a separate stem', () => {
    const image = blank(120, 100)
    fill(image, 10, 36, 100, 6)
    fill(image, 57, 36, 6, 50)
    const data = paths(traceCenterline(image, 28))
    expect(data).toHaveLength(2)
    const lengths: number[] = []
    for (const path of data) {
      expect(path).not.toMatch(/[Zz]/)
      expect(openEnds(path)).toHaveLength(2)
      lengths.push(sample(path).length)
    }
    expect(Math.max(...lengths)).toBeGreaterThan(80)
    expect(Math.min(...lengths)).toBeGreaterThan(30)
  })

  it('fits a circle with a few cubics and no micro-loop', () => {
    const image = ring(120, 60, 60, 37, 6)
    const data = paths(traceCenterline(image, 28))
    expect(data).toHaveLength(1)
    const path = data[0] ?? ''
    expect(path).toMatch(/[Zz]/)
    expect(openEnds(path)).toHaveLength(0)
    expect(curveCount(path)).toBeGreaterThan(0)
    expect(curveCount(path)).toBeLessThan(8)
    expect(microLoops(sample(path).points, 2, 24)).toBe(0)
  })

  it('keeps parallel lines 1.5 pen widths apart as two open paths', () => {
    const image = blank(200, 80)
    fill(image, 8, 8, 160, 6)
    const gap = Math.round(estimatePenWidth(image) * 1.5)
    fill(image, 8, 8 + 6 + gap, 160, 6)
    const data = paths(traceCenterline(image, 28))
    expect(data).toHaveLength(2)
    for (const path of data) {
      expect(path).not.toMatch(/[Zz]/)
      expect(openEnds(path)).toHaveLength(2)
    }
  })

  it('keeps parallel lines two pen widths apart as two open paths', () => {
    const image = blank(200, 80)
    fill(image, 8, 8, 160, 6)
    const gap = Math.round(estimatePenWidth(image) * 2)
    fill(image, 8, 8 + 6 + gap, 160, 6)
    const data = paths(traceCenterline(image, 28))
    expect(data).toHaveLength(2)
    for (const path of data) {
      expect(path).not.toMatch(/[Zz]/)
      expect(openEnds(path)).toHaveLength(2)
    }
  })

  it('stops when the cleanup deadline has passed', () => {
    const image = blank(40, 20)
    fill(image, 4, 6, 30, 6)
    expect(() => traceCenterline(image, 28, Date.now() - 1)).toThrow(CLEANUP_TIMEOUT_MESSAGE)
  })

  it('keeps at least 95% of the skeleton centerline, and closes loops', () => {
    const circle = ring(600, 300, 300, 250, 6)
    const curve = sCurve()
    const square = standaloneBox()
    const branched = boxWithBranches()
    const closedShapes = [circle, square, ring(120, 60, 60, 37, 6), fourSegmentSquare(), thickCornerSquare(), gappedSquare()]
    for (const image of closedShapes) {
      const data = paths(traceCenterline(image, 28))
      expect(data).toHaveLength(1)
      expect(data[0]).toMatch(/[Zz]/)
      expect(openEnds(data[0] ?? '')).toHaveLength(0)
      expectKeepsCenterline(image)
    }
    const curvePaths = paths(traceCenterline(curve, 28))
    expect(curvePaths).toHaveLength(1)
    expect(curvePaths[0]).not.toMatch(/[Zz]/)
    expectKeepsCenterline(curve)
    const branchPaths = paths(traceCenterline(branched, 28))
    expect(branchPaths.length).toBeGreaterThan(1)
    expectJointsMeet(branchPaths)
    expectNoDoubledEdges(branchPaths)
    expectKeepsCenterline(branched)
    for (const image of existingSamples()) {
      expectKeepsCenterline(image)
    }
  })

  it('meets T junctions and crossings with no gap and no doubled edge', () => {
    const tee = blank(120, 100)
    fill(tee, 10, 36, 100, 6)
    fill(tee, 57, 36, 6, 50)
    const teePaths = paths(traceCenterline(tee, 28))
    expect(teePaths).toHaveLength(2)
    expectJointsMeet(teePaths)
    expectNoDoubledEdges(teePaths)
    const crossing = blank(80, 80)
    fill(crossing, 12, 36, 56, 8)
    fill(crossing, 36, 12, 8, 56)
    const crossingPaths = paths(traceCenterline(crossing, 28))
    expect(crossingPaths).toHaveLength(2)
    expectNoDoubledEdges(crossingPaths)
    const samples = crossingPaths.map((path) => sample(path))
    expect(polylineSeparation(samples[0]?.points ?? [], samples[1]?.points ?? [])).toBeLessThan(0.05)
  })

  it('uses fewer curves than the filled outline of the same ink', () => {
    const image = arc(110, 70, 54, 36, 28, 6, Math.PI * 0.15, Math.PI * 0.85)
    const cleaned = traceCenterline(image, 28)
    const outline = vectorize(image, 28)
    expect(paths(cleaned).length).toBeGreaterThan(0)
    expect(curveCount(cleaned)).toBeLessThan(curveCount(outline))
    expect(curveCount(cleaned)).toBeLessThan(8)
    for (const data of paths(cleaned)) {
      for (const point of sample(data).points) {
        expect(point.x).toBeGreaterThan(-2)
        expect(point.y).toBeGreaterThan(-2)
        expect(point.x).toBeLessThan(image.width + 2)
        expect(point.y).toBeLessThan(image.height + 2)
      }
    }
  })
})

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

function drawCorner(image: BinaryImage, x: number, y: number, length: number, thickness: number): void {
  fill(image, x, y, thickness, length)
  fill(image, x, y + length - thickness, length, thickness)
}

function drawOpenSquare(
  image: BinaryImage,
  x: number,
  y: number,
  size: number,
  thickness: number,
  gap: number,
): void {
  const lead = Math.floor((size - gap) / 2)
  fill(image, x, y, lead, thickness)
  fill(image, x + size - lead, y, lead, thickness)
  fill(image, x, y, thickness, size)
  fill(image, x + size - thickness, y, thickness, size)
  fill(image, x, y + size - thickness, size, thickness)
}

function ring(size: number, cx: number, cy: number, radius: number, thickness: number): BinaryImage {
  const image = blank(size, size)
  const outer = radius + thickness / 2
  const inner = radius - thickness / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - cx, y - cy)
      if (distance >= inner && distance <= outer) image.ink[y * size + x] = 1
    }
  }
  return image
}

function standaloneBox(): BinaryImage {
  const image = blank(140, 140)
  fill(image, 20, 20, 100, 6)
  fill(image, 20, 114, 100, 6)
  fill(image, 20, 20, 6, 100)
  fill(image, 114, 20, 6, 100)
  return image
}

function boxWithBranches(): BinaryImage {
  const image = standaloneBox()
  fill(image, 67, 4, 6, 22)
  fill(image, 120, 64, 16, 6)
  return image
}

function fourSegmentSquare(): BinaryImage {
  const image = blank(100, 100)
  fill(image, 20, 20, 60, 6)
  fill(image, 20, 74, 60, 6)
  fill(image, 20, 20, 6, 60)
  fill(image, 74, 20, 6, 60)
  return image
}

function thickCornerSquare(): BinaryImage {
  const image = blank(120, 120)
  fill(image, 24, 24, 72, 8)
  fill(image, 24, 88, 72, 8)
  fill(image, 24, 24, 8, 72)
  fill(image, 88, 24, 8, 72)
  fill(image, 78, 78, 26, 26)
  fill(image, 84, 20, 8, 76)
  return image
}

function gappedSquare(): BinaryImage {
  const image = blank(140, 140)
  fill(image, 20, 20, 50, 6)
  fill(image, 77, 20, 40, 6)
  fill(image, 111, 34, 6, 76)
  fill(image, 20, 104, 97, 6)
  fill(image, 20, 20, 6, 90)
  return image
}

function sCurve(): BinaryImage {
  const radius = 160
  const thickness = 6
  const pad = 20
  const width = pad + radius * 4 + pad
  const height = pad + radius * 2 + pad
  const image = blank(width, height)
  const half = thickness / 2
  const left = pad + radius
  const right = pad + radius * 3
  const cy = pad + radius
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const upper = y <= cy && Math.abs(Math.hypot(x - left, y - cy) - radius) <= half
      const lower = y >= cy && Math.abs(Math.hypot(x - right, y - cy) - radius) <= half
      if (upper || lower) image.ink[y * width + x] = 1
    }
  }
  return image
}

function existingSamples(): BinaryImage[] {
  const doubled = blank(100, 48)
  fill(doubled, 8, 16, 84, 6)
  fill(doubled, 8, 26, 84, 6)
  const corner = blank(90, 90)
  drawCorner(corner, 18, 18, 52, 5)
  drawCorner(corner, 20, 16, 54, 5)
  drawCorner(corner, 16, 21, 50, 6)
  const openSquare = blank(84, 84)
  drawOpenSquare(openSquare, 12, 12, 60, 6, 8)
  const straight = blank(100, 36)
  fill(straight, 8, 14, 84, 6)
  const sharp = blank(90, 80)
  fill(sharp, 14, 50, 62, 6)
  fill(sharp, 14, 12, 6, 44)
  const doubledTip = blank(110, 48)
  fill(doubledTip, 8, 16, 90, 6)
  fill(doubledTip, 52, 26, 46, 6)
  const dots = blank(100, 40)
  fill(dots, 10, 16, 70, 5)
  fill(dots, 4, 4, 2, 2)
  fill(dots, 88, 6, 3, 3)
  fill(dots, 80, 30, 2, 2)
  const parallel = blank(200, 80)
  fill(parallel, 8, 8, 160, 6)
  const gap = Math.round(estimatePenWidth(parallel) * 2)
  fill(parallel, 8, 8 + 6 + gap, 160, 6)
  const tee = blank(120, 100)
  fill(tee, 10, 36, 100, 6)
  fill(tee, 57, 36, 6, 50)
  const crossing = blank(80, 80)
  fill(crossing, 12, 36, 56, 8)
  fill(crossing, 36, 12, 8, 56)
  return [
    doubled,
    corner,
    openSquare,
    straight,
    sharp,
    fourSegmentSquare(),
    crossing,
    thickCornerSquare(),
    doubledTip,
    dots,
    gappedSquare(),
    tee,
    ring(120, 60, 60, 37, 6),
    parallel,
    arc(110, 70, 54, 36, 28, 6, Math.PI * 0.15, Math.PI * 0.85),
  ]
}

function expectKeepsCenterline(image: BinaryImage): void {
  const baseline = skeletonCenterlineLength(image)
  expect(baseline).toBeGreaterThan(20)
  const length = paths(traceCenterline(image, 28)).reduce((sum, path) => sum + sample(path).length, 0)
  expect(length).toBeGreaterThanOrEqual(baseline * 0.95)
}

function expectJointsMeet(data: string[]): void {
  const samples = data.map((path) => sample(path))
  data.forEach((path, index) => {
    for (const end of openEnds(path)) {
      let nearest = Number.POSITIVE_INFINITY
      samples.forEach((other, otherIndex) => {
        if (otherIndex === index) return
        nearest = Math.min(nearest, distanceToPolyline(end, other.points))
      })
      if (nearest <= 8) expect(nearest).toBeLessThan(0.05)
    }
  })
}

function expectNoDoubledEdges(data: string[]): void {
  const samples = data.map((path) => sample(path))
  for (let left = 0; left < samples.length; left += 1) {
    const points = samples[left]?.points ?? []
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]
      const end = points[index]
      if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) < 4) continue
      const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      for (let right = 0; right < samples.length; right += 1) {
        if (right === left) continue
        const other = samples[right]?.points ?? []
        const covered =
          distanceToPolyline(start, other) < 1.25 &&
          distanceToPolyline(end, other) < 1.25 &&
          distanceToPolyline(middle, other) < 1.25
        expect(covered).toBe(false)
      }
    }
  }
}

function polylineSeparation(left: { x: number; y: number }[], right: { x: number; y: number }[]): number {
  let nearest = Number.POSITIVE_INFINITY
  for (let leftIndex = 1; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex < right.length; rightIndex += 1) {
      const a = left[leftIndex - 1]
      const b = left[leftIndex]
      const c = right[rightIndex - 1]
      const d = right[rightIndex]
      if (!a || !b || !c || !d) continue
      nearest = Math.min(nearest, segmentSeparation(a, b, c, d))
    }
  }
  return nearest
}

function segmentSeparation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): number {
  const cross = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(cross) > 1e-8) {
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / cross
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / cross
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0
  }
  return Math.min(
    distanceToPolyline(a, [c, d]),
    distanceToPolyline(b, [c, d]),
    distanceToPolyline(c, [a, b]),
    distanceToPolyline(d, [a, b]),
  )
}

function distanceToPolyline(point: { x: number; y: number }, points: { x: number; y: number }[]): number {
  let nearest = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (!start || !end) continue
    const span = Math.hypot(end.x - start.x, end.y - start.y)
    if (span < 1e-6) {
      nearest = Math.min(nearest, Math.hypot(point.x - start.x, point.y - start.y))
      continue
    }
    const t = Math.min(
      1,
      Math.max(0, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / (span * span)),
    )
    nearest = Math.min(nearest, Math.hypot(point.x - (start.x + (end.x - start.x) * t), point.y - (start.y + (end.y - start.y) * t)))
  }
  return nearest
}

function arc(
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  start: number,
  end: number,
): BinaryImage {
  const image = blank(width, height)
  const half = thickness / 2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx)
      const distance = Math.hypot(x - cx, y - cy)
      if (angle < start || angle > end) continue
      if (distance < radius - half || distance > radius + half) continue
      image.ink[y * width + x] = 1
    }
  }
  return image
}

function paths(svg: string): string[] {
  return [...svg.matchAll(/\bd="([^"]*)"/g)].flatMap((match) => (match[1] ? [match[1]] : []))
}

/** Open endpoints of the path data. A closed subpath (Z) contributes none. */
function openEnds(data: string): { x: number; y: number }[] {
  const ends: { x: number; y: number }[] = []
  for (const subpath of commandEnds(data)) {
    if (!subpath.closed) ends.push(subpath.start, subpath.end)
  }
  return ends
}

function commandEnds(data: string): { start: { x: number; y: number }; end: { x: number; y: number }; closed: boolean }[] {
  const pattern = /([MmLlHhVvCcSsQqTtZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi
  const subs: { start: { x: number; y: number }; end: { x: number; y: number }; closed: boolean }[] = []
  let command = ''
  let relative = false
  const numbers: number[] = []
  let cursor = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  const gap: { open: { start: { x: number; y: number }; end: { x: number; y: number }; closed: boolean } | null } = {
    open: null,
  }
  const flush = () => {
    const arity =
      command === 'M' || command === 'L' ? 2 : command === 'H' || command === 'V' ? 1 : command === 'C' ? 6 : command === 'S' || command === 'Q' ? 4 : 0
    while (command && arity && numbers.length >= arity) {
      const take = numbers.splice(0, arity)
      if (command === 'M' || command === 'L') {
        const x = relative ? cursor.x + (take[0] ?? 0) : (take[0] ?? 0)
        const y = relative ? cursor.y + (take[1] ?? 0) : (take[1] ?? 0)
        cursor = { x, y }
        if (command === 'M') {
          if (gap.open) subs.push(gap.open)
          start = { x, y }
          gap.open = { start, end: { x, y }, closed: false }
          command = 'L'
        } else if (gap.open) gap.open.end = { x, y }
      } else if (command === 'H') {
        cursor = { x: relative ? cursor.x + (take[0] ?? 0) : (take[0] ?? 0), y: cursor.y }
        if (gap.open) gap.open.end = { ...cursor }
      } else if (command === 'V') {
        cursor = { x: cursor.x, y: relative ? cursor.y + (take[0] ?? 0) : (take[0] ?? 0) }
        if (gap.open) gap.open.end = { ...cursor }
      } else if (command === 'C' || command === 'S' || command === 'Q') {
        const x = relative ? cursor.x + (take[arity - 2] ?? 0) : (take[arity - 2] ?? 0)
        const y = relative ? cursor.y + (take[arity - 1] ?? 0) : (take[arity - 1] ?? 0)
        cursor = { x, y }
        if (gap.open) gap.open.end = { x, y }
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
        if (gap.open) {
          gap.open.closed = true
          gap.open.end = { ...gap.open.start }
          subs.push(gap.open)
          gap.open = null
        }
        cursor = { ...start }
        command = ''
      }
      continue
    }
    numbers.push(Number(piece))
  }
  flush()
  if (gap.open) subs.push(gap.open)
  return subs
}

function microLoops(points: { x: number; y: number }[], touch: number, limit: number): number {
  let loops = 0
  for (let start = 0; start < points.length; start += 1) {
    let arc = 0
    for (let index = start + 4; index < points.length; index += 1) {
      const previous = points[index - 1]
      const point = points[index]
      const origin = points[start]
      if (!previous || !point || !origin) continue
      arc += Math.hypot(point.x - previous.x, point.y - previous.y)
      if (arc > limit) break
      if (Math.hypot(point.x - origin.x, point.y - origin.y) <= touch) loops += 1
    }
  }
  return loops
}

function strokeWidth(svg: string): number {
  const match = /stroke-width="([^"]+)"/.exec(svg)
  return Number(match?.[1] ?? '0')
}

function curveCount(svgOrPath: string): number {
  const data = svgOrPath.includes('d="') ? paths(svgOrPath).join(' ') : svgOrPath
  const commands = data.match(/[a-zA-Z]/g) ?? []
  return commands.filter((command) => command === 'C' || command === 'c' || command === 'Q' || command === 'q').length
}

type Sample = { points: { x: number; y: number }[]; length: number; closed: boolean }

function sample(data: string): Sample {
  const commands = tokenize(data)
  const points: { x: number; y: number }[] = []
  let cursor = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  let closed = false
  const add = (point: { x: number; y: number }) => {
    const previous = points[points.length - 1]
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.2) points.push(point)
  }
  for (const command of commands) {
    if (command.kind === 'M') {
      cursor = { x: command.x, y: command.y }
      start = cursor
      add(cursor)
    } else if (command.kind === 'L') {
      const next = absolute(command, cursor)
      add(next)
      cursor = next
    } else if (command.kind === 'C') {
      const control1 = command.relative
        ? { x: cursor.x + command.x1, y: cursor.y + command.y1 }
        : { x: command.x1, y: command.y1 }
      const control2 = command.relative
        ? { x: cursor.x + command.x2, y: cursor.y + command.y2 }
        : { x: command.x2, y: command.y2 }
      const end = absolute(command, cursor)
      for (let step = 1; step <= 12; step += 1) {
        add(cubic(cursor, control1, control2, end, step / 12))
      }
      cursor = end
    } else if (command.kind === 'Z') {
      add(start)
      cursor = start
      closed = true
    }
  }
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if (previous && point) length += Math.hypot(point.x - previous.x, point.y - previous.y)
  }
  return { points, length, closed }
}

type Token =
  | { kind: 'M'; x: number; y: number }
  | { kind: 'L'; x: number; y: number; relative: boolean }
  | { kind: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number; relative: boolean }
  | { kind: 'Z' }

function tokenize(data: string): Token[] {
  const tokens: Token[] = []
  const pattern = /([MmLlHhVvCcSsQqTtZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi
  let command = ''
  let relative = false
  const numbers: number[] = []
  const flush = () => {
    const arity = command === 'M' || command === 'L' ? 2 : command === 'H' || command === 'V' ? 1 : command === 'C' ? 6 : command === 'S' || command === 'Q' ? 4 : 0
    if (!command || arity === 0) {
      numbers.length = 0
      return
    }
    while (numbers.length >= arity) {
      const take = numbers.splice(0, arity)
      if (command === 'M' || command === 'L') {
        tokens.push({
          kind: command === 'M' ? 'M' : 'L',
          x: take[0] ?? 0,
          y: take[1] ?? 0,
          relative,
        })
        if (command === 'M') command = 'L'
      } else if (command === 'H') {
        tokens.push({ kind: 'L', x: take[0] ?? 0, y: relative ? 0 : Number.NaN, relative })
      } else if (command === 'V') {
        tokens.push({ kind: 'L', x: relative ? 0 : Number.NaN, y: take[0] ?? 0, relative })
      } else if (command === 'C') {
        tokens.push({
          kind: 'C',
          x1: take[0] ?? 0,
          y1: take[1] ?? 0,
          x2: take[2] ?? 0,
          y2: take[3] ?? 0,
          x: take[4] ?? 0,
          y: take[5] ?? 0,
          relative,
        })
      } else if (command === 'Q' || command === 'S') {
        tokens.push({
          kind: 'C',
          x1: take[0] ?? 0,
          y1: take[1] ?? 0,
          x2: take[command === 'Q' ? 0 : 2] ?? 0,
          y2: take[command === 'Q' ? 1 : 3] ?? 0,
          x: take[command === 'Q' ? 2 : 2] ?? 0,
          y: take[command === 'Q' ? 3 : 3] ?? 0,
          relative,
        })
      }
    }
  }
  for (const match of data.matchAll(pattern)) {
    const piece = match[0] ?? ''
    if (/[a-zA-Z]/.test(piece)) {
      flush()
      relative = piece === piece.toLowerCase()
      command = piece.toUpperCase()
      if (command === 'Z') tokens.push({ kind: 'Z' })
      continue
    }
    numbers.push(Number(piece))
  }
  flush()
  return tokens
}

function absolute(command: { x: number; y: number; relative: boolean }, cursor: { x: number; y: number }): { x: number; y: number } {
  if (!command.relative) {
    return {
      x: Number.isNaN(command.x) ? cursor.x : command.x,
      y: Number.isNaN(command.y) ? cursor.y : command.y,
    }
  }
  return {
    x: cursor.x + (Number.isNaN(command.x) ? 0 : command.x),
    y: cursor.y + (Number.isNaN(command.y) ? 0 : command.y),
  }
}

function cubic(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u ** 3 * start.x + 3 * u ** 2 * t * control1.x + 3 * u * t ** 2 * control2.x + t ** 3 * end.x,
    y: u ** 3 * start.y + 3 * u ** 2 * t * control1.y + 3 * u * t ** 2 * control2.y + t ** 3 * end.y,
  }
}

function cornerCount(points: { x: number; y: number }[], minDegrees: number): number {
  const unique = points.slice()
  const first = unique[0]
  const last = unique[unique.length - 1]
  if (first && last && unique.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 0.5) unique.pop()
  const count = unique.length
  if (count < 3) return 0
  let corners = 0
  for (let index = 0; index < count; index += 1) {
    const point = unique[index]
    const before = unique[(index - 1 + count) % count]
    const after = unique[(index + 1) % count]
    if (!point || !before || !after) continue
    const incoming = normalize(point.x - before.x, point.y - before.y)
    const outgoing = normalize(after.x - point.x, after.y - point.y)
    if (!incoming || !outgoing) continue
    const cosine = Math.min(1, Math.max(-1, incoming.x * outgoing.x + incoming.y * outgoing.y))
    const turn = (Math.acos(cosine) * 180) / Math.PI
    if (turn >= minDegrees) corners += 1
  }
  return corners
}

function sharpestTurn(points: { x: number; y: number }[], radius: number): number {
  let sharpest = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]
    if (!point) continue
    const before = pointAtDistance(points, index, -radius)
    const after = pointAtDistance(points, index, radius)
    if (!before || !after) continue
    const incoming = normalize(point.x - before.x, point.y - before.y)
    const outgoing = normalize(after.x - point.x, after.y - point.y)
    if (!incoming || !outgoing) continue
    const cosine = Math.min(1, Math.max(-1, incoming.x * outgoing.x + incoming.y * outgoing.y))
    sharpest = Math.max(sharpest, (Math.acos(cosine) * 180) / Math.PI)
  }
  return sharpest
}

function pointAtDistance(
  points: { x: number; y: number }[],
  index: number,
  offset: number,
): { x: number; y: number } | null {
  let remaining = Math.abs(offset)
  let cursor = index
  const step = offset < 0 ? -1 : 1
  while (remaining > 0) {
    const next = cursor + step
    const current = points[cursor]
    const neighbor = points[next]
    if (!current || !neighbor) return null
    const span = Math.hypot(neighbor.x - current.x, neighbor.y - current.y)
    if (span >= remaining) {
      const t = remaining / span
      return {
        x: current.x + (neighbor.x - current.x) * t * step * step,
        y: current.y + (neighbor.y - current.y) * t,
      }
    }
    remaining -= span
    cursor = next
  }
  return points[index] ?? null
}

function near(points: { x: number; y: number }[], x: number, y: number, limit: number): boolean {
  return points.some((point) => Math.hypot(point.x - x, point.y - y) <= limit)
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function spread(values: number[]): number {
  if (values.length === 0) return 0
  return Math.max(...values) - Math.min(...values)
}

function normalize(x: number, y: number): { x: number; y: number } | null {
  const length = Math.hypot(x, y)
  if (length < 1e-6) return null
  return { x: x / length, y: y / length }
}
