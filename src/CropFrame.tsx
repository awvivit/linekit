import { useRef } from 'react'
import {
  CROP_HANDLE_LABELS,
  CROP_HANDLES,
  CORNER_LABELS,
  CROP_CANCELLED,
  PERSPECTIVE_CORNERS,
  cornerPoint,
  cropCorner,
  cropNote,
  nudgeCrop,
  nudgePoint,
  pointNote,
  sameCrop,
  type CropHandle,
  type PerspectiveCorner,
} from './frame-keys.ts'
import type { NormalizedCrop, PerspectiveQuad } from './image/limits.ts'

type Point = { x: number; y: number }
type Handle = 'nw' | 'ne' | 'sw' | 'se'
type Drag =
  | { kind: 'draw'; origin: Point }
  | { kind: 'move'; origin: Point; start: NormalizedCrop }
  | { kind: 'resize'; handle: Handle; start: NormalizedCrop }
  | { kind: 'perspective'; corner: PerspectiveCorner }

const HANDLE_SIZE = 0.045
/** Keep the round handles inside the frame so the edge does not clip them. */
const PERSPECTIVE_HANDLE_INSET = 0.05

export default function CropFrame({
  src,
  crop,
  onCrop,
  perspective,
  onPerspective,
  onPerspectiveGesture,
  onCropGesture,
  onAnnounce,
}: {
  src: string
  crop: NormalizedCrop
  onCrop: (crop: NormalizedCrop, note?: string) => void
  perspective: PerspectiveQuad | null
  onPerspective: (quad: PerspectiveQuad) => void
  onPerspectiveGesture: (phase: 'start' | 'end') => void
  onCropGesture: (
    phase: 'start' | 'end' | 'accept' | 'cancel',
    source: 'pointer' | 'key',
    control?: HTMLElement,
  ) => void
  onAnnounce: (message: string) => void
}) {
  const drag = useRef<Drag | null>(null)
  const cropRef = useRef(crop)
  const cropKey = useRef<{ baseline: NormalizedCrop; dirty: boolean } | null>(null)
  const handlingKey = useRef(false)

  function update(next: NormalizedCrop, note?: string) {
    cropRef.current = next
    onCrop(next, note)
  }

  function locate(event: React.PointerEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = bounds.width === 0 ? 0 : (event.clientX - bounds.left) / bounds.width
    const y = bounds.height === 0 ? 0 : (event.clientY - bounds.top) / bounds.height
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    cropRef.current = crop
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = locate(event)
    if (perspective) {
      const corner = hitPerspective(point, perspective)
      if (corner) {
        onPerspectiveGesture('start')
        drag.current = { kind: 'perspective', corner }
        return
      }
    }
    const handle = fullCrop(crop) ? null : hitHandle(point, crop)
    if (handle) {
      onCropGesture('start', 'pointer')
      drag.current = { kind: 'resize', handle, start: crop }
      return
    }
    if (!fullCrop(crop) && inside(point, crop)) {
      onCropGesture('start', 'pointer')
      drag.current = { kind: 'move', origin: point, start: crop }
      return
    }
    onCropGesture('start', 'pointer')
    drag.current = { kind: 'draw', origin: point }
    update({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const current = drag.current
    if (!current) return
    const point = locate(event)
    switch (current.kind) {
      case 'draw':
        update(fromPoints(current.origin, point))
        return
      case 'move': {
        const dx = point.x - current.origin.x
        const dy = point.y - current.origin.y
        update({
          x: clamp(current.start.x + dx, 0, 1 - current.start.width),
          y: clamp(current.start.y + dy, 0, 1 - current.start.height),
          width: current.start.width,
          height: current.start.height,
        })
        return
      }
      case 'resize':
        update(resize(current.start, current.handle, point))
        return
      case 'perspective':
        if (!perspective) return
        onPerspective({ ...perspective, [current.corner]: point })
        return
      default: {
        const exhaustive: never = current
        return exhaustive
      }
    }
  }

  function onPointerUp() {
    const current = drag.current
    drag.current = null
    if (current?.kind === 'perspective') onPerspectiveGesture('end')
    const latest = cropRef.current
    if (current?.kind === 'draw' && (latest.width < 0.02 || latest.height < 0.02)) {
      update({ x: 0, y: 0, width: 1, height: 1 })
    }
    if (current && current.kind !== 'perspective') onCropGesture('end', 'pointer')
  }

  function onCornerKey(corner: PerspectiveCorner, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !perspective) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (!isArrow(event.key)) return
    event.preventDefault()
    const nextPoint = nudgePoint(cornerPoint(perspective, corner), event.key, event.shiftKey)
    if (!nextPoint) return
    onPerspectiveGesture('start')
    onPerspective({ ...perspective, [corner]: nextPoint })
    onPerspectiveGesture('end')
    onAnnounce(pointNote(CORNER_LABELS[corner], nextPoint))
  }

  function onCropKey(handle: CropHandle, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (cropKey.current?.dirty) {
        cropKey.current = { baseline: crop, dirty: false }
        onCropGesture('accept', 'key', event.currentTarget)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      const session = cropKey.current
      cropKey.current = null
      if (session?.dirty && !sameCrop(crop, session.baseline)) {
        handlingKey.current = true
        onCropGesture('cancel', 'key', event.currentTarget)
        update(session.baseline, CROP_CANCELLED)
        handlingKey.current = false
      }
      event.currentTarget.blur()
      return
    }
    if (!isArrow(event.key)) return
    event.preventDefault()
    const next = nudgeCrop(crop, handle, event.key, event.shiftKey)
    if (!next) return
    const baseline = cropKey.current?.baseline ?? crop
    handlingKey.current = true
    cropKey.current = { baseline, dirty: true }
    onCropGesture('start', 'key', event.currentTarget)
    update(next, cropNote(handle, next))
    onCropGesture('end', 'key')
    handlingKey.current = false
  }

  function onCropBlur() {
    if (handlingKey.current) return
    cropKey.current = null
    onCropGesture('accept', 'key')
  }

  const right = crop.x + crop.width
  const bottom = crop.y + crop.height
  const shade = `M0 0 H1 V1 H0 Z M${crop.x} ${crop.y} H${right} V${bottom} H${crop.x} Z`
  const quiet = fullCrop(crop)

  return (
    <div className="frame">
      <img src={src} alt="Original photo" />
      <svg
        className="crop-layer"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-label="Crop rectangle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <rect className="crop-hit" x="0" y="0" width="1" height="1" />
        <path className="crop-shade" fillRule="evenodd" d={shade} />
        <rect className="crop-box-outer" x={crop.x} y={crop.y} width={crop.width} height={crop.height} />
        <rect className="crop-box-inner" x={crop.x} y={crop.y} width={crop.width} height={crop.height} />
        {perspective ? (
          <polygon
            className="perspective-quad"
            points={PERSPECTIVE_CORNERS.map((corner) => {
              const point = perspective[corner]
              return `${point.x},${point.y}`
            }).join(' ')}
          />
        ) : null}
        {perspective
          ? PERSPECTIVE_CORNERS.map((corner) => {
              const point = visiblePerspectiveHandle(perspective[corner])
              return <circle key={corner} className="perspective-handle" cx={point.x} cy={point.y} r={0.028} />
            })
          : null}
        {quiet
          ? null
          : (['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
              const point = cropCorner(crop, handle)
              return (
                <rect
                  key={handle}
                  className="crop-handle"
                  x={point.x - HANDLE_SIZE / 2}
                  y={point.y - HANDLE_SIZE / 2}
                  width={HANDLE_SIZE}
                  height={HANDLE_SIZE}
                />
              )
            })}
      </svg>
      {perspective
        ? PERSPECTIVE_CORNERS.map((corner) => {
            const point = cornerPoint(perspective, corner)
            const visible = visiblePerspectiveHandle(point)
            return (
              <button
                key={corner}
                type="button"
                className="frame-key round"
                style={place(visible)}
                tabIndex={0}
                aria-label={CORNER_LABELS[corner]}
                aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                data-x={point.x}
                data-y={point.y}
                onKeyDown={(event) => {
                  onCornerKey(corner, event)
                }}
              />
            )
          })
        : null}
      {CROP_HANDLES.map((handle) => {
        const point = cropCorner(crop, handle)
        const round = handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw'
        return (
          <button
            key={handle}
            type="button"
            className={round ? 'frame-key round' : 'frame-key'}
            style={place(point)}
            tabIndex={0}
            aria-label={CROP_HANDLE_LABELS[handle]}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Escape"
            data-quiet={quiet ? 'true' : 'false'}
            onKeyDown={(event) => {
              onCropKey(handle, event)
            }}
            onBlur={onCropBlur}
          />
        )
      })}
    </div>
  )
}

function place(point: Point): React.CSSProperties {
  return { left: `${point.x * 100}%`, top: `${point.y * 100}%` }
}

function isArrow(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
}

function fromPoints(origin: Point, point: Point): NormalizedCrop {
  return {
    x: Math.min(origin.x, point.x),
    y: Math.min(origin.y, point.y),
    width: Math.abs(point.x - origin.x),
    height: Math.abs(point.y - origin.y),
  }
}

function resize(start: NormalizedCrop, handle: Handle, point: Point): NormalizedCrop {
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle === 'nw' || handle === 'sw') left = clamp(point.x, 0, right - 0.02)
  if (handle === 'ne' || handle === 'se') right = clamp(point.x, left + 0.02, 1)
  if (handle === 'nw' || handle === 'ne') top = clamp(point.y, 0, bottom - 0.02)
  if (handle === 'sw' || handle === 'se') bottom = clamp(point.y, top + 0.02, 1)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function visiblePerspectiveHandle(point: Point): Point {
  return {
    x: clamp(point.x, PERSPECTIVE_HANDLE_INSET, 1 - PERSPECTIVE_HANDLE_INSET),
    y: clamp(point.y, PERSPECTIVE_HANDLE_INSET, 1 - PERSPECTIVE_HANDLE_INSET),
  }
}

function hitPerspective(point: Point, quad: PerspectiveQuad): PerspectiveCorner | null {
  for (const corner of PERSPECTIVE_CORNERS) {
    const at = visiblePerspectiveHandle(quad[corner])
    if (Math.abs(point.x - at.x) <= 0.06 && Math.abs(point.y - at.y) <= 0.06) return corner
  }
  return null
}

function hitHandle(point: Point, crop: NormalizedCrop): Handle | null {
  for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
    const corner = cropCorner(crop, handle)
    if (Math.abs(point.x - corner.x) <= HANDLE_SIZE && Math.abs(point.y - corner.y) <= HANDLE_SIZE) {
      return handle
    }
  }
  return null
}

function inside(point: Point, crop: NormalizedCrop): boolean {
  return point.x >= crop.x && point.y >= crop.y && point.x <= crop.x + crop.width && point.y <= crop.y + crop.height
}

function fullCrop(crop: NormalizedCrop): boolean {
  return crop.x <= 0.005 && crop.y <= 0.005 && crop.width >= 0.99 && crop.height >= 0.99
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
