import { describe, expect, it } from 'vitest'
import { traceCenterline } from './centerline.ts'
import type { BinaryImage } from './limits.ts'
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

function strokeWidth(svg: string): number {
  const match = /stroke-width="([^"]+)"/.exec(svg)
  return Number(match?.[1] ?? '0')
}

function curveCount(svg: string): number {
  const data = paths(svg).join(' ')
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
