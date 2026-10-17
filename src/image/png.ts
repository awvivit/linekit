import { concatBytes, crc32, readAscii, readU32BE } from './bytes.ts'
import { BOMB_MESSAGE, DECODE_MESSAGE, ImageProcessError, isDecompressionBomb, type Raster } from './limits.ts'

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

type PngText = {
  keyword: string
  value: string
}

/**
 * Encode an 8-bit RGBA PNG. Optional text chunks are stored in the file and
 * must never be copied into the traced SVG.
 */
export async function encodePng(raster: Raster, extras?: { text?: PngText[]; orientation?: number }): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, raster.width)
  header.setUint32(4, raster.height)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanlines = new Uint8Array(raster.height * (1 + raster.width * 4))
  for (let y = 0; y < raster.height; y += 1) {
    const row = y * (1 + raster.width * 4)
    scanlines[row] = 0
    scanlines.set(raster.data.subarray(y * raster.width * 4, (y + 1) * raster.width * 4), row + 1)
  }
  const chunks = [chunk('IHDR', ihdr)]
  for (const text of extras?.text ?? []) {
    chunks.push(chunk('tEXt', textChunk(text.keyword, text.value)))
  }
  if (extras?.orientation && extras.orientation >= 2 && extras.orientation <= 8) {
    chunks.push(chunk('eXIf', tiffOrientation(extras.orientation)))
  }
  chunks.push(chunk('IDAT', await deflate(scanlines)), chunk('IEND', new Uint8Array()))
  return concatBytes([PNG_SIGNATURE, ...chunks])
}

export async function decodePng(bytes: Uint8Array): Promise<Raster> {
  if (bytes.byteLength < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Uint8Array[] = []
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32BE(bytes, offset)
    const type = readAscii(bytes, offset + 4, 4)
    const dataStart = offset + 8
    if (dataStart + length + 4 > bytes.byteLength) {
      throw new ImageProcessError('decode', DECODE_MESSAGE)
    }
    const data = bytes.subarray(dataStart, dataStart + length)
    const expected = crc32(bytes.subarray(offset + 4, dataStart + length))
    const actual = readU32BE(bytes, dataStart + length)
    if (expected !== actual) {
      throw new ImageProcessError('decode', DECODE_MESSAGE)
    }
    if (type === 'IHDR') {
      width = readU32BE(data, 0)
      height = readU32BE(data, 4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
      if (isDecompressionBomb(width, height)) {
        throw new ImageProcessError('bomb', BOMB_MESSAGE)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  if (width < 1 || height < 1 || bitDepth !== 8 || interlace !== 0) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  const channels = channelsFor(colorType)
  if (!channels) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  const inflated = await inflateLimited(concatBytes(idat), height * (1 + width * channels))
  return expandFilters(inflated, width, height, channels, colorType)
}

function channelsFor(colorType: number): number | null {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  return null
}

function expandFilters(
  inflated: Uint8Array,
  width: number,
  height: number,
  channels: number,
  colorType: number,
): Raster {
  const stride = width * channels
  const expected = height * (1 + stride)
  if (inflated.byteLength < expected) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  const raw = new Uint8Array(height * stride)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source] ?? 0
    source += 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[source] ?? 0
      source += 1
      const left = x >= channels ? (raw[row + x - channels] ?? 0) : 0
      const up = y > 0 ? (raw[row - stride + x] ?? 0) : 0
      const upLeft = y > 0 && x >= channels ? (raw[row - stride + x - channels] ?? 0) : 0
      let reconstructed = value
      if (filter === 1) reconstructed = value + left
      else if (filter === 2) reconstructed = value + up
      else if (filter === 3) reconstructed = value + Math.floor((left + up) / 2)
      else if (filter === 4) reconstructed = value + paeth(left, up, upLeft)
      else if (filter !== 0) throw new ImageProcessError('decode', DECODE_MESSAGE)
      raw[row + x] = reconstructed & 255
    }
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const from = pixel * channels
    const to = pixel * 4
    if (colorType === 0) {
      const gray = raw[from] ?? 0
      data[to] = gray
      data[to + 1] = gray
      data[to + 2] = gray
      data[to + 3] = 255
    } else if (colorType === 2) {
      data[to] = raw[from] ?? 0
      data[to + 1] = raw[from + 1] ?? 0
      data[to + 2] = raw[from + 2] ?? 0
      data[to + 3] = 255
    } else if (colorType === 4) {
      const gray = raw[from] ?? 0
      data[to] = gray
      data[to + 1] = gray
      data[to + 2] = gray
      data[to + 3] = raw[from + 1] ?? 255
    } else {
      data[to] = raw[from] ?? 0
      data[to + 1] = raw[from + 1] ?? 0
      data[to + 2] = raw[from + 2] ?? 0
      data[to + 3] = raw[from + 3] ?? 255
    }
  }
  return { width, height, data }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonal = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left
  if (upDistance <= diagonal) return up
  return upLeft
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function textChunk(keyword: string, value: string): Uint8Array {
  const key = new TextEncoder().encode(keyword)
  const text = new TextEncoder().encode(value)
  const out = new Uint8Array(key.length + 1 + text.length)
  out.set(key, 0)
  out[key.length] = 0
  out.set(text, key.length + 1)
  return out
}

function tiffOrientation(orientation: number): Uint8Array {
  const bytes = new Uint8Array(8 + 2 + 12 + 4)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x49
  bytes[1] = 0x49
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, 1, true)
  view.setUint16(10, 0x0112, true)
  view.setUint16(12, 3, true)
  view.setUint32(14, 1, true)
  view.setUint16(18, orientation, true)
  return bytes
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  // Pull the compressed bytes while writing. Chromium deadlocks if write() is
  // awaited first: the stream buffer fills and nothing is reading it yet.
  const compressed = new Response(stream.readable).arrayBuffer()
  await writer.write(copyBytes(data))
  await writer.close()
  return new Uint8Array(await compressed)
}

async function inflateLimited(data: Uint8Array, maxOut: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const finished = writer.write(copyBytes(data)).then(() => writer.close())
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxOut) {
      await reader.cancel()
      throw new ImageProcessError('bomb', BOMB_MESSAGE)
    }
    parts.push(value)
  }
  await finished
  return concatBytes(parts)
}
