import imageTracer from 'imagetracerjs'
import { optimize } from 'svgo/browser'
import type { BinaryImage } from './limits.ts'
import { sanitizeSvg } from './sanitize.ts'

export function vectorize(image: BinaryImage, smoothing: number): string {
  const data = new Uint8ClampedArray(image.width * image.height * 4)
  for (let index = 0; index < image.ink.length; index += 1) {
    const value = image.ink[index] === 1 ? 0 : 255
    const offset = index * 4
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
    data[offset + 3] = 255
  }
  const amount = Math.min(100, Math.max(0, smoothing))
  const tolerance = 0.4 + (amount / 100) * 10
  const traced = imageTracer.imagedataToSVG(
    { width: image.width, height: image.height, data },
    {
      ltres: tolerance,
      qtres: tolerance,
      pathomit: 0,
      rightangleenhance: amount < 40,
      colorsampling: 0,
      numberofcolors: 2,
      mincolorratio: 0,
      colorquantcycles: 1,
      layering: 0,
      strokewidth: 1,
      linefilter: false,
      scale: 1,
      roundcoords: 1,
      viewbox: false,
      desc: false,
      blurradius: 0,
      blurdelta: 0,
      lcpr: 0,
      qcpr: 0,
    },
  )
  return finishSvg(dropPaperPaths(traced), image.width, image.height)
}

export function vectorizePalette(
  image: { width: number; height: number; data: Uint8ClampedArray },
  smoothing: number,
  palette: Array<{ r: number; g: number; b: number }>,
): string {
  const amount = Math.min(100, Math.max(0, smoothing))
  const tolerance = 0.55 + (amount / 100) * 5.5
  const traced = imageTracer.imagedataToSVG(
    { width: image.width, height: image.height, data: image.data },
    {
      ltres: tolerance,
      qtres: tolerance,
      pathomit: 1,
      rightangleenhance: amount < 62,
      pal: palette.map((color) => ({ r: color.r, g: color.g, b: color.b, a: 255 })),
      numberofcolors: Math.max(2, palette.length),
      mincolorratio: 0,
      colorquantcycles: 1,
      layering: 0,
      strokewidth: 0,
      linefilter: false,
      scale: 1,
      roundcoords: 1,
      viewbox: false,
      desc: false,
      blurradius: 0,
      blurdelta: 0,
      lcpr: 0,
      qcpr: 0,
    },
  )
  return finishSvg(dropLargePaper(traced, image.width, image.height), image.width, image.height)
}

function finishSvg(svg: string, width: number, height: number): string {
  const optimized = optimize(svg, {
    multipass: true,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            removeDesc: { removeAny: true },
          },
        },
      },
      { name: 'removeDesc', params: { removeAny: true } },
      'removeTitle',
      'removeMetadata',
      'removeComments',
      'removeRasterImages',
      'removeScripts',
      'removeStyleElement',
      'removeEditorsNSData',
    ],
  }).data
  return sanitizeSvg(ensureDimensions(optimized, width, height))
}

function dropLargePaper(svg: string, width: number, height: number): string {
  return svg.replace(/<path\b[\s\S]*?(?:\/>|<\/path>)/g, (path) => {
    if (!isPurePaper(path)) return path
    const box = pathBounds(path)
    if (!box) return path
    const area = Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY)
    return area > width * height * 0.45 ? '' : path
  })
}

function isPurePaper(path: string): boolean {
  const fill = /fill="([^"]+)"/i.exec(path)?.[1]?.replace(/\s+/g, '').toLowerCase()
  if (!fill) return false
  if (fill === 'white' || fill === '#fff' || fill === '#ffffff') return true
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(fill)
  if (!rgb) return false
  return Number(rgb[1]) >= 253 && Number(rgb[2]) >= 253 && Number(rgb[3]) >= 253
}

function pathBounds(path: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const data = /d="([^"]+)"/i.exec(path)?.[1]
  if (!data) return null
  const tokens = data.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g)
  if (!tokens) return null
  let command = ''
  let index = 0
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const mark = (px: number, py: number) => {
    minX = Math.min(minX, px)
    minY = Math.min(minY, py)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
  }
  const read = (): number => {
    const token = tokens[index]
    index += 1
    return Number(token)
  }
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/[a-zA-Z]/.test(token)) {
      command = token
      index += 1
      if (command === 'Z' || command === 'z') {
        x = startX
        y = startY
        mark(x, y)
      }
      continue
    }
    if (command === 'M' || command === 'L' || command === 'T') {
      x = read()
      y = read()
      if (command === 'M') {
        startX = x
        startY = y
        command = 'L'
      }
      mark(x, y)
    } else if (command === 'm' || command === 'l' || command === 't') {
      x += read()
      y += read()
      if (command === 'm') {
        startX = x
        startY = y
        command = 'l'
      }
      mark(x, y)
    } else if (command === 'H') {
      x = read()
      mark(x, y)
    } else if (command === 'h') {
      x += read()
      mark(x, y)
    } else if (command === 'V') {
      y = read()
      mark(x, y)
    } else if (command === 'v') {
      y += read()
      mark(x, y)
    } else if (command === 'C') {
      mark(read(), read())
      mark(read(), read())
      x = read()
      y = read()
      mark(x, y)
    } else if (command === 'c') {
      mark(x + read(), y + read())
      mark(x + read(), y + read())
      x += read()
      y += read()
      mark(x, y)
    } else if (command === 'Q' || command === 'S') {
      mark(read(), read())
      x = read()
      y = read()
      mark(x, y)
    } else if (command === 'q' || command === 's') {
      mark(x + read(), y + read())
      x += read()
      y += read()
      mark(x, y)
    } else {
      index += 1
    }
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

function dropPaperPaths(svg: string): string {
  return svg.replace(/<path\b[\s\S]*?(?:\/>|<\/path>)/g, (path) => (isPaperPath(path) ? '' : path))
}

function isPaperPath(path: string): boolean {
  const fill = /fill="([^"]+)"/i.exec(path)?.[1]?.replace(/\s+/g, '').toLowerCase()
  if (!fill) return false
  if (fill === 'white' || fill === '#fff' || fill === '#ffffff') return true
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(fill)
  if (!rgb) return false
  return Number(rgb[1]) >= 250 && Number(rgb[2]) >= 250 && Number(rgb[3]) >= 250
}

function ensureDimensions(svg: string, width: number, height: number): string {
  return svg.replace(/<svg\b([^>]*)>/, (_match, attributes: string) => {
    let next = attributes
    if (!/\swidth="/i.test(` ${next}`)) next += ` width="${width}"`
    if (!/\sheight="/i.test(` ${next}`)) next += ` height="${height}"`
    if (!/\sviewBox="/i.test(` ${next}`)) next += ` viewBox="0 0 ${width} ${height}"`
    return `<svg${next}>`
  })
}
