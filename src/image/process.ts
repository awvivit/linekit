import { decodeImage, detectDecodeEnvironment, type DecodeOptions, type DecodedImage } from './decode.ts'
import { inspectImage, type SafeImage } from './inspect.ts'
import {
  BOMB_MESSAGE,
  DECODE_MESSAGE,
  EMPTY_MESSAGE,
  HEIC_MESSAGE,
  ImageProcessError,
  MAX_EDGE,
  PREVIEW_EDGE,
  TOO_LARGE_MESSAGE,
  exceedsByteCap,
  isDecompressionBomb,
  pixelCap,
  type Raster,
  type TraceControls,
} from './limits.ts'
import { encodePng } from './png.ts'
import { applyOrientation, cleanDrawing, cropNormalized, downscaleRaster } from './raster.ts'
import { buildCenterline, renderCenterline, type CenterlineModel } from './centerline.ts'
import { vectorize } from './vectorize.ts'

export type PreparedPhoto = {
  raster: Raster
  width: number
  height: number
}

export type Decoder = (
  bytes: Uint8Array,
  image: SafeImage,
  options?: DecodeOptions,
) => Promise<DecodedImage>

export async function preparePhoto(
  bytes: Uint8Array,
  decode: Decoder = decodeImage,
  options?: DecodeOptions,
): Promise<PreparedPhoto> {
  if (bytes.byteLength === 0) {
    throw new ImageProcessError('empty', EMPTY_MESSAGE)
  }
  if (exceedsByteCap(bytes.byteLength)) {
    throw new ImageProcessError('too-large', TOO_LARGE_MESSAGE)
  }
  const inspection = inspectImage(bytes)
  if (!inspection.ok) {
    throw new ImageProcessError(inspection.code, inspection.message)
  }
  const environment = options?.environment ?? (await detectDecodeEnvironment())
  if (isDecompressionBomb(inspection.width, inspection.height, pixelCap(environment))) {
    throw new ImageProcessError('bomb', BOMB_MESSAGE)
  }

  let decoded: DecodedImage
  try {
    decoded = await decode(bytes, inspection, { ...options, environment })
  } catch (error) {
    if (error instanceof ImageProcessError) throw error
    if (inspection.kind === 'heic') throw new ImageProcessError('heic', HEIC_MESSAGE)
    throw new ImageProcessError('decode', DECODE_MESSAGE)
  }

  const upright = decoded.upright
    ? decoded.raster
    : applyOrientation(decoded.raster, inspection.orientation)
  const scaled = downscaleRaster(upright, MAX_EDGE)
  return { raster: scaled, width: scaled.width, height: scaled.height }
}

export type CenterlineCache = {
  key: string
  model: CenterlineModel | null
}

export function tracePrepared(
  photo: PreparedPhoto,
  controls: TraceControls,
  options?: { cache?: CenterlineCache; deadline?: number },
): string {
  const cropped = cropNormalized(photo.raster, controls.crop)
  const binary = cleanDrawing(cropped, controls.darkness, controls.specks)
  if (controls.cleanup === false) return vectorize(binary, controls.smoothing)
  const key = [
    controls.darkness,
    controls.specks,
    controls.crop.x,
    controls.crop.y,
    controls.crop.width,
    controls.crop.height,
  ].join('|')
  const cached = options?.cache
  if (cached && cached.key === key && cached.model) return renderCenterline(cached.model, controls.smoothing)
  const model = buildCenterline(binary, options?.deadline ?? Number.POSITIVE_INFINITY)
  if (cached) {
    cached.key = key
    cached.model = model
  }
  return renderCenterline(model, controls.smoothing)
}

export async function buildPreview(
  raster: Raster,
  maxEdge = PREVIEW_EDGE,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const scaled = downscaleRaster(raster, maxEdge)
  return { bytes: await encodePng(scaled), width: scaled.width, height: scaled.height }
}
