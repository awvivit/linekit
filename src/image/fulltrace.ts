import { applyTraceFilters } from './filters.ts'
import type { Raster } from './limits.ts'
import { downscaleRaster } from './raster.ts'
import { vectorizePalette } from './vectorize.ts'

export type FullTraceOptions = {
  smoothNoise: number
  edgeDetail: number
  evenLighting: boolean
  colorCount: number
  smoothing: number
}

const FULL_EDGE = 960
const INTERIOR_WHITE = { r: 250, g: 250, b: 250 }

type Rgb = { r: number; g: number; b: number }
type Lab = { l: number; a: number; b: number }

/**
 * Filled regions, not centerlines.
 * Filters run only when their controls ask for them.
 * Quantizing, halo removal, and speckle cleanup run because flat colors need them.
 */
export function fullTrace(raster: Raster, options: FullTraceOptions): string {
  const prepared = quantizeDrawing(raster, options)
  return vectorizePalette(prepared.raster, options.smoothing, prepared.palette)
}

export function quantizeDrawing(
  raster: Raster,
  options: Omit<FullTraceOptions, 'smoothing'>,
): { raster: Raster; palette: Rgb[] } {
  const sized = Math.max(raster.width, raster.height) > FULL_EDGE ? downscaleRaster(raster, FULL_EDGE) : raster
  const filtered = applyTraceFilters(sized, options)
  const snapped = snapWhitePoint(filtered)
  const count = clampCount(options.colorCount)
  let indexed = clusterLab(snapped, count)
  indexed = mergeCloseColors(indexed, 11)
  removeHaloLabels(indexed)
  majoritySpecks(indexed)
  mergeSmallRegions(indexed, Math.max(6, Math.round(indexed.width * indexed.height * 0.00008)))
  separateInteriorWhite(indexed)
  return { raster: paintIndexed(indexed), palette: indexed.palette }
}

type Indexed = {
  width: number
  height: number
  labels: Int16Array
  palette: Rgb[]
  /** Original pixel color, used to judge blends and halos. */
  source: Uint8ClampedArray
}

function snapWhitePoint(raster: Raster): Raster {
  const data = raster.data.slice()
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0
    const green = data[index + 1] ?? 0
    const blue = data[index + 2] ?? 0
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue)
    if (luma >= 248 && spread <= 8) {
      data[index] = 255
      data[index + 1] = 255
      data[index + 2] = 255
    }
    data[index + 3] = 255
  }
  return { width: raster.width, height: raster.height, data }
}

function clusterLab(raster: Raster, colorCount: number): Indexed {
  const count = raster.width * raster.height
  const labs = new Float32Array(count * 3)
  for (let pixel = 0; pixel < count; pixel += 1) {
    const lab = rgbToLab(raster.data[pixel * 4] ?? 0, raster.data[pixel * 4 + 1] ?? 0, raster.data[pixel * 4 + 2] ?? 0)
    labs[pixel * 3] = lab.l
    labs[pixel * 3 + 1] = lab.a
    labs[pixel * 3 + 2] = lab.b
  }
  const seeds = seedColors(raster, labs, colorCount)
  const labels = new Int16Array(count)
  const centers = seeds.map((seed) => ({ ...seed }))
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const acc = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }))
    for (let pixel = 0; pixel < count; pixel += 1) {
      const lab = labAt(labs, pixel)
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < centers.length; index += 1) {
        const center = centers[index]
        if (!center) continue
        const distance = labDistance(lab, center)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      }
      labels[pixel] = best
      const bucket = acc[best]
      if (!bucket) continue
      bucket.l += lab.l
      bucket.a += lab.a
      bucket.b += lab.b
      bucket.n += 1
    }
    for (let index = 0; index < centers.length; index += 1) {
      const bucket = acc[index]
      const center = centers[index]
      if (!bucket || !center || bucket.n === 0) continue
      center.l = bucket.l / bucket.n
      center.a = bucket.a / bucket.n
      center.b = bucket.b / bucket.n
    }
  }
  return {
    width: raster.width,
    height: raster.height,
    labels,
    palette: centers.map(labToRgb),
    source: raster.data.slice(),
  }
}

