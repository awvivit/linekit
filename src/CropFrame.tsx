import { useRef } from 'react'
import type { NormalizedCrop } from './image/limits.ts'

type Point = { x: number; y: number }
type Handle = 'nw' | 'ne' | 'sw' | 'se'
type Drag =
  | { kind: 'draw'; origin: Point }
  | { kind: 'move'; origin: Point; start: NormalizedCrop }
  | { kind: 'resize'; handle: Handle; start: NormalizedCrop }

const HANDLE_SIZE = 0.045

export default function CropFrame({
  src,
  crop,
  onCrop,
}: {
  src: string
  crop: NormalizedCrop
  onCrop: (crop: NormalizedCrop) => void
}) {
  const drag = useRef<Drag | null>(null)
  const cropRef = useRef(crop)

  function update(next: NormalizedCrop) {
    cropRef.current = next
    onCrop(next)
  }

  function locate(event: React.PointerEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = bounds.width === 0 ? 0 : (event.clientX - bounds.left) / bounds.width
    const y = bounds.height === 0 ? 0 : (event.clientY - bounds.top) / bounds.height
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = locate(event)
    const handle = fullCrop(crop) ? null : hitHandle(point, crop)
    if (handle) {
      drag.current = { kind: 'resize', handle, start: crop }
      return
    }
    if (!fullCrop(crop) && inside(point, crop)) {
      drag.current = { kind: 'move', origin: point, start: crop }
      return
    }
    drag.current = { kind: 'draw', origin: point }
    update({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const current = drag.current
    if (!current) return
    const point = locate(event)
    if (current.kind === 'draw') {
      update(fromPoints(current.origin, point))
      return
    }
    if (current.kind === 'move') {
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
    update(resize(current.start, current.handle, point))
  }

  function onPointerUp() {
    const current = drag.current
    drag.current = null
    const latest = cropRef.current
    if (current?.kind === 'draw' && (latest.width < 0.02 || latest.height < 0.02)) {
      update({ x: 0, y: 0, width: 1, height: 1 })
    }
  }

  const right = crop.x + crop.width
  const bottom = crop.y + crop.height
  const shade = `M0 0 H1 V1 H0 Z M${crop.x} ${crop.y} H${right} V${bottom} H${crop.x} Z`

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
        {fullCrop(crop)
          ? null
          : (['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
              const point = corner(crop, handle)
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
    </div>
  )
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

function hitHandle(point: Point, crop: NormalizedCrop): Handle | null {
  for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
    const cornerPoint = corner(crop, handle)
    if (Math.abs(point.x - cornerPoint.x) <= HANDLE_SIZE && Math.abs(point.y - cornerPoint.y) <= HANDLE_SIZE) {
      return handle
    }
  }
  return null
}

function corner(crop: NormalizedCrop, handle: Handle): Point {
  if (handle === 'nw') return { x: crop.x, y: crop.y }
  if (handle === 'ne') return { x: crop.x + crop.width, y: crop.y }
  if (handle === 'sw') return { x: crop.x, y: crop.y + crop.height }
  return { x: crop.x + crop.width, y: crop.y + crop.height }
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
