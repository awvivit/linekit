import type { Raster } from './limits.ts'
import { downscaleRaster } from './raster.ts'

export type AutoMode = 'lines' | 'full'

export type AutoPlan = {
  mode: AutoMode
  colorCount: number
  smoothNoise: number
  edgeDetail: number
  evenLighting: boolean
  faintLines: number
  smoothing: number
  specks: number
  summary: string
}

const SAMPLE_EDGE = 480

/**
 * On-device look at the drawing. Plain two-tone ink stays Lines.
 * Gray bands, tapered ink, or several flat colors become Full trace.
 */
export function planTrace(raster: Raster): AutoPlan {
  const sample = Math.max(raster.width, raster.height) > SAMPLE_EDGE ? downscaleRaster(raster, SAMPLE_EDGE) : raster
  const stats = measure(sample)
  const mode = chooseMode(stats)
  const colorCount = mode === 'full' ? clampCount(stats.palette) : 2
  const smoothNoise = stats.flatNoise > 9 ? 24 : 0
  const edgeDetail = stats.softEdges > 0.12 ? 28 : 0
  const evenLighting = stats.lightSpread > 22
  const faintLines = stats.inkLuma > 90 ? 78 : 62
  return {
    mode,
    colorCount,
    smoothNoise,
    edgeDetail,
    evenLighting,
    faintLines,
    smoothing: 28,
    specks: stats.speckShare > 0.08 ? 48 : 35,
    summary: mode === 'lines' ? 'Auto picked Lines.' : `Auto picked Full trace with ${colorCount} colors.`,
  }
}

export function samePlan(left: AutoPlan | null, right: AutoPlan | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.mode === right.mode &&
    left.colorCount === right.colorCount &&
    left.smoothNoise === right.smoothNoise &&
    left.edgeDetail === right.edgeDetail &&
    left.evenLighting === right.evenLighting &&
    left.faintLines === right.faintLines &&
    left.smoothing === right.smoothing &&
    left.specks === right.specks &&
    left.summary === right.summary
  )
}

type Stats = {
  content: number
  palette: number
  colorful: boolean
  bands: number
  widthCv: number
  flatNoise: number
  softEdges: number
  lightSpread: number
  inkLuma: number
  speckShare: number
}

function chooseMode(stats: Stats): AutoMode {
  if (stats.content < 24) return 'lines'
  if (stats.colorful) return 'full'
  if (stats.bands >= 3) return 'full'
  if (stats.widthCv >= 0.34) return 'full'
  return 'lines'
}

function measure(raster: Raster): Stats {
  const { width, height, data } = raster
  const count = width * height
  const luma = new Float32Array(count)
  const chroma = new Float32Array(count)
  let content = 0
  let chromaSum = 0
  let inkLuma = 0
  let inkCount = 0
  const bins = new Map<number, number>()
  for (let pixel = 0; pixel < count; pixel += 1) {
    const index = pixel * 4
    const red = data[index] ?? 0
    const green = data[index + 1] ?? 0
    const blue = data[index + 2] ?? 0
    const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue)
    luma[pixel] = value
    chroma[pixel] = spread
    const paper = value >= 246 && spread <= 10
    if (paper) continue
    content += 1
    chromaSum += spread
    if (value < 210) {
      inkLuma += value
      inkCount += 1
    }
    const key = (Math.round(red / 24) << 10) | (Math.round(green / 24) << 5) | Math.round(blue / 24)
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }

  const meanChroma = content === 0 ? 0 : chromaSum / content
  const large = [...bins.values()].filter((amount) => amount / Math.max(1, count) > 0.012).length
  let distant = 0
  const centers: Array<{ red: number; green: number; blue: number; amount: number }> = []
  for (const [key, amount] of bins) {
    if (amount / Math.max(1, count) < 0.012) continue
    centers.push({
      red: ((key >> 10) & 31) * 24,
      green: ((key >> 5) & 31) * 24,
      blue: (key & 31) * 24,
      amount,
    })
  }
  for (const [key, amount] of bins) {
    const share = amount / Math.max(1, count)
    if (share < 0.0025 || share > 0.012) continue
    const red = ((key >> 10) & 31) * 24
    const green = ((key >> 5) & 31) * 24
    const blue = (key & 31) * 24
    const nearest = centers.reduce((best, center) => {
      const distance = Math.hypot(center.red - red, center.green - green, center.blue - blue)
      return Math.min(best, distance)
    }, Number.POSITIVE_INFINITY)
    if (nearest > 48) distant += 1
  }
  const palette = Math.max(2, Math.min(16, large + distant + (content > 0 ? 1 : 0)))
  const colorful = meanChroma > 18 || large >= 4

  return {
    content,
    palette,
    colorful,
    bands: lumaBands(luma, chroma),
    widthCv: widthVariation(luma, chroma, width, height),
    flatNoise: flatNoise(luma, width, height),
    softEdges: softEdgeShare(luma, width, height, content),
    lightSpread: lightSpread(luma, chroma, width, height),
    inkLuma: inkCount === 0 ? 0 : inkLuma / inkCount,
    speckShare: speckShare(luma, width, height),
  }
}