function seedColors(raster: Raster, labs: Float32Array, colorCount: number): Lab[] {
  const bins = new Map<number, { n: number; l: number; a: number; b: number }>()
  const stride = raster.width * raster.height > 120_000 ? 2 : 1
  for (let pixel = 0; pixel < raster.width * raster.height; pixel += stride) {
    const lab = labAt(labs, pixel)
    const key =
      (Math.round(lab.l / 8) << 16) | ((Math.round(lab.a / 8) + 16) << 8) | (Math.round(lab.b / 8) + 16)
    const bin = bins.get(key)
    if (bin) {
      bin.n += 1
      bin.l += lab.l
      bin.a += lab.a
      bin.b += lab.b
    } else {
      bins.set(key, { n: 1, l: lab.l, a: lab.a, b: lab.b })
    }
  }
  const ranked = [...bins.values()].sort((left, right) => right.n - left.n)
  const chosen: Lab[] = []
  for (const bin of ranked) {
    if (chosen.length >= colorCount) break
    const lab = { l: bin.l / bin.n, a: bin.a / bin.n, b: bin.b / bin.n }
    if (chosen.every((seed) => labDistance(seed, lab) > 12)) chosen.push(lab)
  }
  let guard = 0
  while (chosen.length < colorCount && guard < colorCount * 3) {
    guard += 1
    const pixel = Math.min(raster.width * raster.height - 1, Math.floor(((guard * 97) % 1000) / 1000 * raster.width * raster.height))
    const lab = labAt(labs, pixel)
    if (chosen.every((seed) => labDistance(seed, lab) > 8)) chosen.push(lab)
  }
  if (chosen.length === 0) chosen.push({ l: 100, a: 0, b: 0 }, { l: 0, a: 0, b: 0 })
  return chosen.slice(0, colorCount)
}

function mergeCloseColors(indexed: Indexed, limit: number): Indexed {
  const parent = indexed.palette.map((_color, index) => index)
  const find = (index: number): number => {
    let current = index
    while (parent[current] !== current) {
      current = parent[current] ?? current
    }
    return current
  }
  for (let left = 0; left < indexed.palette.length; left += 1) {
    for (let right = left + 1; right < indexed.palette.length; right += 1) {
      const a = indexed.palette[left]
      const b = indexed.palette[right]
      if (!a || !b) continue
      if (labDistance(rgbToLab(a.r, a.g, a.b), rgbToLab(b.r, b.g, b.b)) <= limit) {
        parent[find(right)] = find(left)
      }
    }
  }
  const map = new Map<number, number>()
  const palette: Rgb[] = []
  for (let index = 0; index < indexed.palette.length; index += 1) {
    const root = find(index)
    const existing = map.get(root)
    if (existing === undefined) {
      map.set(root, palette.length)
      const color = indexed.palette[root] ?? indexed.palette[index]
      if (color) palette.push({ ...color })
    }
  }
  if (palette.length === indexed.palette.length) return indexed
  const labels = Int16Array.from(indexed.labels, (label) => map.get(find(label)) ?? 0)
  return { ...indexed, labels, palette }
}

function removeHaloLabels(indexed: Indexed): void {
  const stats = labelStats(indexed)
  for (let label = 0; label < indexed.palette.length; label += 1) {
    const stat = stats[label]
    if (!stat || stat.area < 4 || stat.maxDistance > 1.05) continue
    const neighbors = borderLabels(indexed, label)
    const thick = [...neighbors.keys()].filter((neighbor) => (stats[neighbor]?.maxDistance ?? 0) > 1.4)
    if (thick.length < 2) continue
    const color = indexed.palette[label]
    const first = indexed.palette[thick[0] ?? 0]
    const second = indexed.palette[thick[1] ?? 0]
    if (!color || !first || !second) continue
    const mid = {
      r: (first.r + second.r) / 2,
      g: (first.g + second.g) / 2,
      b: (first.b + second.b) / 2,
    }
    const toMid = rgbDistance(color, mid)
    const toFirst = rgbDistance(color, first)
    const toSecond = rgbDistance(color, second)
    if (toMid > 36 || toMid > Math.min(toFirst, toSecond)) continue
    for (let pixel = 0; pixel < indexed.labels.length; pixel += 1) {
      if (indexed.labels[pixel] !== label) continue
      const source = {
        r: indexed.source[pixel * 4] ?? 0,
        g: indexed.source[pixel * 4 + 1] ?? 0,
        b: indexed.source[pixel * 4 + 2] ?? 0,
      }
      indexed.labels[pixel] = rgbDistance(source, first) <= rgbDistance(source, second) ? (thick[0] ?? 0) : (thick[1] ?? 0)
    }
  }
}

