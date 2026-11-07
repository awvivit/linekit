import { describe, expect, it } from 'vitest'
import { applyTraceFilters } from './filters.ts'
import type { Raster } from './limits.ts'
import { solid } from './samples.ts'

describe('applyTraceFilters', () => {
  it('returns the same raster when every filter is off', () => {
    const raster = solid(12, 8, [20, 30, 40, 255])
    expect(applyTraceFilters(raster, { smoothNoise: 0, edgeDetail: 0, evenLighting: false })).toBe(raster)
  })

  it('smooths speckled flats and leaves a hard edge in place', () => {
    const raster = solid(28, 16)
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        const speck = (x * 13 + y * 7) % 5 === 0 ? 28 : 0
        const value = (x < 14 ? 30 : 220) + (x === 13 || x === 14 ? 0 : speck * (x < 14 ? 1 : -1))
        setPixel(raster, x, y, value)
      }
    }
    const smoothed = applyTraceFilters(raster, { smoothNoise: 70, edgeDetail: 0, evenLighting: false })
    const left = mean(smoothed, 1, 6)
    const right = mean(smoothed, 20, 26)
    expect(left).toBeLessThan(50)
    expect(right).toBeGreaterThan(200)
    expect(deviation(smoothed, 1, 6)).toBeLessThan(deviation(raster, 1, 6))
  })

  it('increases contrast across a soft ramp', () => {
    const raster = solid(16, 8)
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        const value = x < 7 ? 30 : x > 8 ? 210 : x === 7 ? 80 : 160
        setPixel(raster, x, y, value)
      }
    }
    const sharp = applyTraceFilters(raster, { smoothNoise: 0, edgeDetail: 80, evenLighting: false })
    const before = pixel(raster, 8, 4) - pixel(raster, 7, 4)
    const after = pixel(sharp, 8, 4) - pixel(sharp, 7, 4)
    expect(after).toBeGreaterThan(before + 4)
  })

  it('flattens a slow paper gradient without a filter stack', () => {
    const raster = solid(40, 16)
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        setPixel(raster, x, y, Math.round(70 + (x / raster.width) * 140))
      }
    }
    const even = applyTraceFilters(raster, { smoothNoise: 0, edgeDetail: 0, evenLighting: true })
    const before = Math.abs(mean(raster, 0, 6) - mean(raster, 33, 39))
    const after = Math.abs(mean(even, 0, 6) - mean(even, 33, 39))
    expect(after).toBeLessThan(before * 0.55)
  })
})

function setPixel(raster: Raster, x: number, y: number, value: number): void {
  const index = (y * raster.width + x) * 4
  raster.data[index] = value
  raster.data[index + 1] = value
  raster.data[index + 2] = value
  raster.data[index + 3] = 255
}

function pixel(raster: Raster, x: number, y: number): number {
  return raster.data[(y * raster.width + x) * 4] ?? 0
}

function mean(raster: Raster, x0: number, x1: number): number {
  let total = 0
  let count = 0
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += pixel(raster, x, y)
      count += 1
    }
  }
  return total / count
}

function deviation(raster: Raster, x0: number, x1: number): number {
  const average = mean(raster, x0, x1)
  let total = 0
  let count = 0
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += (pixel(raster, x, y) - average) ** 2
      count += 1
    }
  }
  return Math.sqrt(total / count)
}
