import { describe, expect, it } from 'vitest'
import { planTrace } from './classify.ts'
import { fullTrace, quantizeDrawing } from './fulltrace.ts'
import { DEFAULT_CONTROLS, type Raster } from './limits.ts'
import { tracePrepared, tracePreparedDocument } from './process.ts'
import {
  cartoonSample,
  fillRect,
  plainInkSample,
  solid,
  taperedInkSample,
  tileSample,
} from './samples.ts'

const neutral = {
  smoothNoise: 0,
  edgeDetail: 0,
  evenLighting: false,
  smoothing: 28,
}

describe('full trace', () => {
  it('keeps a tapered cartoon as filled shapes, not a centerline', () => {
    const raster = cartoonSample()
    const plan = planTrace(raster)
    const svg = fullTrace(raster, { ...neutral, colorCount: plan.colorCount })
    expect(svg).toContain('fill=')
    expect(svg).not.toContain('stroke-linecap="round"')
    const fills = readFills(svg)
    expect(fills.length).toBeGreaterThanOrEqual(4)
    expect(fills.length).toBeLessThan(40)
    expect(fills.some((fill) => fill.tone === 'dark' && boxArea(fill) < raster.width * raster.height * 0.08)).toBe(true)
    expect(fills.some((fill) => fill.tone === 'light' && boxArea(fill) < raster.width * raster.height * 0.05)).toBe(true)
    expect(fills.some((fill) => fill.tone === 'mid')).toBe(true)
    const centerline = tracePrepared(
      { raster, width: raster.width, height: raster.height },
      { ...DEFAULT_CONTROLS, view: 'lines' },
    )
    expect(centerline).toContain('stroke-linecap="round"')
  })

  it('keeps flat tile colors, icons, and white letters without a halo color', () => {
    const raster = tileSample()
    const plan = planTrace(raster)
    const svg = fullTrace(raster, { ...neutral, colorCount: plan.colorCount })
    const fills = readFills(svg)
    expect(fills.length).toBeLessThan(50)
    expect(fills.some((fill) => fill.tone === 'red')).toBe(true)
    expect(fills.some((fill) => fill.tone === 'blue')).toBe(true)
    expect(fills.some((fill) => fill.tone === 'yellow')).toBe(true)
    expect(fills.some((fill) => fill.tone === 'green')).toBe(true)
    const letters = fills.filter((fill) => fill.tone === 'light' && boxArea(fill) < raster.width * raster.height * 0.2)
    expect(letters.length).toBeGreaterThan(0)
    expect(fills.some((fill) => fill.tone === 'blend')).toBe(false)
    const indexed = quantizeDrawing(raster, { ...neutral, colorCount: plan.colorCount })
    expect(countBlendPixels(indexed.raster)).toBe(0)
  })

  it('snaps a one-pixel blend seam back to the neighboring flats', () => {
    const raster = solid(30, 20, [220, 20, 20, 255])
    fillRect(raster, 15, 0, 30, 20, [20, 20, 220, 255])
    fillRect(raster, 14, 0, 16, 20, [130, 20, 130, 255])
    const indexed = quantizeDrawing(raster, { ...neutral, colorCount: 4 })
    expect(countBlendPixels(indexed.raster)).toBe(0)
  })

  it('keeps the corners of a rectangle', () => {
    const raster = solid(48, 40)
    fillRect(raster, 8, 8, 40, 32, [12, 12, 12, 255])
    const svg = fullTrace(raster, { ...neutral, colorCount: 2 })
    const dark = readFills(svg).filter((fill) => fill.tone === 'dark')
    expect(dark.length).toBeGreaterThan(0)
    const points = dark.flatMap((fill) => fill.points)
    expect(near(points, 8, 8)).toBe(true)
    expect(near(points, 40, 8)).toBe(true)
    expect(near(points, 8, 32)).toBe(true)
    expect(near(points, 40, 32)).toBe(true)
  })

  it('traces plain ink with the centerline pipeline', () => {
    const raster = plainInkSample()
    const traced = tracePreparedDocument(
      { raster, width: raster.width, height: raster.height },
      { ...DEFAULT_CONTROLS, view: 'auto', followAuto: true },
    )
    expect(traced.plan.mode).toBe('lines')
    expect(traced.resolved).toBe('lines')
    expect(traced.svg).toContain('stroke-linecap="round"')
    const manual = tracePrepared(
      { raster, width: raster.width, height: raster.height },
      { ...DEFAULT_CONTROLS, view: 'lines' },
    )
    expect(traced.svg).toBe(manual)
  })

  it('does not reduce a tapered wedge to a centerline', () => {
    const raster = taperedInkSample()
    const traced = tracePreparedDocument(
      { raster, width: raster.width, height: raster.height },
      { ...DEFAULT_CONTROLS, view: 'auto', followAuto: true },
    )
    expect(traced.resolved).toBe('full')
    expect(traced.svg).not.toContain('stroke-linecap="round"')
    const fills = readFills(traced.svg)
    expect(fills.some((fill) => fill.tone === 'dark')).toBe(true)
  })
})