function majoritySpecks(indexed: Indexed): void {
  const { width, height, labels } = indexed
  const next = labels.slice()
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x
      const counts = new Map<number, number>()
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const label = labels[pixel + dy * width + dx] ?? 0
          counts.set(label, (counts.get(label) ?? 0) + 1)
        }
      }
      let best = labels[pixel] ?? 0
      let bestCount = 0
      for (const [label, count] of counts) {
        if (count > bestCount) {
          best = label
          bestCount = count
        }
      }
      if (bestCount >= 6 && best !== labels[pixel]) next[pixel] = best
    }
  }
  labels.set(next)
}

function mergeSmallRegions(indexed: Indexed, minArea: number): void {
  const { width, height, labels } = indexed
  const seen = new Uint8Array(labels.length)
  const stack = new Int32Array(labels.length)
  for (let start = 0; start < labels.length; start += 1) {
    if (seen[start] === 1) continue
    let stackSize = 0
    stack[stackSize] = start
    stackSize += 1
    seen[start] = 1
    const label = labels[start] ?? 0
    const members: number[] = []
    const borders = new Map<number, number>()
    while (stackSize > 0) {
      stackSize -= 1
      const pixel = stack[stackSize] ?? 0
      members.push(pixel)
      const x = pixel % width
      const y = (pixel - x) / width
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]
      for (const point of neighbors) {
        const nextX = point[0] ?? -1
        const nextY = point[1] ?? -1
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        const nextLabel = labels[next] ?? 0
        if (nextLabel !== label) {
          borders.set(nextLabel, (borders.get(nextLabel) ?? 0) + 1)
          continue
        }
        if (seen[next] === 1) continue
        seen[next] = 1
        stack[stackSize] = next
        stackSize += 1
      }
    }
    if (members.length >= minArea) continue
    let best = -1
    let bestCount = -1
    for (const [border, count] of borders) {
      if (count > bestCount) {
        best = border
        bestCount = count
      }
    }
    if (best < 0) continue
    for (const pixel of members) labels[pixel] = best
  }
}

function separateInteriorWhite(indexed: Indexed): void {
  let paper = 0
  let paperScore = -1
  for (let label = 0; label < indexed.palette.length; label += 1) {
    const color = indexed.palette[label]
    if (!color || color.r < 248 || color.g < 248 || color.b < 248) continue
    let score = 0
    for (let x = 0; x < indexed.width; x += 1) {
      if (indexed.labels[x] === label) score += 1
      if (indexed.labels[(indexed.height - 1) * indexed.width + x] === label) score += 1
    }
    for (let y = 0; y < indexed.height; y += 1) {
      if (indexed.labels[y * indexed.width] === label) score += 1
      if (indexed.labels[y * indexed.width + indexed.width - 1] === label) score += 1
    }
    if (score > paperScore) {
      paperScore = score
      paper = label
    }
  }
  if (paperScore <= 0) return
  const { width, height, labels } = indexed
  const seen = new Uint8Array(labels.length)
  const stack = new Int32Array(labels.length)
  const interior = indexed.palette.length
  let found = false
  for (let start = 0; start < labels.length; start += 1) {
    if (seen[start] === 1 || labels[start] !== paper) continue
    let stackSize = 0
    stack[stackSize] = start
    stackSize += 1
    seen[start] = 1
    const members: number[] = []
    let touches = false
    while (stackSize > 0) {
      stackSize -= 1
      const pixel = stack[stackSize] ?? 0
      members.push(pixel)
      const x = pixel % width
      const y = (pixel - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]
      for (const point of neighbors) {
        const nextX = point[0] ?? -1
        const nextY = point[1] ?? -1
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (seen[next] === 1 || labels[next] !== paper) continue
        seen[next] = 1
        stack[stackSize] = next
        stackSize += 1
      }
    }
    if (touches || members.length < 8) continue
    found = true
    for (const pixel of members) labels[pixel] = interior
  }
  if (found) indexed.palette.push({ ...INTERIOR_WHITE })
}

