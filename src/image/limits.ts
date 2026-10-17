/** Longest side of the raster that is traced, in pixels. */
export const MAX_EDGE = 4000

/** Longest side of the original photo shown beside the trace, in pixels. */
export const PREVIEW_EDGE = 2000

/** Reject files larger than this before they are decoded. */
export const MAX_BYTES = 32 * 1024 * 1024

/**
 * Header limits. A side longer than MAX_DIMENSION is always rejected.
 * MAX_PIXELS applies when createImageBitmap resizes during decode.
 * MAX_PIXELS_UNSCALED applies when the full bitmap may be allocated:
 * resize is missing, resize is ignored, or the browser is WebKit.
 * 4032×3024 (about 12.2 megapixels) stays under both pixel caps.
 */
export const MAX_DIMENSION = 16_384
export const MAX_PIXELS = 40_000_000
export const MAX_PIXELS_UNSCALED = 24_000_000

export type DecodeSizing = {
  webkit: boolean
  resizeWorks: boolean
}

export const HEIC_MESSAGE =
  "This browser can't open HEIC photos. Save as JPEG and try again."

export const BOMB_MESSAGE = 'This image is too large to open safely.'

export const TOO_LARGE_MESSAGE = 'This file is too large. Choose a photo under 32 MB.'

export const UNSUPPORTED_MESSAGE = 'Use a PNG, JPEG, WebP, or HEIC photo.'

export const EMPTY_MESSAGE = 'This file is empty.'

export const DECODE_MESSAGE = "Couldn't open this photo. Try a JPEG or PNG."

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'heic'

export type NormalizedCrop = {
  x: number
  y: number
  width: number
  height: number
}

export const FULL_CROP: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 }

export type TraceControls = {
  darkness: number
  smoothing: number
  specks: number
  crop: NormalizedCrop
  /** Stroked centerlines. False keeps the filled outline trace. */
  cleanup: boolean
}

export const DEFAULT_CONTROLS: TraceControls = {
  darkness: 62,
  smoothing: 28,
  specks: 35,
  crop: FULL_CROP,
  cleanup: true,
}

export type Raster = {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type BinaryImage = {
  width: number
  height: number
  /** 1 is ink, 0 is paper. */
  ink: Uint8Array
}

export class ImageProcessError extends Error {
  readonly code: 'empty' | 'too-large' | 'bomb' | 'unsupported' | 'truncated' | 'heic' | 'decode'

  constructor(
    code: 'empty' | 'too-large' | 'bomb' | 'unsupported' | 'truncated' | 'heic' | 'decode',
    message: string,
  ) {
    super(message)
    this.name = 'ImageProcessError'
    this.code = code
  }
}

export function targetSize(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) {
    return { width, height }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function exceedsByteCap(byteLength: number): boolean {
  return byteLength > MAX_BYTES
}

export function orientedDimensions(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  if (orientation >= 5 && orientation <= 8) {
    return { width: height, height: width }
  }
  return { width, height }
}

/** WebKit always uses the 24 MP cap. Resize options are not trusted there. */
export function pixelCap(sizing: DecodeSizing): number {
  if (sizing.webkit || !sizing.resizeWorks) return MAX_PIXELS_UNSCALED
  return MAX_PIXELS
}

export function isDecompressionBomb(
  width: number,
  height: number,
  maxPixels = MAX_PIXELS,
): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return true
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return true
  }
  return width * height > maxPixels
}