function lumaBands(luma: Float32Array, chroma: Float32Array): number {
  const hist = new Array<number>(16).fill(0)
  let total = 0
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    if ((chroma[pixel] ?? 0) > 16) continue
    if ((luma[pixel] ?? 255) >= 246) continue
    const bin = Math.min(15, Math.floor((luma[pixel] ?? 0) / 16))
    hist[bin] = (hist[bin] ?? 0) + 1
    total += 1
  }
  if (total === 0) return 0
  let bands = 0
  for (let bin = 0; bin < hist.length; bin += 1) {
    const amount = hist[bin] ?? 0
    if (amount / total < 0.025) continue
    const left = hist[bin - 1] ?? 0
    const right = hist[bin + 1] ?? 0
    if (amount >= left && amount >= right) bands += 1
  }
  return bands
}

function widthVariation(luma: Float32Array, chroma: Float32Array, width: number, height: number): number {
  const ink = new Uint8Array(luma.length)
  let inkCount = 0
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    const colored = (chroma[pixel] ?? 0) > 28 && (luma[pixel] ?? 255) < 235
    const dark = (luma[pixel] ?? 255) < 186
    if (dark || colored) {
      ink[pixel] = 1
      inkCount += 1
    }
  }
  if (inkCount < 30) return 0
  const distance = distanceToPaper(ink, width, height)
  const samples: number[] = []
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x
      const value = distance[pixel] ?? 0
      if (value < 1) continue
      let peak = true
      for (let dy = -1; dy <= 1 && peak; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          if ((distance[pixel + dy * width + dx] ?? 0) > value + 0.2) {
            peak = false
            break
          }
        }
      }
      if (peak) samples.push(value)
    }
  }
  if (samples.length < 8) return 0
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  if (mean <= 0.5) return 0
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
  return Math.sqrt(variance) / mean
}

function distanceToPaper(ink: Uint8Array, width: number, height: number): Float32Array {
  const distance = new Float32Array(ink.length)
  const far = width + height
  for (let pixel = 0; pixel < ink.length; pixel += 1) {
    distance[pixel] = ink[pixel] === 1 ? far : 0
  }
  const diagonal = 1.414
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      relax(distance, width, height, x, y, -1, 0, 1)
      relax(distance, width, height, x, y, 0, -1, 1)
      relax(distance, width, height, x, y, -1, -1, diagonal)
      relax(distance, width, height, x, y, 1, -1, diagonal)
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      relax(distance, width, height, x, y, 1, 0, 1)
      relax(distance, width, height, x, y, 0, 1, 1)
      relax(distance, width, height, x, y, 1, 1, diagonal)
      relax(distance, width, height, x, y, -1, 1, diagonal)
    }
  }
  return distance
}

function relax(
  distance: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  step: number,
): void {
  const nextX = x + dx
  const nextY = y + dy
  if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) return
  const pixel = y * width + x
  const neighbor = nextY * width + nextX
  const candidate = (distance[neighbor] ?? 0) + step
  if (candidate < (distance[pixel] ?? 0)) distance[pixel] = candidate
}

function flatNoise(luma: Float32Array, width: number, height: number): number {
  let total = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const pixel = y * width + x
      const center = luma[pixel] ?? 0
      let min = center
      let max = center
      let sum = 0
      let samples = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const value = luma[pixel + dy * width + dx] ?? center
          min = Math.min(min, value)
          max = Math.max(max, value)
          sum += value
          samples += 1
        }
      }
      if (max - min > 18) continue
      total += Math.abs(center - sum / samples)
      count += 1
    }
  }
  return count === 0 ? 0 : total / count
}

function softEdgeShare(luma: Float32Array, width: number, height: number, content: number): number {
  if (content < 20) return 0
  let soft = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value = luma[y * width + x] ?? 0
      if (value < 30 || value > 225) continue
      const jump = Math.abs(value - (luma[y * width + x + 1] ?? value))
      if (jump > 8 && jump < 70) soft += 1
    }
  }
  return soft / content
}

function lightSpread(luma: Float32Array, chroma: Float32Array, width: number, height: number): number {
  const buckets: number[][] = [[], [], [], []]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x
      const value = luma[pixel] ?? 0
      if (value < 40 || (chroma[pixel] ?? 0) > 18) continue
      const quad = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2)
      buckets[quad]?.push(value)
    }
  }
  const levels = buckets.flatMap((bucket) => {
    if (bucket.length < 12) return []
    const sorted = bucket.sort((left, right) => left - right)
    return [sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0]
  })
  if (levels.length < 3) return 0
  return Math.max(...levels) - Math.min(...levels)
}

function speckShare(luma: Float32Array, width: number, height: number): number {
  let specks = 0
  let ink = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value = luma[y * width + x] ?? 255
      if (value > 186) continue
      ink += 1
      let neighbors = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          if ((luma[(y + dy) * width + x + dx] ?? 255) < 186) neighbors += 1
        }
      }
      if (neighbors <= 1) specks += 1
    }
  }
  return ink === 0 ? 0 : specks / ink
}

function clampCount(value: number): number {
  return Math.max(2, Math.min(16, Math.round(value)))
}
