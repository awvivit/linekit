import type { Raster } from './limits.ts'

export type Rgba = [number, number, number, number]

const WHITE: Rgba = [255, 255, 255, 255]
const BLACK: Rgba = [16, 16, 18, 255]

/** Made-up drawings for tests. No people, names, or grades. */
export function solid(width: number, height: number, color: Rgba = WHITE): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0]
    data[index + 1] = color[1]
    data[index + 2] = color[2]
    data[index + 3] = color[3]
  }
  return { width, height, data }
}

export function fillRect(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
): void {
  const left = clamp(Math.ceil(Math.min(x0, x1)), 0, raster.width)
  const right = clamp(Math.floor(Math.max(x0, x1)), 0, raster.width)
  const top = clamp(Math.ceil(Math.min(y0, y1)), 0, raster.height)
  const bottom = clamp(Math.floor(Math.max(y0, y1)), 0, raster.height)
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      paint(raster, x, y, color)
    }
  }
}

export function fillEllipse(raster: Raster, cx: number, cy: number, rx: number, ry: number, color: Rgba): void {
  const left = Math.max(0, Math.floor(cx - rx))
  const right = Math.min(raster.width - 1, Math.ceil(cx + rx))
  const top = Math.max(0, Math.floor(cy - ry))
  const bottom = Math.min(raster.height - 1, Math.ceil(cy + ry))
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const nx = (x + 0.5 - cx) / rx
      const ny = (y + 0.5 - cy) / ry
      if (nx * nx + ny * ny <= 1) paint(raster, x, y, color)
    }
  }
}

export function fillPolygon(raster: Raster, points: Array<{ x: number; y: number }>, color: Rgba): void {
  if (points.length < 3) return
  let top = raster.height
  let bottom = 0
  for (const point of points) {
    top = Math.min(top, point.y)
    bottom = Math.max(bottom, point.y)
  }
  const yStart = Math.max(0, Math.floor(top))
  const yEnd = Math.min(raster.height - 1, Math.ceil(bottom))
  for (let y = yStart; y <= yEnd; y += 1) {
    const crossings: number[] = []
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]
      const b = points[(index + 1) % points.length]
      if (!a || !b) continue
      const y0 = a.y
      const y1 = b.y
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y + 0.5 - y0) / (y1 - y0)
        crossings.push(a.x + t * (b.x - a.x))
      }
    }
    crossings.sort((left, right) => left - right)
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const start = crossings[index]
      const end = crossings[index + 1]
      if (start === undefined || end === undefined) continue
      fillRect(raster, start, y, end, y + 1, color)
    }
  }
}

/** Constant-width black ink on white. Auto should pick Lines. */
export function plainInkSample(): Raster {
  const raster = solid(96, 48)
  fillRect(raster, 12, 18, 84, 28, BLACK)
  fillRect(raster, 18, 8, 28, 40, BLACK)
  return raster
}

/** One black wedge, thick at the base and pointed at the tip. */
export function taperedInkSample(): Raster {
  const raster = solid(80, 96)
  fillPolygon(
    raster,
    [
      { x: 8, y: 84 },
      { x: 72, y: 84 },
      { x: 40, y: 10 },
    ],
    BLACK,
  )
  return raster
}

/**
 * Generic grayscale cartoon: tapered ears, gray body, solid eyes with
 * highlights, and a simple stripe pattern. Not a real character.
 */
export function cartoonSample(): Raster {
  const raster = solid(180, 150)
  const body: Rgba = [176, 176, 180, 255]
  const head: Rgba = [158, 158, 164, 255]
  const ear: Rgba = [108, 108, 114, 255]
  const stripe: Rgba = [58, 58, 64, 255]
  fillEllipse(raster, 90, 96, 52, 36, body)
  fillEllipse(raster, 90, 52, 28, 26, head)
  fillPolygon(
    raster,
    [
      { x: 68, y: 40 },
      { x: 84, y: 36 },
      { x: 62, y: 8 },
    ],
    ear,
  )
  fillPolygon(
    raster,
    [
      { x: 96, y: 36 },
      { x: 112, y: 40 },
      { x: 118, y: 8 },
    ],
    ear,
  )
  fillRect(raster, 58, 86, 122, 92, stripe)
  fillRect(raster, 58, 100, 122, 106, stripe)
  fillRect(raster, 58, 114, 122, 120, stripe)
  fillEllipse(raster, 78, 50, 8, 8, BLACK)
  fillEllipse(raster, 102, 50, 8, 8, BLACK)
  fillEllipse(raster, 80, 48, 3, 3, WHITE)
  fillEllipse(raster, 104, 48, 3, 3, WHITE)
  return raster
}

/**
 * Flat color tiles, a small dark icon on each, and blocky white letters.
 * The letters are not names or grades.
 */
export function tileSample(): Raster {
  const raster = solid(180, 140)
  const tiles: Array<{ x: number; color: Rgba }> = [
    { x: 8, color: [214, 54, 48, 255] },
    { x: 50, color: [42, 92, 196, 255] },
    { x: 92, color: [236, 186, 42, 255] },
    { x: 134, color: [46, 150, 78, 255] },
  ]
  for (const tile of tiles) {
    fillRect(raster, tile.x, 8, tile.x + 38, 78, tile.color)
    fillRect(raster, tile.x + 16, 28, tile.x + 22, 52, BLACK)
    fillRect(raster, tile.x + 10, 36, tile.x + 28, 42, BLACK)
  }
  fillRect(raster, 8, 92, 172, 128, [24, 32, 64, 255])
  drawH(raster, 28, 100, WHITE)
  drawI(raster, 62, 100, WHITE)
  return raster
}

/** Soft paper gradient with a dark stroke. Auto may even out the lighting. */
export function litInkSample(): Raster {
  const raster = solid(80, 48)
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const shade = Math.round(70 + (x / raster.width) * 150)
      paint(raster, x, y, [shade, shade, shade, 255])
    }
  }
  fillRect(raster, 16, 20, 64, 28, BLACK)
  return raster
}

function drawH(raster: Raster, x: number, y: number, color: Rgba): void {
  fillRect(raster, x, y, x + 4, y + 22, color)
  fillRect(raster, x + 14, y, x + 18, y + 22, color)
  fillRect(raster, x, y + 9, x + 18, y + 13, color)
}

function drawI(raster: Raster, x: number, y: number, color: Rgba): void {
  fillRect(raster, x, y, x + 16, y + 4, color)
  fillRect(raster, x + 6, y, x + 10, y + 22, color)
  fillRect(raster, x, y + 18, x + 16, y + 22, color)
}

function paint(raster: Raster, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return
  const index = (y * raster.width + x) * 4
  raster.data[index] = color[0]
  raster.data[index + 1] = color[1]
  raster.data[index + 2] = color[2]
  raster.data[index + 3] = color[3]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