function paintIndexed(indexed: Indexed): Raster {
  const data = new Uint8ClampedArray(indexed.width * indexed.height * 4)
  for (let pixel = 0; pixel < indexed.labels.length; pixel += 1) {
    const color = indexed.palette[indexed.labels[pixel] ?? 0] ?? { r: 255, g: 255, b: 255 }
    data[pixel * 4] = color.r
    data[pixel * 4 + 1] = color.g
    data[pixel * 4 + 2] = color.b
    data[pixel * 4 + 3] = 255
  }
  return { width: indexed.width, height: indexed.height, data }
}

function labelStats(indexed: Indexed): Array<{ area: number; maxDistance: number } | undefined> {
  const stats: Array<{ area: number; maxDistance: number } | undefined> = indexed.palette.map(() => ({
    area: 0,
    maxDistance: 0,
  }))
  const mask = new Uint8Array(indexed.labels.length)
  for (let label = 0; label < indexed.palette.length; label += 1) {
    mask.fill(0)
    let area = 0
    for (let pixel = 0; pixel < indexed.labels.length; pixel += 1) {
      if (indexed.labels[pixel] === label) {
        mask[pixel] = 1
        area += 1
      }
    }
    const stat = stats[label]
    if (!stat) continue
    stat.area = area
    if (area === 0) continue
    const distance = chamfer(mask, indexed.width, indexed.height)
    let maxDistance = 0
    for (let pixel = 0; pixel < distance.length; pixel += 1) {
      if ((distance[pixel] ?? 0) > maxDistance) maxDistance = distance[pixel] ?? 0
    }
    stat.maxDistance = maxDistance
  }
  return stats
}

function borderLabels(indexed: Indexed, label: number): Map<number, number> {
  const borders = new Map<number, number>()
  const { width, height, labels } = indexed
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x
      if (labels[pixel] !== label) continue
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]
      for (const point of neighbors) {
        const nextX = point[0] ?? -1
        const nextY = point[1] ?? -1
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const nextLabel = labels[nextY * width + nextX] ?? 0
        if (nextLabel === label) continue
        borders.set(nextLabel, (borders.get(nextLabel) ?? 0) + 1)
      }
    }
  }
  return borders
}

function chamfer(mask: Uint8Array, width: number, height: number): Float32Array {
  const distance = new Float32Array(mask.length)
  const far = width + height
  for (let pixel = 0; pixel < mask.length; pixel += 1) distance[pixel] = mask[pixel] === 1 ? far : 0
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
  const candidate = (distance[nextY * width + nextX] ?? 0) + step
  if (candidate < (distance[pixel] ?? 0)) distance[pixel] = candidate
}

function labAt(labs: Float32Array, pixel: number): Lab {
  return { l: labs[pixel * 3] ?? 0, a: labs[pixel * 3 + 1] ?? 0, b: labs[pixel * 3 + 2] ?? 0 }
}

function labDistance(left: Lab, right: Lab): number {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b)
}

function rgbDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b)
}

function rgbToLab(red: number, green: number, blue: number): Lab {
  const r = srgbToLinear(red)
  const g = srgbToLinear(green)
  const b = srgbToLinear(blue)
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505
  const fx = labPivot(x / 0.95047)
  const fy = labPivot(y)
  const fz = labPivot(z / 1.08883)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function labToRgb(lab: Lab): Rgb {
  const fy = (lab.l + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200
  const x = labPivotInverse(fx) * 0.95047
  const y = labPivotInverse(fy)
  const z = labPivotInverse(fz) * 1.08883
  const red = x * 3.2406 + y * -1.5372 + z * -0.4986
  const green = x * -0.9689 + y * 1.8758 + z * 0.0415
  const blue = x * 0.0557 + y * -0.204 + z * 1.057
  return { r: linearToSrgb(red), g: linearToSrgb(green), b: linearToSrgb(blue) }
}

function srgbToLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number): number {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(value * 255)))
}

function labPivot(value: number): number {
  const delta = 6 / 29
  return value > delta ** 3 ? Math.cbrt(value) : value / (3 * delta * delta) + 4 / 29
}

function labPivotInverse(value: number): number {
  const delta = 6 / 29
  return value > delta ? value ** 3 : 3 * delta * delta * (value - 4 / 29)
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.max(2, Math.min(16, Math.round(value)))
}
