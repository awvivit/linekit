import { describe, expect, it } from 'vitest'
import { planTrace } from './classify.ts'
import type { Raster } from './limits.ts'
import {
  cartoonSample,
  fillEllipse,
  litInkSample,
  plainInkSample,
  solid,
  taperedInkSample,
  tileSample,
  type Rgba,
} from './samples.ts'

describe('planTrace', () => {
  it('keeps plain two-tone ink on Lines', () => {
    const plan = planTrace(plainInkSample())
    expect(plan.mode, plan.summary).toBe('lines')
    expect(plan.summary).toBe('Auto picked Lines.')
    expect(plan.smoothNoise).toBe(0)
    expect(plan.evenLighting).toBe(false)
  })

  it('sends a tapered grayscale cartoon to Full trace', () => {
    const plan = planTrace(cartoonSample())
    expect(plan.mode, JSON.stringify(plan)).toBe('full')
    expect(plan.colorCount).toBeGreaterThanOrEqual(3)
    expect(plan.colorCount).toBeLessThanOrEqual(16)
    expect(plan.summary).toBe(`Auto picked Full trace with ${plan.colorCount} colors.`)
    expect(plan.evenLighting).toBe(false)
  })

  it('sends tapered ink without gray fills to Full trace', () => {
    const plan = planTrace(taperedInkSample())
    expect(plan.mode, JSON.stringify(plan)).toBe('full')
  })

  it('sends flat color tiles to Full trace with several colors', () => {
    const plan = planTrace(tileSample())
    expect(plan.mode, JSON.stringify(plan)).toBe('full')
    expect(plan.colorCount).toBeGreaterThanOrEqual(5)
    expect(plan.summary).toContain('Full trace')
    expect(plan.summary).toContain(`${plan.colorCount} colors`)
  })

  it('keeps large plain constant-width ink on Lines above the sample size', () => {
    const width = 2000
    const height = 1200
    const radius = 3
    const raster = solid(width, height)
    stroke(raster, 80, 160, 1920, 160, radius)
    stroke(raster, 180, 80, 180, 1120, radius)
    stroke(raster, 100, 200, 1900, 1060, radius)
    stroke(raster, 140, 1080, 1860, 240, radius)
    expect(Math.max(width, height)).toBeGreaterThan(480)
    const plan = planTrace(raster)
    expect(plan.mode, plan.summary).toBe('lines')
    expect(plan.summary).toBe('Auto picked Lines.')
  })

function stroke(raster: Raster, x0: number, y0: number, x1: number, y1: number, radius: number): void {
  const ink: Rgba = [0, 0, 0, 255]
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    fillEllipse(raster, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, radius, ink)
  }
}

  it('turns on even lighting when the paper gradient is uneven', () => {
    const plan = planTrace(litInkSample())
    expect(plan.evenLighting, JSON.stringify(plan)).toBe(true)
  })
})
