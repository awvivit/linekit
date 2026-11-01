import { describe, expect, it } from 'vitest'
import type { Raster } from './limits.ts'
import { IMAGE_QUAD, isIdentityQuad, warpPerspective } from './perspective.ts'

describe('perspective correction', () => {
  it('returns the same raster when the corners have not moved', () => {
    const raster = solid(12, 8)
    expect(warpPerspective(raster, null)).toBe(raster)
    expect(warpPerspective(raster, IMAGE_QUAD)).toBe(raster)
    expect(isIdentityQuad(IMAGE_QUAD)).toBe(true)
  })

  it('maps the chosen top-left corner onto the output corner', () => {
    const raster = solid(30, 20)
    paint(raster, 8, 4)
    paint(raster, 9, 4)
    paint(raster, 8, 5)
    paint(raster, 9, 5)
    const warped = warpPerspective(raster, {
      topLeft: { x: 0.3, y: 0.25 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    })
    expect(warped).not.toBe(raster)
    expect(warped.data[0]).toBeLessThan(40)
    expect(warped.data[(10 * 30 + 20) * 4] ?? 0).toBeGreaterThan(200)
  })

  it('leaves a collapsed quad alone', () => {
    const raster = solid(10, 10)
    const collapsed = {
      topLeft: { x: 0.5, y: 0.5 },
      topRight: { x: 0.5, y: 0.5 },
      bottomRight: { x: 0.51, y: 0.51 },
      bottomLeft: { x: 0.51, y: 0.5 },
    }
    expect(warpPerspective(raster, collapsed)).toBe(raster)
  })
})

function solid(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255
    data[index + 1] = 255
    data[index + 2] = 255
    data[index + 3] = 255
  }
  return { width, height, data }
}

function paint(raster: Raster, x: number, y: number): void {
  const index = (y * raster.width + x) * 4
  raster.data[index] = 0
  raster.data[index + 1] = 0
  raster.data[index + 2] = 0
  raster.data[index + 3] = 255
}
