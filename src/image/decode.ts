import type { SafeImage } from './inspect.ts'
import {
  BOMB_MESSAGE,
  DECODE_MESSAGE,
  HEIC_MESSAGE,
  ImageProcessError,
  MAX_PIXELS_UNSCALED,
  isDecompressionBomb,
  orientedDimensions,
  pixelCap,
  targetSize,
  type DecodeSizing,
  type Raster,
} from './limits.ts'
import { decodePng } from './png.ts'
import { downscaleRaster } from './raster.ts'

export type DecodedImage = {
  raster: Raster
  /** True when the decoder already applied EXIF orientation. */
  upright: boolean
}

export type DecodeEnvironment = DecodeSizing

export type BitmapLike = {
  width: number
  height: number
  close: () => void
}

export type BitmapCreator = (blob: Blob, options?: ImageBitmapOptions) => Promise<BitmapLike>

export type DecodeOptions = {
  environment?: DecodeEnvironment
  createImageBitmap?: BitmapCreator
  readBitmap?: (bitmap: BitmapLike) => Raster
}

const PROBE_WIDTH = 8
const PROBE_HEIGHT = 4
const PROBE_TARGET_WIDTH = 4
const PROBE_TARGET_HEIGHT = 2

const BASE_OPTIONS: ImageBitmapOptions = {
  imageOrientation: 'from-image',
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
}

export function isWebKitUserAgent(userAgent: string): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  if (/Chrome|Chromium|Edg\/|OPR\/|Android/.test(userAgent)) return false
  return /AppleWebKit/.test(userAgent)
}

export async function probeBitmapResize(create?: BitmapCreator, source?: Blob): Promise<boolean> {
  const createBitmap = create ?? nativeCreator()
  if (!createBitmap) return false
  const blob = source ?? (await probeSource())
  if (!blob) return false
  try {
    const bitmap = await createBitmap(blob, {
      resizeWidth: PROBE_TARGET_WIDTH,
      resizeHeight: PROBE_TARGET_HEIGHT,
      resizeQuality: 'high',
    })
    try {
      return bitmap.width === PROBE_TARGET_WIDTH && bitmap.height === PROBE_TARGET_HEIGHT
    } finally {
      bitmap.close()
    }
  } catch {
    return false
  }
}

let environmentPromise: Promise<DecodeEnvironment> | null = null

export function detectDecodeEnvironment(): Promise<DecodeEnvironment> {
  environmentPromise ??= detectUncached()
  return environmentPromise
}

export async function decodeImage(
  bytes: Uint8Array,
  image: SafeImage,
  options?: DecodeOptions,
): Promise<DecodedImage> {
  const environment = options?.environment ?? (await detectDecodeEnvironment())
  if (isDecompressionBomb(image.width, image.height, pixelCap(environment))) {
    throw new ImageProcessError('bomb', BOMB_MESSAGE)
  }
  if (options?.createImageBitmap || canDecodeNatively()) {
    return decodeNative(bytes, image, environment, options)
  }
  return decodeFallback(bytes, image)
}

async function detectUncached(): Promise<DecodeEnvironment> {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const webkit = isWebKitUserAgent(userAgent)
  const resizeWorks = canDecodeNatively() ? await probeBitmapResize() : false
  return { webkit, resizeWorks }
}

function canDecodeNatively(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

function nativeCreator(): BitmapCreator | null {
  if (typeof createImageBitmap !== 'function') return null
  return (blob, options) => createImageBitmap(blob, options)
}

async function probeSource(): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'function') return null
  const canvas = new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT)
  return canvas.convertToBlob({ type: 'image/png' })
}

async function decodeNative(
  bytes: Uint8Array,
  image: SafeImage,
  environment: DecodeEnvironment,
  options?: DecodeOptions,
): Promise<DecodedImage> {
  const blob = new Blob([copyBytes(bytes)], { type: mimeType(image.kind) })
  const create = options?.createImageBitmap ?? nativeCreator()
  if (!create) {
    return decodeFallback(bytes, image)
  }
  const read = options?.readBitmap ?? rasterFromBitmap
  const oriented = orientedDimensions(image.width, image.height, image.orientation)
  const target = targetSize(oriented.width, oriented.height)
  const request: ImageBitmapOptions = environment.resizeWorks
    ? {
        ...BASE_OPTIONS,
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
      }
    : BASE_OPTIONS

  let bitmap = await openBitmap(create, blob, request, image.kind)
  if (environment.resizeWorks && exceedsTarget(bitmap, target)) {
    const returnedPixels = bitmap.width * bitmap.height
    bitmap.close()
    if (image.width * image.height > MAX_PIXELS_UNSCALED || returnedPixels > MAX_PIXELS_UNSCALED) {
      throw new ImageProcessError('bomb', BOMB_MESSAGE)
    }
    bitmap = await openBitmap(create, blob, BASE_OPTIONS, image.kind)
  }

  try {
    return { raster: downscaleRaster(read(bitmap)), upright: true }
  } finally {
    bitmap.close()
  }
}

async function openBitmap(
  create: BitmapCreator,
  blob: Blob,
  options: ImageBitmapOptions,
  kind: SafeImage['kind'],
): Promise<BitmapLike> {
  try {
    return await create(blob, options)
  } catch (error) {
    if (kind === 'heic') throw new ImageProcessError('heic', HEIC_MESSAGE)
    throw error instanceof ImageProcessError ? error : new ImageProcessError('decode', DECODE_MESSAGE)
  }
}

function exceedsTarget(bitmap: BitmapLike, target: { width: number; height: number }): boolean {
  return bitmap.width > target.width || bitmap.height > target.height
}

function rasterFromBitmap(bitmap: BitmapLike): Raster {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }
  context.drawImage(bitmap as CanvasImageSource, 0, 0)
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
