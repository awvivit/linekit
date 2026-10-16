import { describe, expect, it } from 'vitest'
import type { Raster } from './limits.ts'
import { MAX_EDGE } from './limits.ts'
import {
  applyOrientation,
  cleanDrawing,
  cropNormalized,
  downscaleRaster,
} from './raster.ts'

describe('downscale', () => {
  it('keeps a 2×2 block average', () => {
    const raster = solid(2, 2, [0, 0, 0, 255])
    paint(raster, 1, 0, [255, 0, 0, 255])
    paint(raster, 0, 1, [0, 255, 0, 255])
    paint(raster, 1, 1, [0, 0, 255, 255])
    const scaled = downscaleRaster(raster, 1)
    expect(scaled.width).toBe(1)
    expect(scaled.height).toBe(1)
    expect(scaled.data[0]).toBeGreaterThan(40)
    expect(scaled.data[1]).toBeGreaterThan(40)
    expect(scaled.data[2]).toBeGreaterThan(40)
  })

  it('downscales a 4032×3024 photo so the longest side is 4000', () => {
    const raster = solid(4032, 3024, [240, 240, 240, 255])
    paint(raster, 0, 0, [0, 0, 0, 255])
    const scaled = downscaleRaster(raster, MAX_EDGE)
    expect(scaled.width).toBe(4000)
    expect(scaled.height).toBe(3000)
    expect(Math.max(scaled.width, scaled.height)).toBeLessThanOrEqual(MAX_EDGE)
  }, 20_000)
})

describe('orientation', () => {
  it('rotates a sideways drawing upright', () => {
    const stored = solid(6, 4, [255, 255, 255, 255])
    paint(stored, 0, 0, [0, 0, 0, 255])
    const upright = applyOrientation(stored, 6)
    expect(upright.width).toBe(4)
    expect(upright.height).toBe(6)
    expect(pixel(upright, 3, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(upright, 0, 0)).toEqual([255, 255, 255, 255])
  })

  it.each([
    [2, 5, 0],
    [3, 5, 3],
    [4, 0, 3],
    [5, 0, 0],
    [8, 0, 5],
  ] as const)('moves the top-left marker for orientation %s', (orientation, x, y) => {
    const stored = solid(6, 4, [255, 255, 255, 255])
    paint(stored, 0, 0, [9, 8, 7, 255])
    const upright = applyOrientation(stored, orientation)
    expect(pixel(upright, x, y)).toEqual([9, 8, 7, 255])
  })
})

describe('cleanup', () => {
  it('keeps a dark line under a shadow and drops specks', () => {
    const raster = solid(48, 32, [255, 255, 255, 255])
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        const shade = 140 + x * 2
        paint(raster, x, y, [shade, shade, shade, 255])
      }
    }
    for (let x = 8; x < 40; x += 1) {
      paint(raster, x, 16, [18, 18, 18, 255])
      paint(raster, x, 17, [18, 18, 18, 255])
    }
    paint(raster, 2, 2, [10, 10, 10, 255])
    paint(raster, 4, 8, [10, 10, 10, 255])
    paint(raster, 44, 4, [10, 10, 10, 255])

    const cleaned = cleanDrawing(raster, 62, 80)
    expect(cleaned.ink[16 * raster.width + 20]).toBe(1)
    expect(cleaned.ink[4 * raster.width + 4]).toBe(0)
    expect(cleaned.ink[2 * raster.width + 2]).toBe(0)
    expect(cleaned.ink[8 * raster.width + 4]).toBe(0)
    expect(cleaned.ink[4 * raster.width + 44]).toBe(0)
    const inkCount = cleaned.ink.reduce((total, value) => total + value, 0)
    expect(inkCount).toBeGreaterThan(20)
    expect(inkCount).toBeLessThan(400)
  })

  it('crops to a rectangle before the cleaned pixels are measured', () => {
    const raster = solid(20, 10, [255, 255, 255, 255])
    for (let y = 0; y < 10; y += 1) paint(raster, 1, y, [0, 0, 0, 255])
    const cropped = cropNormalized(raster, { x: 0.5, y: 0, width: 0.5, height: 1 })
    expect(cropped.width).toBe(10)
    expect(cropped.height).toBe(10)
    const cleaned = cleanDrawing(cropped, 70, 0)
    expect(cleaned.ink.some((value) => value === 1)).toBe(false)
  })
})

function solid(width: number, height: number, fill: [number, number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0]
    data[index + 1] = fill[1]
    data[index + 2] = fill[2]
    data[index + 3] = fill[3]
  }
  return { width, height, data }
}

function paint(raster: Raster, x: number, y: number, fill: [number, number, number, number]): void {
  const index = (y * raster.width + x) * 4
  raster.data[index] = fill[0]
  raster.data[index + 1] = fill[1]
  raster.data[index + 2] = fill[2]
  raster.data[index + 3] = fill[3]
}

function pixel(raster: Raster, x: number, y: number): number[] {
  const index = (y * raster.width + x) * 4
  return [
    raster.data[index] ?? 0,
    raster.data[index + 1] ?? 0,
    raster.data[index + 2] ?? 0,
    raster.data[index + 3] ?? 0,
  ]
}
