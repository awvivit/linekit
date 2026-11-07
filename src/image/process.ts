import { planTrace, type AutoPlan } from './classify.ts'
import { decodeImage, detectDecodeEnvironment, type DecodeOptions, type DecodedImage } from './decode.ts'
import { editableFromCenterline, strokesFromSvg, type EditableModel } from './edits.ts'
import { applyTraceFilters } from './filters.ts'
import { fullTrace } from './fulltrace.ts'
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
  type TraceView,
} from './limits.ts'
import { encodePng } from './png.ts'
import { applyOrientation, cleanDrawing, cropNormalized, downscaleRaster } from './raster.ts'
import { buildCenterline, renderCenterline, type CenterlineModel } from './centerline.ts'
import { perspectiveKey, warpPerspective } from './perspective.ts'
import { vectorize } from './vectorize.ts'

export type TraceDocument = {
  svg: string
  model: EditableModel | null
  plan: AutoPlan
  resolved: 'lines' | 'full'
}

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
  return tracePreparedDocument(photo, controls, options).svg
}

export function tracePreparedDocument(
  photo: PreparedPhoto,
  controls: TraceControls,
  options?: { cache?: CenterlineCache; deadline?: number },
): TraceDocument {
  const corrected = warpPerspective(photo.raster, controls.perspective)
  const cropped = cropNormalized(corrected, controls.crop)
  const plan = planTrace(cropped)
  const tuned = tuneControls(controls, plan)
  const pipeline = choosePipeline(tuned.view, tuned.cleanup, plan.mode)
  if (pipeline === 'full') {
    const svg = fullTrace(cropped, {
      smoothNoise: tuned.smoothNoise,
      edgeDetail: tuned.edgeDetail,
      evenLighting: tuned.evenLighting,
      colorCount: tuned.colorCount,
      smoothing: tuned.smoothing,
    })
    const strokes = strokesFromSvg(svg)
    const size = svgSize(svg, cropped.width, cropped.height)
    return {
      svg,
      plan,
      resolved: 'full',
      model: strokes.length ? { width: size.width, height: size.height, penWidth: 1, kind: 'fill', strokes } : null,
    }
  }
  const filtered = applyTraceFilters(cropped, tuned)
  const binary = cleanDrawing(filtered, tuned.darkness, tuned.specks)
  if (pipeline === 'outline') {
    const svg = vectorize(binary, tuned.smoothing)
    const strokes = strokesFromSvg(svg)
    return {
      svg,
      plan,
      resolved: 'lines',
      model: strokes.length
        ? { width: binary.width, height: binary.height, penWidth: 1, kind: 'fill', strokes }
        : null,
    }
  }
  const key = [
    tuned.darkness,
    tuned.specks,
    tuned.smoothNoise,
    tuned.edgeDetail,
    tuned.evenLighting ? 1 : 0,
    controls.crop.x,
    controls.crop.y,
    controls.crop.width,
    controls.crop.height,
    perspectiveKey(controls.perspective),
  ].join('|')
  const cached = options?.cache
  const model = cached && cached.key === key && cached.model
    ? cached.model
    : buildCenterline(binary, options?.deadline ?? Number.POSITIVE_INFINITY)
  if (cached) {
    cached.key = key
    cached.model = model
  }
  return {
    svg: renderCenterline(model, tuned.smoothing),
    model: editableFromCenterline(model),
    plan,
    resolved: 'lines',
  }
}

function svgSize(svg: string, fallbackWidth: number, fallbackHeight: number): { width: number; height: number } {
  const width = Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1])
  const height = Number(/\bheight="([\d.]+)"/.exec(svg)?.[1])
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  return { width: fallbackWidth, height: fallbackHeight }
}

function tuneControls(controls: TraceControls, plan: AutoPlan): TraceControls & {
  view?: TraceView
  smoothNoise: number
  edgeDetail: number
  evenLighting: boolean
  colorCount: number
} {
  const follow = controls.view === 'auto' && controls.followAuto === true
  return {
    ...controls,
    darkness: follow ? plan.faintLines : controls.darkness,
    smoothing: follow ? plan.smoothing : controls.smoothing,
    specks: follow ? plan.specks : controls.specks,
    smoothNoise: follow ? plan.smoothNoise : (controls.smoothNoise ?? 0),
    edgeDetail: follow ? plan.edgeDetail : (controls.edgeDetail ?? 0),
    evenLighting: follow ? plan.evenLighting : controls.evenLighting === true,
    colorCount: follow ? plan.colorCount : (controls.colorCount ?? plan.colorCount),
  }
}

function choosePipeline(
  view: TraceView | undefined,
  cleanup: boolean,
  planMode: 'lines' | 'full',
): 'full' | 'centerline' | 'outline' {
  switch (view) {
    case 'full':
      return 'full'
    case 'auto':
      if (planMode === 'full') return 'full'
      return cleanup ? 'centerline' : 'outline'
    case 'lines':
      return cleanup ? 'centerline' : 'outline'
    case undefined:
      return cleanup ? 'centerline' : 'outline'
    default: {
      const exhaustive: never = view
      return exhaustive
    }
  }
}

export async function buildPreview(
  raster: Raster,
  maxEdge = PREVIEW_EDGE,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const scaled = downscaleRaster(raster, maxEdge)
  return { bytes: await encodePng(scaled), width: scaled.width, height: scaled.height }
}
