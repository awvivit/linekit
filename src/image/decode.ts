import type { SafeImage } from './inspect.ts'
import { DECODE_MESSAGE, HEIC_MESSAGE, ImageProcessError, type Raster } from './limits.ts'
import { decodePng } from './png.ts'

export type DecodedImage = {
  raster: Raster
  /** True when the decoder already applied EXIF orientation. */
  upright: boolean
}

export async function decodeImage(bytes: Uint8Array, image: SafeImage): Promise<DecodedImage> {
  if (canDecodeNatively()) {
    return decodeNative(bytes, image)
  }
  return decodeFallback(bytes, image)
}

function canDecodeNatively(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

async function decodeNative(bytes: Uint8Array, image: SafeImage): Promise<DecodedImage> {
  const blob = new Blob([copyBytes(bytes)], { type: mimeType(image.kind) })
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
  } catch (error) {
    if (image.kind === 'heic') {
      throw new ImageProcessError('heic', HEIC_MESSAGE)
    }
    throw error instanceof ImageProcessError ? error : new ImageProcessError('decode', DECODE_MESSAGE)
  }
  try {
    return { raster: rasterFromBitmap(bitmap), upright: true }
  } finally {
    bitmap.close()
  }
}

function rasterFromBitmap(bitmap: ImageBitmap): Raster {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  context.drawImage(bitmap, 0, 0)
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
  return { width: image.width, height: image.height, data: image.data }
}

async function decodeFallback(bytes: Uint8Array, image: SafeImage): Promise<DecodedImage> {
  if (image.kind === 'heic' || image.kind === 'webp' || image.kind === 'jpeg') {
    if (image.kind === 'heic') {
      throw new ImageProcessError('heic', HEIC_MESSAGE)
    }
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  return { raster: await decodePng(bytes), upright: false }
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function mimeType(kind: SafeImage['kind']): string {
  if (kind === 'png') return 'image/png'
  if (kind === 'jpeg') return 'image/jpeg'
  if (kind === 'webp') return 'image/webp'
  return 'image/heic'
}
