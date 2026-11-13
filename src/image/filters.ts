import type { Raster } from './limits.ts'

export type TraceFilter = {
  smoothNoise: number
  edgeDetail: number
  evenLighting: boolean
}

/**
 * Optional cleanup before a trace.
 * Lighting, then edge-preserving blur, then sharpening.
 * Each stage is skipped when its control is off so they are not stacked blindly.
 */
export function applyTraceFilters(raster: Raster, filters: TraceFilter): Raster {
  const smooth = clamp(filters.smoothNoise, 0, 100)
  const edge = clamp(filters.edgeDetail, 0, 100)
  if (smooth <= 0 && edge <= 0 && !filters.evenLighting) return raster
  let current = filters.evenLighting ? flattenLighting(raster) : raster
  if (smooth > 0) current = bilateral(current, smooth)
  if (edge > 0) current = unsharp(current, edge)
  return current
}

function flattenLighting(raster: Raster): Raster {
  const gray = luminance(raster)
  const radius = Math.max(4, Math.round(Math.max(raster.width, raster.height) / 12))
  const background = boxBlur(gray, raster.width, raster.height, radius)
  const target = percentile(background, 0.85)
  const output = new Uint8ClampedArray(raster.data.length)
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const gain = clamp(target / Math.max(8, background[pixel] ?? target), 0.45, 2.2)
    const offset = pixel * 4
    output[offset] = clampByte((raster.data[offset] ?? 0) * gain)
    output[offset + 1] = clampByte((raster.data[offset + 1] ?? 0) * gain)
    output[offset + 2] = clampByte((raster.data[offset + 2] ?? 0) * gain)
    output[offset + 3] = raster.data[offset + 3] ?? 255
  }
  return { width: raster.width, height: raster.height, data: output }
}

function bilateral(raster: Raster, amount: number): Raster {
  const radius = amount >= 60 ? 2 : 1
  const sigma = 8 + amount * 0.4
  const sigma2 = 2 * sigma * sigma
  const { width, height, data } = raster
  const output = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = (y * width + x) * 4
      let red = 0
      let green = 0
      let blue = 0
      let weight = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sampleY = Math.min(height - 1, Math.max(0, y + dy))
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sampleX = Math.min(width - 1, Math.max(0, x + dx))
          const index = (sampleY * width + sampleX) * 4
          const distance =
            ((data[index] ?? 0) - (data[center] ?? 0)) ** 2 +
            ((data[index + 1] ?? 0) - (data[center + 1] ?? 0)) ** 2 +
            ((data[index + 2] ?? 0) - (data[center + 2] ?? 0)) ** 2
          const sampleWeight = Math.exp(-distance / sigma2)
          red += (data[index] ?? 0) * sampleWeight
          green += (data[index + 1] ?? 0) * sampleWeight
          blue += (data[index + 2] ?? 0) * sampleWeight
          weight += sampleWeight
        }
      }
      output[center] = clampByte(red / weight)
      output[center + 1] = clampByte(green / weight)
      output[center + 2] = clampByte(blue / weight)
      output[center + 3] = data[center + 3] ?? 255
    }
  }
  return { width, height, data: output }
}

function unsharp(raster: Raster, amount: number): Raster {
  const blurred = boxBlurRgb(raster, 1)
  const gain = (clamp(amount, 0, 100) / 100) * 1.35
  const output = new Uint8ClampedArray(raster.data.length)
  for (let index = 0; index < raster.data.length; index += 4) {
    output[index] = clampByte((raster.data[index] ?? 0) + gain * ((raster.data[index] ?? 0) - (blurred[index] ?? 0)))
    output[index + 1] = clampByte(
      (raster.data[index + 1] ?? 0) + gain * ((raster.data[index + 1] ?? 0) - (blurred[index + 1] ?? 0)),
    )
    output[index + 2] = clampByte(
      (raster.data[index + 2] ?? 0) + gain * ((raster.data[index + 2] ?? 0) - (blurred[index + 2] ?? 0)),
    )
    output[index + 3] = raster.data[index + 3] ?? 255
  }
  return { width: raster.width, height: raster.height, data: output }
}

function boxBlurRgb(raster: Raster, radius: number): Uint8ClampedArray {
  const channels = [0, 1, 2].map((channel) => {
    const plane = new Float32Array(raster.width * raster.height)
    for (let pixel = 0; pixel < plane.length; pixel += 1) {
      plane[pixel] = raster.data[pixel * 4 + channel] ?? 0
    }
    return boxBlur(plane, raster.width, raster.height, radius)
  })
  const output = new Uint8ClampedArray(raster.data.length)
  for (let pixel = 0; pixel < raster.width * raster.height; pixel += 1) {
    output[pixel * 4] = clampByte(channels[0]?.[pixel] ?? 0)
    output[pixel * 4 + 1] = clampByte(channels[1]?.[pixel] ?? 0)
    output[pixel * 4 + 2] = clampByte(channels[2]?.[pixel] ?? 0)
    output[pixel * 4 + 3] = raster.data[pixel * 4 + 3] ?? 255
  }
  return output
}

function luminance(raster: Raster): Float32Array {
  const gray = new Float32Array(raster.width * raster.height)
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const index = pixel * 4
    gray[pixel] =
      0.2126 * (raster.data[index] ?? 0) +
      0.7152 * (raster.data[index + 1] ?? 0) +
      0.0722 * (raster.data[index + 2] ?? 0)
  }
  return gray
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = new Float32Array(source.length)
  const vertical = new Float32Array(source.length)
  const windowSize = radius * 2 + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[row + clampIndex(x, width)] ?? 0
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / windowSize
      sum -= source[row + clampIndex(x - radius, width)] ?? 0
      sum += source[row + clampIndex(x + radius + 1, width)] ?? 0
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[clampIndex(y, height) * width + x] ?? 0
    }
    for (let y = 0; y < height; y += 1) {
      vertical[y * width + x] = sum / windowSize
      sum -= horizontal[clampIndex(y - radius, height) * width + x] ?? 0
      sum += horizontal[clampIndex(y + radius + 1, height) * width + x] ?? 0
    }
  }
  return vertical
}

function percentile(values: Float32Array, rank: number): number {
  const copy = Array.from(values).sort((left, right) => left - right)
  const index = Math.min(copy.length - 1, Math.max(0, Math.round(rank * (copy.length - 1))))
  return copy[index] ?? 255
}

function clampIndex(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampByte(value: number): number {
  return clamp(Math.round(value), 0, 255)
}
