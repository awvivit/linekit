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
  const optimized = optimize(dropPaperPaths(traced), {
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
  return sanitizeSvg(ensureDimensions(optimized, image.width, image.height))
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
