import { describe, expect, it } from 'vitest'
import { planTrace } from './classify.ts'
import { cartoonSample, litInkSample, plainInkSample, taperedInkSample, tileSample } from './samples.ts'

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

  it('turns on even lighting when the paper gradient is uneven', () => {
    const plan = planTrace(litInkSample())
    expect(plan.evenLighting, JSON.stringify(plan)).toBe(true)
  })
})
