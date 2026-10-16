import { readAscii, readU16BE, readU16LE, readU32BE, readU32LE } from './bytes.ts'
import {
  BOMB_MESSAGE,
  EMPTY_MESSAGE,
  ImageProcessError,
  TOO_LARGE_MESSAGE,
  UNSUPPORTED_MESSAGE,
  exceedsByteCap,
  isDecompressionBomb,
  type ImageKind,
} from './limits.ts'

export type SafeImage = {
  ok: true
  kind: ImageKind
  width: number
  height: number
  orientation: number
}

export type RejectedImage = {
  ok: false
  code: 'empty' | 'too-large' | 'bomb' | 'unsupported' | 'truncated'
  message: string
}

export type ImageInspection = SafeImage | RejectedImage

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'heif',
  'mif1',
  'msf1',
])

const BOX_CONTAINERS = new Set([
  'meta',
  'iprp',
  'ipco',
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'dinf',
  'edts',
  'udta',
  'meco',
])

/**
 * Read the container header only. This does not decode pixels.
 * A file whose header claims a huge raster is refused here.
 */
export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty', message: EMPTY_MESSAGE }
  }
  if (exceedsByteCap(bytes.byteLength)) {
    return { ok: false, code: 'too-large', message: TOO_LARGE_MESSAGE }
  }

  try {
    const header = readHeader(bytes)
    if (isDecompressionBomb(header.width, header.height)) {
      return { ok: false, code: 'bomb', message: BOMB_MESSAGE }
    }
    return { ok: true, ...header }
  } catch (error) {
    if (
      error instanceof ImageProcessError &&
      (error.code === 'empty' ||
        error.code === 'too-large' ||
        error.code === 'bomb' ||
        error.code === 'unsupported' ||
        error.code === 'truncated')
    ) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'unsupported', message: UNSUPPORTED_MESSAGE }
  }
}

function readHeader(bytes: Uint8Array): Omit<SafeImage, 'ok'> {
  if (isPng(bytes)) {
    return readPng(bytes)
  }
  if (isJpeg(bytes)) {
    return readJpeg(bytes)
  }
  if (isWebp(bytes)) {
    return readWebp(bytes)
  }
  if (isHeic(bytes)) {
    return readHeic(bytes)
  }
  throw new ImageProcessError('unsupported', UNSUPPORTED_MESSAGE)
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8
}

function isWebp(bytes: Uint8Array): boolean {
  return readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP'
}

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12 || readAscii(bytes, 4, 4) !== 'ftyp') {
    return false
  }
  return heicBrands(bytes).length > 0
}

function readPng(bytes: Uint8Array): Omit<SafeImage, 'ok'> {
  if (bytes.byteLength < 24 || readAscii(bytes, 12, 4) !== 'IHDR') {
    throw new ImageProcessError('truncated', UNSUPPORTED_MESSAGE)
  }
  const width = readU32BE(bytes, 16)
  const height = readU32BE(bytes, 20)
  return { kind: 'png', width, height, orientation: readPngOrientation(bytes) }
}

function readPngOrientation(bytes: Uint8Array): number {
  let offset = 8
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32BE(bytes, offset)
    const type = readAscii(bytes, offset + 4, 4)
    const dataStart = offset + 8
    if (length > bytes.byteLength || dataStart + length + 4 > bytes.byteLength) {
      break
    }
    if (type === 'eXIf') {
      return readTiffOrientation(bytes, dataStart, dataStart + length) ?? 1
    }
    if (type === 'IDAT' || type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  return 1
}

function readJpeg(bytes: Uint8Array): Omit<SafeImage, 'ok'> {
  let offset = 2
  let width = 0
  let height = 0
  let orientation = 1
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      break
    }
    while (bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset] ?? 0
    offset += 1
    if (marker === 0xd9 || marker === 0xda) {
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue
    }
    if (offset + 2 > bytes.byteLength) {
      break
    }
    const length = readU16BE(bytes, offset)
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new ImageProcessError('truncated', UNSUPPORTED_MESSAGE)
    }
    if (isStartOfFrame(marker)) {
      height = readU16BE(bytes, offset + 3)
      width = readU16BE(bytes, offset + 5)
    } else if (marker === 0xe1) {
      const found = readJpegExif(bytes, offset + 2, offset + length)
      if (found) {
        orientation = found
      }
    }
    offset += length
  }
  if (width < 1 || height < 1) {
    throw new ImageProcessError('unsupported', UNSUPPORTED_MESSAGE)
  }
  return { kind: 'jpeg', width, height, orientation }
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function readJpegExif(bytes: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || readAscii(bytes, start, 4) !== 'Exif') {
    return null
  }
  return readTiffOrientation(bytes, start + 6, end)
}

