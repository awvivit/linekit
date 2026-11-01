import { finalizeSvg, renderChains } from './centerline.ts'
import { renderPoints, type EditableModel, type Point, type Stroke } from './edits.ts'

export function renderEditable(model: EditableModel, fallbackSmoothing: number): string {
  if (model.kind === 'fill') return renderFill(model, fallbackSmoothing)
  const amounts = model.strokes.map((stroke) => stroke.smoothing ?? fallbackSmoothing)
  return renderChains(model.width, model.height, model.strokes, model.penWidth, amounts)
}

function renderFill(model: EditableModel, fallbackSmoothing: number): string {
  const paths = model.strokes
    .map((stroke) => fillPath(stroke, fallbackSmoothing))
    .filter((path) => path.length > 0)
    .map((data) => `<path fill="#000000" stroke="none" d="${data}"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}">${paths.join('')}</svg>`
  return finalizeSvg(svg)
}

function fillPath(stroke: Stroke, fallbackSmoothing: number): string {
  const rewritten = stroke.smoothing !== null && stroke.smoothing !== fallbackSmoothing
  if (stroke.source && !rewritten) return stroke.source
  const points = stroke.smoothing === null ? stroke.points : renderPoints({ ...stroke, smoothing: stroke.smoothing })
  return polygonPath(points, stroke.closed)
}

function polygonPath(points: Point[], closed: boolean): string {
  const first = points[0]
  if (!first || points.length < 2) return ''
  let data = `M${formatNumber(first.x)} ${formatNumber(first.y)}`
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    if (!point) continue
    data += `L${formatNumber(point.x)} ${formatNumber(point.y)}`
  }
  if (closed) data += 'Z'
  return data
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}
