import {
  FULL_CROP,
  MAX_EDGE,
  type BinaryImage,
  type NormalizedCrop,
  type Raster,
  targetSize,
} from './limits.ts'

export function applyOrientation(raster: Raster, orientation: number): Raster {
  switch (orientation) {
    case 2:
      return flipHorizontal(raster)
    case 3:
      return rotate180(raster)
    case 4:
      return flipVertical(raster)
    case 5:
      return transpose(raster)
    case 6:
      return rotate90CW(raster)
    case 7:
      return transverse(raster)
    case 8:
      return rotate90CCW(raster)
    default:
      return raster
  }
}

export function downscaleRaster(raster: Raster, maxEdge = MAX_EDGE): Raster {
  const size = targetSize(raster.width, raster.height, maxEdge)
  if (size.width === raster.width && size.height === raster.height) {
    return raster
  }

  const output = new Uint8ClampedArray(size.width * size.height * 4)
  const xScale = raster.width / size.width
  const yScale = raster.height / size.height
  for (let y = 0; y < size.height; y += 1) {
    const yStart = Math.floor(y * yScale)
    const yEnd = Math.min(raster.height, Math.max(yStart + 1, Math.ceil((y + 1) * yScale)))
    for (let x = 0; x < size.width; x += 1) {
      const xStart = Math.floor(x * xScale)
      const xEnd = Math.min(raster.width, Math.max(xStart + 1, Math.ceil((x + 1) * xScale)))
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let count = 0
      for (let sampleY = yStart; sampleY < yEnd; sampleY += 1) {
        const row = sampleY * raster.width
        for (let sampleX = xStart; sampleX < xEnd; sampleX += 1) {
          const index = (row + sampleX) * 4
          red += raster.data[index] ?? 0
          green += raster.data[index + 1] ?? 0
          blue += raster.data[index + 2] ?? 0
          alpha += raster.data[index + 3] ?? 0
          count += 1
        }
      }
      const destination = (y * size.width + x) * 4
      output[destination] = red / count
      output[destination + 1] = green / count
      output[destination + 2] = blue / count
      output[destination + 3] = alpha / count
    }
  }
  return { width: size.width, height: size.height, data: output }
}

export function cropNormalized(raster: Raster, crop: NormalizedCrop): Raster {
  const safe = normalizeCrop(crop)
  const x = clamp(Math.floor(safe.x * raster.width), 0, Math.max(0, raster.width - 1))
  const y = clamp(Math.floor(safe.y * raster.height), 0, Math.max(0, raster.height - 1))
  const right = clamp(Math.ceil((safe.x + safe.width) * raster.width), x + 1, raster.width)
  const bottom = clamp(Math.ceil((safe.y + safe.height) * raster.height), y + 1, raster.height)
  const width = right - x
  const height = bottom - y
  if (x === 0 && y === 0 && width === raster.width && height === raster.height) {
    return raster
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const source = ((y + row) * raster.width + x) * 4
    data.set(raster.data.subarray(source, source + width * 4), row * width * 4)
  }
  return { width, height, data }
}

export function cleanDrawing(raster: Raster, darkness: number, specks: number): BinaryImage {
  const gray = grayscale(raster)
  const flattened = removeShadows(gray, raster.width, raster.height)
  const ink = adaptiveThreshold(flattened, raster.width, raster.height, clamp(Math.round(darkness), 0, 100))
  return despeckle(ink, speckMinArea(specks, raster.width, raster.height))
}

export function grayscale(raster: Raster): Float32Array {
  const gray = new Float32Array(raster.width * raster.height)
  for (let pixel = 0, index = 0; pixel < gray.length; pixel += 1, index += 4) {
    const alpha = (raster.data[index + 3] ?? 255) / 255
    const red = (raster.data[index] ?? 0) * alpha + 255 * (1 - alpha)
    const green = (raster.data[index + 1] ?? 0) * alpha + 255 * (1 - alpha)
    const blue = (raster.data[index + 2] ?? 0) * alpha + 255 * (1 - alpha)
    gray[pixel] = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  return gray
}

export function removeShadows(gray: Float32Array, width: number, height: number): Float32Array {
  const radius = Math.max(8, Math.round(Math.max(width, height) / 14))
  const background = boxBlur(gray, width, height, radius)
  const output = new Float32Array(gray.length)
  for (let index = 0; index < gray.length; index += 1) {
    const base = Math.max(background[index] ?? 1, 8)
    output[index] = clamp(((gray[index] ?? 0) / base) * 255, 0, 255)
  }
  return output
}

export function adaptiveThreshold(
  gray: Float32Array,
  width: number,
  height: number,
  darkness: number,
): BinaryImage {
  const radius = Math.max(3, Math.round(Math.min(width, height) / 24))
  const localMean = boxBlur(gray, width, height, radius)
  const factor = 0.48 + (darkness / 100) * 0.5
  const ink = new Uint8Array(gray.length)
  for (let index = 0; index < gray.length; index += 1) {
    const mean = localMean[index] ?? 255
    ink[index] = (gray[index] ?? 255) < mean * factor ? 1 : 0
  }
  return { width, height, ink }
}

export function despeckle(image: BinaryImage, minArea: number): BinaryImage {
  if (minArea <= 1) {
    return image
  }
  const { width, height, ink } = image
  const seen = new Uint8Array(ink.length)
  const output = ink.slice()
  const stack = new Int32Array(ink.length)
  for (let start = 0; start < ink.length; start += 1) {
    if (seen[start] === 1 || ink[start] !== 1) {
      continue
    }
    let stackSize = 0
    stack[stackSize] = start
    stackSize += 1
    seen[start] = 1
    const members: number[] = []
    let keep = false
    while (stackSize > 0) {
      stackSize -= 1
      const pixel = stack[stackSize] ?? 0
      if (!keep) {
        members.push(pixel)
        if (members.length >= minArea) {
          keep = true
          members.length = 0
        }
      }
      const x = pixel % width
      const y = (pixel - x) / width
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue
          }
          const nextX = x + offsetX
          const nextY = y + offsetY
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue
          }
          const next = nextY * width + nextX
          if (seen[next] === 1 || ink[next] !== 1) {
            continue
          }
          seen[next] = 1
          stack[stackSize] = next
          stackSize += 1
        }
      }
    }
    if (!keep) {
      for (const pixel of members) {
        output[pixel] = 0
      }
    }
  }
  return { width, height, ink: output }
}

