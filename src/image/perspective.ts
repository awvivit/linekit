import type { PerspectiveQuad, Raster } from './limits.ts'

export const IMAGE_QUAD: PerspectiveQuad = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
}

type Point = { x: number; y: number }

/** Stable cache key. An untouched page shares the key of “no correction”. */
export function perspectiveKey(quad: PerspectiveQuad | null): string {
  if (!quad || isIdentityQuad(quad)) return ''
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
  return points.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`).join(';')
}

export function isIdentityQuad(quad: PerspectiveQuad): boolean {
  const corners: Array<[Point, Point]> = [
    [quad.topLeft, IMAGE_QUAD.topLeft],
    [quad.topRight, IMAGE_QUAD.topRight],
    [quad.bottomRight, IMAGE_QUAD.bottomRight],
    [quad.bottomLeft, IMAGE_QUAD.bottomLeft],
  ]
  return corners.every(([point, origin]) => Math.abs(point.x - origin.x) <= 0.004 && Math.abs(point.y - origin.y) <= 0.004)
}

/**
 * Map the quad onto the raster rectangle. Samples land with a bilinear filter.
 * An identity quad, or a quad with no area, returns the same raster.
 */
export function warpPerspective(raster: Raster, quad: PerspectiveQuad | null): Raster {
  if (!quad || isIdentityQuad(quad)) return raster
  const { width, height, data } = raster
  if (width < 2 || height < 2) return raster
  const source = [
    denormalize(quad.topLeft, width, height),
    denormalize(quad.topRight, width, height),
    denormalize(quad.bottomRight, width, height),
    denormalize(quad.bottomLeft, width, height),
  ]
  if (polygonArea(source) < width * height * 0.02) return raster
  const destination = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ]
  const homography = mapQuad(destination, source)
  if (!homography) return raster
  const output = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = project(homography, x, y)
      const pixel = sample ? bilinear(data, width, height, sample.x, sample.y) : [255, 255, 255, 255]
      const index = (y * width + x) * 4
      output[index] = pixel[0] ?? 255
      output[index + 1] = pixel[1] ?? 255
      output[index + 2] = pixel[2] ?? 255
      output[index + 3] = pixel[3] ?? 255
    }
  }
  return { width, height, data: output }
}

function denormalize(point: Point, width: number, height: number): Point {
  return {
    x: clamp(point.x, 0, 1) * (width - 1),
    y: clamp(point.y, 0, 1) * (height - 1),
  }
}

function mapQuad(from: Point[], to: Point[]): number[] | null {
  const rows: number[][] = []
  const values: number[] = []
  for (let index = 0; index < 4; index += 1) {
    const origin = from[index]
    const target = to[index]
    if (!origin || !target) return null
    rows.push([origin.x, origin.y, 1, 0, 0, 0, -target.x * origin.x, -target.x * origin.y])
    values.push(target.x)
    rows.push([0, 0, 0, origin.x, origin.y, 1, -target.y * origin.x, -target.y * origin.y])
    values.push(target.y)
  }
  const solved = solveLinear(rows, values)
  if (!solved) return null
  return [...solved, 1]
}

function project(homography: number[], x: number, y: number): Point | null {
  const weight = (homography[6] ?? 0) * x + (homography[7] ?? 0) * y + (homography[8] ?? 1)
  if (!Number.isFinite(weight) || Math.abs(weight) < 1e-8) return null
  const projected = {
    x: ((homography[0] ?? 0) * x + (homography[1] ?? 0) * y + (homography[2] ?? 0)) / weight,
    y: ((homography[3] ?? 0) * x + (homography[4] ?? 0) * y + (homography[5] ?? 0)) / weight,
  }
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null
  return projected
}

function bilinear(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): number[] {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return [255, 255, 255, 255]
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const sample = (px: number, py: number) => {
    const index = (py * width + px) * 4
    return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, data[index + 3] ?? 255]
  }
  const topLeft = sample(x0, y0)
  const topRight = sample(x1, y0)
  const bottomLeft = sample(x0, y1)
  const bottomRight = sample(x1, y1)
  return [0, 1, 2, 3].map((channel) => {
    const top = (topLeft[channel] ?? 0) * (1 - tx) + (topRight[channel] ?? 0) * tx
    const bottom = (bottomLeft[channel] ?? 0) * (1 - tx) + (bottomRight[channel] ?? 0) * tx
    return top * (1 - ty) + bottom * ty
  })
}

function solveLinear(matrix: number[][], values: number[]): number[] | null {
  const size = values.length
  const rows = matrix.map((row, index) => [...row, values[index] ?? 0])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = row
    }
    const pivotRow = rows[pivot]
    const current = rows[column]
    if (!pivotRow || !current) return null
    rows[pivot] = current
    rows[column] = pivotRow
    const scale = pivotRow[column] ?? 0
    if (Math.abs(scale) < 1e-10) return null
    for (let columnIndex = column; columnIndex <= size; columnIndex += 1) {
      pivotRow[columnIndex] = (pivotRow[columnIndex] ?? 0) / scale
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const line = rows[row]
      if (!line) return null
      const factor = line[column] ?? 0
      if (factor === 0) continue
      for (let columnIndex = column; columnIndex <= size; columnIndex += 1) {
        line[columnIndex] = (line[columnIndex] ?? 0) - factor * (pivotRow[columnIndex] ?? 0)
      }
    }
  }
  return rows.map((row) => row[size] ?? 0)
}

function polygonArea(points: Point[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
