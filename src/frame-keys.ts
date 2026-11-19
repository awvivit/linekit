import type { NormalizedCrop, PerspectiveQuad } from './image/limits.ts'

export const KEY_STEP = 0.01
export const KEY_STEP_LARGE = 0.05
const MIN_CROP = 0.02

export const PERSPECTIVE_CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const
export type PerspectiveCorner = (typeof PERSPECTIVE_CORNERS)[number]

export const CORNER_LABELS: Record<PerspectiveCorner, string> = {
  topLeft: 'Top-left corner',
  topRight: 'Top-right corner',
  bottomRight: 'Bottom-right corner',
  bottomLeft: 'Bottom-left corner',
}

export const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type CropHandle = (typeof CROP_HANDLES)[number]

export const CROP_HANDLE_LABELS: Record<CropHandle, string> = {
  nw: 'Top-left crop',
  n: 'Top edge',
  ne: 'Top-right crop',
  e: 'Right edge',
  se: 'Bottom-right crop',
  s: 'Bottom edge',
  sw: 'Bottom-left crop',
  w: 'Left edge',
}

export const SELECTION_CLEARED = 'Selection cleared.'
export const CROP_CANCELLED = 'Crop cancelled.'

type Point = { x: number; y: number }
type LineKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export function nudgePoint(point: Point, key: string, shift: boolean): Point | null {
  const delta = arrowDelta(key, shift)
  if (!delta) return null
  const next = { x: unit(point.x + delta.x), y: unit(point.y + delta.y) }
  if (next.x === point.x && next.y === point.y) return null
  return next
}

export function nudgeCrop(crop: NormalizedCrop, handle: CropHandle, key: string, shift: boolean): NormalizedCrop | null {
  const delta = arrowDelta(key, shift)
  if (!delta) return null
  let left = crop.x
  let top = crop.y
  let right = crop.x + crop.width
  let bottom = crop.y + crop.height
  if (movesLeft(handle) && delta.x !== 0) left = clamp(left + delta.x, 0, right - MIN_CROP)
  if (movesRight(handle) && delta.x !== 0) right = clamp(right + delta.x, left + MIN_CROP, 1)
  if (movesTop(handle) && delta.y !== 0) top = clamp(top + delta.y, 0, bottom - MIN_CROP)
  if (movesBottom(handle) && delta.y !== 0) bottom = clamp(bottom + delta.y, top + MIN_CROP, 1)
  const next = { x: unit(left), y: unit(top), width: unit(right - left), height: unit(bottom - top) }
  if (next.x === crop.x && next.y === crop.y && next.width === crop.width && next.height === crop.height) return null
  return next
}

export function moveLine(index: number, count: number, key: string): number | null {
  const lineKey = asLineKey(key)
  if (!lineKey || count <= 0) return null
  let next = index
  switch (lineKey) {
    case 'ArrowLeft':
    case 'ArrowUp':
      next = Math.max(0, index - 1)
      break
    case 'ArrowRight':
    case 'ArrowDown':
      next = Math.min(count - 1, index + 1)
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default: {
      const exhaustive: never = lineKey
      return exhaustive
    }
  }
  return next === index ? null : next
}

export function pointNote(label: string, point: Point): string {
  return `${label}, ${percent(point.x)}% across, ${percent(point.y)}% down.`
}

export function cropNote(handle: CropHandle, crop: NormalizedCrop): string {
  const label = CROP_HANDLE_LABELS[handle]
  if (handle === 'n') return `${label}, ${percent(crop.y)}% down.`
  if (handle === 's') return `${label}, ${percent(crop.y + crop.height)}% down.`
  if (handle === 'w') return `${label}, ${percent(crop.x)}% across.`
  if (handle === 'e') return `${label}, ${percent(crop.x + crop.width)}% across.`
  return pointNote(label, cropCorner(crop, handle))
}

export function lineNote(index: number): string {
  return `Line ${index + 1}.`
}

export function lineSelectedNote(index: number): string {
  return `Line ${index + 1} selected.`
}

export function sameCrop(left: NormalizedCrop, right: NormalizedCrop): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

export function cropCorner(crop: NormalizedCrop, handle: CropHandle): Point {
  const right = crop.x + crop.width
  const bottom = crop.y + crop.height
  const midX = crop.x + crop.width / 2
  const midY = crop.y + crop.height / 2
  switch (handle) {
    case 'nw':
      return { x: crop.x, y: crop.y }
    case 'n':
      return { x: midX, y: crop.y }
    case 'ne':
      return { x: right, y: crop.y }
    case 'e':
      return { x: right, y: midY }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: midX, y: bottom }
    case 'sw':
      return { x: crop.x, y: bottom }
    case 'w':
      return { x: crop.x, y: midY }
    default: {
      const exhaustive: never = handle
      return exhaustive
    }
  }
}

export function cornerPoint(quad: PerspectiveQuad, corner: PerspectiveCorner): Point {
  switch (corner) {
    case 'topLeft':
      return quad.topLeft
    case 'topRight':
      return quad.topRight
    case 'bottomRight':
      return quad.bottomRight
    case 'bottomLeft':
      return quad.bottomLeft
    default: {
      const exhaustive: never = corner
      return exhaustive
    }
  }
}

function arrowDelta(key: string, shift: boolean): Point | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 }
    case 'ArrowRight':
      return { x: step, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -step }
    case 'ArrowDown':
      return { x: 0, y: step }
    default:
      return null
  }
}

function asLineKey(key: string): LineKey | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Home':
    case 'End':
      return key
    default:
      return null
  }
}

function movesLeft(handle: CropHandle): boolean {
  return handle === 'nw' || handle === 'sw' || handle === 'w'
}

function movesRight(handle: CropHandle): boolean {
  return handle === 'ne' || handle === 'se' || handle === 'e'
}

function movesTop(handle: CropHandle): boolean {
  return handle === 'nw' || handle === 'ne' || handle === 'n'
}

function movesBottom(handle: CropHandle): boolean {
  return handle === 'sw' || handle === 'se' || handle === 's'
}

function unit(value: number): number {
  return Math.round(clamp(value, 0, 1) * 10000) / 10000
}

function percent(value: number): number {
  return Math.round(value * 100)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
