import { CleanupTimeoutError, type BinaryImage } from './limits.ts'

/**
 * Euclidean distance transform.
 *
 * Felzenszwalb, P. F. and Huttenlocher, D. P. "Distance Transforms of Sampled
 * Functions." Theory of Computing 8(1), 2012.
 * Original implementation of the published separable algorithm.
 */
export function distanceToSeeds(
  width: number,
  height: number,
  isSeed: (index: number) => boolean,
): Float32Array {
  const columns = new Float64Array(width * height)
  const squared = new Float64Array(width * height)
  const infinite = 1e15
  for (let x = 0; x < width; x += 1) {
    const column = new Float64Array(height)
    for (let y = 0; y < height; y += 1) {
      column[y] = isSeed(y * width + x) ? 0 : infinite
    }
    const transformed = distanceTransform1d(column)
    for (let y = 0; y < height; y += 1) {
      columns[y * width + x] = transformed[y] ?? infinite
    }
  }
  const row = new Float64Array(width)
  for (let y = 0; y < height; y += 1) {
    const offset = y * width
    row.set(columns.subarray(offset, offset + width))
    const transformed = distanceTransform1d(row)
    squared.set(transformed, offset)
  }
  const distance = new Float32Array(width * height)
  for (let index = 0; index < squared.length; index += 1) {
    distance[index] = Math.sqrt(squared[index] ?? 0)
  }
  return distance
}

/**
 * Zhang–Suen thinning. Ink pixels (1) shrink to an 8-connected centerline.
 *
 * Zhang, T. Y. and Suen, C. Y. "A Fast Parallel Algorithm for Thinning Digital
 * Patterns." Communications of the ACM 27(3), 1984.
 * Original implementation of the published method.
 */
export function zhangSuenThin(image: BinaryImage, deadline = Number.POSITIVE_INFINITY): Uint8Array {
  const { width, height } = image
  const ink = image.ink.slice()
  const removable = new Uint8Array(ink.length)
  let active: number[] = []
  for (let index = 0; index < ink.length; index += 1) {
    if (ink[index] === 1) active.push(index)
  }
  const limit = Math.max(width, height)
  for (let iteration = 0; iteration < limit; iteration += 1) {
    if (Date.now() > deadline) throw new CleanupTimeoutError()
    let changed = false
    changed = markZhangSuen(ink, removable, active, width, height, true) || changed
    active = applyRemovals(ink, removable, active)
    changed = markZhangSuen(ink, removable, active, width, height, false) || changed
    active = applyRemovals(ink, removable, active)
    if (!changed) break
  }
  return ink
}

export function estimatePenWidth(image: BinaryImage): number {
  const distance = distanceToSeeds(image.width, image.height, (index) => image.ink[index] !== 1)
  const ridges: number[] = []
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x
      if (image.ink[index] !== 1) continue
      const value = distance[index] ?? 0
      if (value <= 0 || !isRidge(distance, image.ink, image.width, image.height, x, y, value)) continue
      ridges.push(value)
    }
  }
  if (ridges.length === 0) return 1
  ridges.sort((left, right) => left - right)
  const median = ridges[Math.floor(ridges.length / 2)] ?? 1
  return clamp(2 * median - 1, 1, Math.max(image.width, image.height))
}

/** Bridge ink gaps up to about one pen width, then restore stroke thickness. */
export function closeInk(image: BinaryImage, radius: number): BinaryImage {
  if (radius <= 0) return image
  const dilated = dilate(image, radius)
  const eroded = erode({ width: image.width, height: image.height, ink: dilated }, radius)
  return { width: image.width, height: image.height, ink: eroded }
}

function dilate(image: BinaryImage, radius: number): Uint8Array {
  const distance = distanceToSeeds(image.width, image.height, (index) => image.ink[index] === 1)
  const ink = new Uint8Array(image.ink.length)
  for (let index = 0; index < ink.length; index += 1) {
    if ((distance[index] ?? Infinity) <= radius) ink[index] = 1
  }
  return ink
}

function erode(image: BinaryImage, radius: number): Uint8Array {
  const distance = distanceToSeeds(image.width, image.height, (index) => image.ink[index] !== 1)
  const ink = new Uint8Array(image.ink.length)
  for (let index = 0; index < ink.length; index += 1) {
    if (image.ink[index] === 1 && (distance[index] ?? 0) > radius) ink[index] = 1
  }
  return ink
}