export function speckMinArea(specks: number, width: number, height: number): number {
  const amount = clamp(specks, 0, 100)
  if (amount <= 0) {
    return 0
  }
  const cap = Math.max(2, Math.round(Math.min(width, height) * 0.4))
  return Math.max(2, Math.round((amount / 100) * cap))
}

export function normalizeCrop(crop: NormalizedCrop): NormalizedCrop {
  if (![crop.x, crop.y, crop.width, crop.height].every((value) => Number.isFinite(value))) {
    return FULL_CROP
  }
  const x = clamp(crop.x, 0, 1)
  const y = clamp(crop.y, 0, 1)
  const width = clamp(crop.width, 0, 1 - x)
  const height = clamp(crop.height, 0, 1 - y)
  if (width < 0.01 || height < 0.01) {
    return FULL_CROP
  }
  return { x, y, width, height }
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = new Float32Array(source.length)
  const vertical = new Float32Array(source.length)
  const windowSize = radius * 2 + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[row + clamp(x, 0, width - 1)] ?? 0
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / windowSize
      sum -= source[row + clamp(x - radius, 0, width - 1)] ?? 0
      sum += source[row + clamp(x + radius + 1, 0, width - 1)] ?? 0
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[clamp(y, 0, height - 1) * width + x] ?? 0
    }
    for (let y = 0; y < height; y += 1) {
      vertical[y * width + x] = sum / windowSize
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x] ?? 0
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] ?? 0
    }
  }
  return vertical
}

function transpose(raster: Raster): Raster {
  const width = raster.height
  const height = raster.width
  const data = new Uint8ClampedArray(dataLength(width, height))
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      copyPixel(raster, x, y, data, x * width + y)
    }
  }
  return { width, height, data }
}

function transverse(raster: Raster): Raster {
  const width = raster.height
  const height = raster.width
  const data = new Uint8ClampedArray(dataLength(width, height))
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const destinationX = raster.height - 1 - y
      const destinationY = raster.width - 1 - x
      copyPixel(raster, x, y, data, destinationY * width + destinationX)
    }
  }
  return { width, height, data }
}

function rotate90CW(raster: Raster): Raster {
  const width = raster.height
  const height = raster.width
  const data = new Uint8ClampedArray(dataLength(width, height))
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const destinationX = raster.height - 1 - y
      const destinationY = x
      copyPixel(raster, x, y, data, destinationY * width + destinationX)
    }
  }
  return { width, height, data }
}

function rotate90CCW(raster: Raster): Raster {
  const width = raster.height
  const height = raster.width
  const data = new Uint8ClampedArray(dataLength(width, height))
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const destinationX = y
      const destinationY = raster.width - 1 - x
      copyPixel(raster, x, y, data, destinationY * width + destinationX)
    }
  }
  return { width, height, data }
}

function rotate180(raster: Raster): Raster {
  const data = new Uint8ClampedArray(raster.data.length)
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const destination = (raster.height - 1 - y) * raster.width + (raster.width - 1 - x)
      copyPixel(raster, x, y, data, destination)
    }
  }
  return { width: raster.width, height: raster.height, data }
}

function flipHorizontal(raster: Raster): Raster {
  const data = new Uint8ClampedArray(raster.data.length)
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      copyPixel(raster, x, y, data, y * raster.width + (raster.width - 1 - x))
    }
  }
  return { width: raster.width, height: raster.height, data }
}

function flipVertical(raster: Raster): Raster {
  const data = new Uint8ClampedArray(raster.data.length)
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      copyPixel(raster, x, y, data, (raster.height - 1 - y) * raster.width + x)
    }
  }
  return { width: raster.width, height: raster.height, data }
}

function copyPixel(source: Raster, x: number, y: number, target: Uint8ClampedArray, pixel: number): void {
  const from = (y * source.width + x) * 4
  const to = pixel * 4
  target[to] = source.data[from] ?? 0
  target[to + 1] = source.data[from + 1] ?? 0
  target[to + 2] = source.data[from + 2] ?? 0
  target[to + 3] = source.data[from + 3] ?? 255
}

function dataLength(width: number, height: number): number {
  return width * height * 4
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
