import { describe, expect, it, vi } from 'vitest'
import { BOMB_MESSAGE, DEFAULT_CONTROLS, HEIC_MESSAGE, type Raster } from './limits.ts'
import { preparePhoto, tracePrepared } from './process.ts'
import { encodePng } from './png.ts'

const SECRET = 'LKSECRET_9f3c2a7b_GPS_37.8199_-122.4783_vacation-gps-photo.jpg'

describe('preparePhoto', () => {
  it('refuses a bomb header before decoding', async () => {
    const decode = vi.fn()
    await expect(preparePhoto(pngBombHeader(), decode)).rejects.toThrow(BOMB_MESSAGE)
    expect(decode).not.toHaveBeenCalled()
  })

  it('tells the user when this browser cannot open HEIC', async () => {
    await expect(preparePhoto(heicSafeHeader())).rejects.toThrow(HEIC_MESSAGE)
  })

  it('applies EXIF orientation while decoding a sideways PNG', async () => {
    const raster = solid(6, 4, [255, 255, 255, 255])
    paint(raster, 0, 0, [0, 0, 0, 255])
    const bytes = await encodePng(raster, { orientation: 6 })
    const photo = await preparePhoto(bytes)
    expect(photo.width).toBe(4)
    expect(photo.height).toBe(6)
    expect(photo.raster.data[3 * 4]).toBe(0)
    expect(photo.raster.data[0]).toBe(255)
  })
})

describe('traced SVG', () => {
  it('contains no source-photo metadata, name, EXIF, or embedded raster', async () => {
    const raster = drawing()
    const bytes = await encodePng(raster, {
      text: [
        { keyword: 'Comment', value: SECRET },
        { keyword: 'Description', value: 'GPS latitude 37.8199 longitude -122.4783' },
      ],
      orientation: 1,
    })
    expect(new TextDecoder().decode(bytes)).toContain(SECRET)
    const photo = await preparePhoto(bytes)
    const svg = tracePrepared(photo, DEFAULT_CONTROLS)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<path')
    expect(svg.toLowerCase()).not.toContain('imagetracer')
    expect(svg).not.toContain(SECRET)
    expect(svg).not.toContain('vacation-gps-photo')
    expect(svg).not.toContain('37.8199')
    expect(svg).not.toContain('-122.4783')
    expect(svg.toLowerCase()).not.toContain('exif')
    expect(svg.toLowerCase()).not.toContain('gps')
    expect(svg.toLowerCase()).not.toContain('base64')
    expect(svg.toLowerCase()).not.toContain('<image')
    expect(svg.toLowerCase()).not.toContain('<metadata')
    expect(svg.toLowerCase()).not.toContain('<title')
    expect(svg.toLowerCase()).not.toContain('<desc')
    expect(svg).not.toContain('<!--')
    expect(svg.toLowerCase()).not.toContain('<script')
    expect(svg.toLowerCase()).not.toContain('foreignobject')
    expect(svg.toLowerCase()).not.toContain('javascript:')
    const withoutNamespace = svg.replaceAll('http://www.w3.org/2000/svg', '')
    expect(withoutNamespace).not.toMatch(/https?:/i)
    expect(withoutNamespace).not.toContain('data:')
  })

  it('traces the cropped rectangle rather than the whole frame', async () => {
    const photo = { raster: drawing(), width: 48, height: 32 }
    const cropped = tracePrepared(photo, {
      ...DEFAULT_CONTROLS,
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
    })
    expect(cropped).toMatch(/width="24"/)
    expect(cropped).not.toContain(SECRET)
  })
})

function drawing(): Raster {
  const raster = solid(48, 32, [255, 255, 255, 255])
  for (let y = 12; y < 18; y += 1) {
    for (let x = 8; x < 40; x += 1) paint(raster, x, y, [0, 0, 0, 255])
  }
  return raster
}

function pngBombHeader(): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set(new TextEncoder().encode('IHDR'), 12)
  view.setUint32(16, 100_000)
  view.setUint32(20, 100_000)
  return bytes
}

function heicSafeHeader(): Uint8Array {
  const ispeBody = new Uint8Array(12)
  new DataView(ispeBody.buffer).setUint32(4, 64)
  new DataView(ispeBody.buffer).setUint32(8, 48)
  const ispe = box('ispe', ispeBody)
  const metaBody = new Uint8Array(4 + ispe.length)
  metaBody.set(ispe, 4)
  const ftypBody = new Uint8Array(12)
  ftypBody.set(new TextEncoder().encode('heic'), 0)
  ftypBody.set(new TextEncoder().encode('heic'), 8)
  const ftyp = box('ftyp', ftypBody)
  const meta = box('meta', metaBody)
  const out = new Uint8Array(ftyp.length + meta.length)
  out.set(ftyp, 0)
  out.set(meta, ftyp.length)
  return out
}

function box(type: string, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + content.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(content, 8)
  return out
}

function solid(width: number, height: number, fill: [number, number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0]
    data[index + 1] = fill[1]
    data[index + 2] = fill[2]
    data[index + 3] = fill[3]
  }
  return { width, height, data }
}

function paint(raster: Raster, x: number, y: number, fill: [number, number, number, number]): void {
  const index = (y * raster.width + x) * 4
  raster.data[index] = fill[0]
  raster.data[index + 1] = fill[1]
  raster.data[index + 2] = fill[2]
  raster.data[index + 3] = fill[3]
}