function isRidge(
  distance: Float32Array,
  ink: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: number,
): boolean {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
      const next = nextY * width + nextX
      if (ink[next] === 1 && (distance[next] ?? 0) > value + 0.05) return false
    }
  }
  return true
}

function markZhangSuen(
  ink: Uint8Array,
  removable: Uint8Array,
  active: number[],
  width: number,
  height: number,
  firstPass: boolean,
): boolean {
  let changed = false
  for (const index of active) {
    if (ink[index] !== 1) continue
    const x = index % width
    const y = (index - x) / width
    const neighbors = neighborhood(ink, width, height, x, y)
    const count = neighborCount(neighbors)
    if (count < 2 || count > 6) continue
    if (transitions(neighbors) !== 1) continue
    const p2 = neighbors[0] ?? 0
    const p4 = neighbors[2] ?? 0
    const p6 = neighbors[4] ?? 0
    const p8 = neighbors[6] ?? 0
    if (firstPass) {
      if (p2 * p4 * p6 !== 0) continue
      if (p4 * p6 * p8 !== 0) continue
    } else {
      if (p2 * p4 * p8 !== 0) continue
      if (p2 * p6 * p8 !== 0) continue
    }
    removable[index] = 1
    changed = true
  }
  return changed
}

function applyRemovals(ink: Uint8Array, removable: Uint8Array, active: number[]): number[] {
  const next: number[] = []
  for (const index of active) {
    if (removable[index] === 1) {
      ink[index] = 0
      removable[index] = 0
      continue
    }
    if (ink[index] === 1) next.push(index)
  }
  return next
}

/** Clockwise from the top: P2, P3, P4, P5, P6, P7, P8, P9. */
function neighborhood(ink: Uint8Array, width: number, height: number, x: number, y: number): number[] {
  const offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ]
  return offsets.map(([offsetX, offsetY]) => {
    const nextX = x + (offsetX ?? 0)
    const nextY = y + (offsetY ?? 0)
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) return 0
    return ink[nextY * width + nextX] === 1 ? 1 : 0
  })
}

function neighborCount(neighbors: number[]): number {
  let count = 0
  for (const neighbor of neighbors) count += neighbor
  return count
}

function transitions(neighbors: number[]): number {
  let count = 0
  for (let index = 0; index < neighbors.length; index += 1) {
    const current = neighbors[index] ?? 0
    const next = neighbors[(index + 1) % neighbors.length] ?? 0
    if (current === 0 && next === 1) count += 1
  }
  return count
}

function distanceTransform1d(values: Float64Array): Float64Array {
  const count = values.length
  const output = new Float64Array(count)
  if (count === 0) return output
  const sites = new Int32Array(count)
  const bounds = new Float64Array(count + 1)
  let envelope = 0
  sites[0] = 0
  bounds[0] = Number.NEGATIVE_INFINITY
  bounds[1] = Number.POSITIVE_INFINITY
  for (let index = 1; index < count; index += 1) {
    let intersection = parabolaIntersection(values, sites[envelope] ?? 0, index)
    while (envelope > 0 && intersection <= (bounds[envelope] ?? 0)) {
      envelope -= 1
      intersection = parabolaIntersection(values, sites[envelope] ?? 0, index)
    }
    envelope += 1
    sites[envelope] = index
    bounds[envelope] = intersection
    bounds[envelope + 1] = Number.POSITIVE_INFINITY
  }
  envelope = 0
  for (let index = 0; index < count; index += 1) {
    while ((bounds[envelope + 1] ?? Infinity) < index) envelope += 1
    const site = sites[envelope] ?? 0
    const delta = index - site
    output[index] = delta * delta + (values[site] ?? 0)
  }
  return output
}

function parabolaIntersection(values: Float64Array, left: number, right: number): number {
  const leftValue = (values[left] ?? 0) + left * left
  const rightValue = (values[right] ?? 0) + right * right
  const denominator = 2 * right - 2 * left
  if (denominator === 0) return Number.POSITIVE_INFINITY
  return (rightValue - leftValue) / denominator
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