type Tone = 'dark' | 'mid' | 'light' | 'red' | 'blue' | 'yellow' | 'green' | 'blend' | 'other'

type Fill = {
  tone: Tone
  points: Array<{ x: number; y: number }>
}

function readFills(svg: string): Fill[] {
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/g)].map((match) => match[1] ?? '')
  return paths.flatMap((attributes) => {
    const fill = /fill="([^"]+)"/i.exec(attributes)?.[1]
    const data = /d="([^"]+)"/i.exec(attributes)?.[1]
    if (!fill || !data || fill === 'none') return []
    const rgb = parseColor(fill)
    if (!rgb) return []
    return [{ tone: toneOf(rgb), points: pathPoints(data) }]
  })
}

function parseColor(fill: string): { r: number; g: number; b: number } | null {
  const cleaned = fill.replace(/\s+/g, '').toLowerCase()
  if (cleaned === 'white' || cleaned === '#fff' || cleaned === '#ffffff') return { r: 255, g: 255, b: 255 }
  if (cleaned === 'black' || cleaned === '#000' || cleaned === '#000000') return { r: 0, g: 0, b: 0 }
  const hex = /^#([\da-f]{6})$/.exec(cleaned)
  if (hex?.[1]) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
    }
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(cleaned)
  if (!rgb) return null
  return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
}

function toneOf(color: { r: number; g: number; b: number }): Tone {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
  if (color.r > 160 && color.g < 110 && color.b < 110) return 'red'
  if (color.b > 140 && color.r < 120 && color.g < 160) return 'blue'
  if (color.r > 180 && color.g > 140 && color.b < 120) return 'yellow'
  if (color.g > 110 && color.r < 120 && color.b < 130 && color.g > color.r && color.g > color.b) return 'green'
  if (max - min > 40 && luma > 40 && luma < 180 && color.r > 70 && color.b > 70 && color.g < 100) return 'blend'
  if (luma >= 230) return 'light'
  if (luma <= 70) return 'dark'
  return 'mid'
}

function pathPoints(data: string): Array<{ x: number; y: number }> {
  const tokens = data.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  const points: Array<{ x: number; y: number }> = []
  let command = ''
  let index = 0
  let x = 0
  let y = 0
  const read = () => {
    const value = Number(tokens[index] ?? '0')
    index += 1
    return value
  }
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/[a-zA-Z]/.test(token)) {
      command = token
      index += 1
      continue
    }
    if (command === 'M' || command === 'L' || command === 'T') {
      x = read()
      y = read()
      if (command === 'M') command = 'L'
      points.push({ x, y })
    } else if (command === 'm' || command === 'l' || command === 't') {
      x += read()
      y += read()
      if (command === 'm') command = 'l'
      points.push({ x, y })
    } else if (command === 'H') {
      x = read()
      points.push({ x, y })
    } else if (command === 'h') {
      x += read()
      points.push({ x, y })
    } else if (command === 'V') {
      y = read()
      points.push({ x, y })
    } else if (command === 'v') {
      y += read()
      points.push({ x, y })
    } else if (command === 'C') {
      read()
      read()
      read()
      read()
      x = read()
      y = read()
      points.push({ x, y })
    } else if (command === 'c') {
      read()
      read()
      read()
      read()
      x += read()
      y += read()
      points.push({ x, y })
    } else if (command === 'Q' || command === 'S') {
      read()
      read()
      x = read()
      y = read()
      points.push({ x, y })
    } else if (command === 'q' || command === 's') {
      read()
      read()
      x += read()
      y += read()
      points.push({ x, y })
    } else {
      index += 1
    }
  }
  return points
}

function boxArea(fill: Fill): number {
  if (fill.points.length === 0) return 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of fill.points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
}

function near(points: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  return points.some((point) => Math.hypot(point.x - x, point.y - y) <= 4)
}

function countBlendPixels(raster: Raster): number {
  let blends = 0
  for (let index = 0; index < raster.data.length; index += 4) {
    const red = raster.data[index] ?? 0
    const green = raster.data[index + 1] ?? 0
    const blue = raster.data[index + 2] ?? 0
    if (red > 70 && blue > 70 && green < 100 && red < 190 && blue < 190) blends += 1
  }
  return blends
}