function readWebp(bytes: Uint8Array): Omit<SafeImage, 'ok'> {
  let offset = 12
  let width = 0
  let height = 0
  let orientation = 1
  while (offset + 8 <= bytes.byteLength) {
    const type = readAscii(bytes, offset, 4)
    const size = readU32LE(bytes, offset + 4)
    const data = offset + 8
    if (size > bytes.byteLength || data + size > bytes.byteLength) {
      break
    }
    if (type === 'VP8X' && size >= 10) {
      width = 1 + ((bytes[data + 4] ?? 0) | ((bytes[data + 5] ?? 0) << 8) | ((bytes[data + 6] ?? 0) << 16))
      height = 1 + ((bytes[data + 7] ?? 0) | ((bytes[data + 8] ?? 0) << 8) | ((bytes[data + 9] ?? 0) << 16))
    } else if (type === 'VP8 ' && size >= 10 && width === 0) {
      const start = data + 3
      if (bytes[start] === 0x9d && bytes[start + 1] === 0x01 && bytes[start + 2] === 0x2a) {
        width = readU16LE(bytes, start + 3) & 0x3fff
        height = readU16LE(bytes, start + 5) & 0x3fff
      }
    } else if (type === 'VP8L' && size >= 5 && width === 0 && bytes[data] === 0x2f) {
      const bits = readU32LE(bytes, data + 1)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (type === 'EXIF') {
      orientation = readTiffOrientation(bytes, data, data + size) ?? orientation
    }
    const padded = size + (size % 2)
    offset = data + padded
  }
  if (width < 1 || height < 1) {
    throw new ImageProcessError('unsupported', UNSUPPORTED_MESSAGE)
  }
  return { kind: 'webp', width, height, orientation }
}

function readHeic(bytes: Uint8Array): Omit<SafeImage, 'ok'> {
  let width = 0
  let height = 0
  const visit = (start: number, end: number) => {
    let offset = start
    while (offset + 8 <= end) {
      const size32 = readU32BE(bytes, offset)
      const type = readAscii(bytes, offset + 4, 4)
      let header = 8
      let size = size32
      if (size32 === 1) {
        if (offset + 16 > end) {
          return
        }
        const high = readU32BE(bytes, offset + 8)
        const low = readU32BE(bytes, offset + 12)
        size = high * 2 ** 32 + low
        header = 16
      } else if (size32 === 0) {
        size = end - offset
      }
      if (!Number.isFinite(size) || size < header || offset + size > end) {
        return
      }
      const contentStart = offset + header
      const contentEnd = offset + size
      if (type === 'ispe' && contentEnd - contentStart >= 12) {
        const boxWidth = readU32BE(bytes, contentStart + 4)
        const boxHeight = readU32BE(bytes, contentStart + 8)
        if (boxWidth * boxHeight > width * height) {
          width = boxWidth
          height = boxHeight
        }
      } else if (BOX_CONTAINERS.has(type)) {
        const childStart = type === 'meta' ? contentStart + 4 : contentStart
        if (childStart < contentEnd) {
          visit(childStart, contentEnd)
        }
      }
      offset += size
    }
  }
  visit(0, bytes.byteLength)
  if (width < 1 || height < 1) {
    throw new ImageProcessError('unsupported', UNSUPPORTED_MESSAGE)
  }
  return { kind: 'heic', width, height, orientation: 1 }
}

function heicBrands(bytes: Uint8Array): string[] {
  const brandSize = readU32BE(bytes, 0)
  if (brandSize < 16 || brandSize > bytes.byteLength) {
    return []
  }
  const brands = [readAscii(bytes, 8, 4)]
  for (let offset = 16; offset + 4 <= brandSize; offset += 4) {
    brands.push(readAscii(bytes, offset, 4))
  }
  return brands.filter((brand) => HEIC_BRANDS.has(brand))
}

function readTiffOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  if (start < 0 || end > bytes.byteLength || end - start < 8) {
    return null
  }
  const order = readAscii(bytes, start, 2)
  const little = order === 'II'
  if (!little && order !== 'MM') {
    return null
  }
  const read16 = (offset: number) => (little ? readU16LE(bytes, offset) : readU16BE(bytes, offset))
  const read32 = (offset: number) => (little ? readU32LE(bytes, offset) : readU32BE(bytes, offset))
  if (start + 8 > end || read16(start + 2) !== 42) {
    return null
  }
  const ifd = start + read32(start + 4)
  if (ifd < start || ifd + 2 > end) {
    return null
  }
  const count = read16(ifd)
  let entry = ifd + 2
  for (let index = 0; index < count; index += 1) {
    if (entry + 12 > end) {
      return null
    }
    const tag = read16(entry)
    const type = read16(entry + 2)
    if (tag === 0x0112 && (type === 3 || type === 4)) {
      const orientation = type === 3 ? read16(entry + 8) : read32(entry + 8)
      if (orientation >= 1 && orientation <= 8) {
        return orientation
      }
    }
    entry += 12
  }
  return null
}
