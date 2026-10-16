import { describe, expect, it } from 'vitest'
import { inspectImage } from './inspect.ts'
import { BOMB_MESSAGE, MAX_BYTES, isDecompressionBomb, targetSize } from './limits.ts'

describe('image limits', () => {
  it('accepts a full-size iPhone photo and rejects a decompression bomb', () => {
    expect(isDecompressionBomb(4032, 3024)).toBe(false)
    expect(targetSize(4032, 3024)).toEqual({ width: 4000, height: 3000 })
    expect(isDecompressionBomb(100_000, 100_000)).toBe(true)
    expect(isDecompressionBomb(16_385, 10)).toBe(true)
    expect(MAX_BYTES).toBeGreaterThan(12_000_000)
  })
})

describe('inspectImage', () => {
  it('reads a 4032×3024 PNG header and does not treat it as a bomb', () => {
    const inspection = inspectImage(pngHeader(4032, 3024))
    expect(inspection).toMatchObject({ ok: true, kind: 'png', width: 4032, height: 3024 })
  })

  it('refuses a PNG whose header claims a huge pixel size', () => {
    const inspection = inspectImage(pngHeader(100_000, 100_000))
    expect(inspection).toEqual({ ok: false, code: 'bomb', message: BOMB_MESSAGE })
  })

  it('reads JPEG dimensions and EXIF orientation without decoding the scan', () => {
    const inspection = inspectImage(jpegHeader(4032, 3024, 6))
    expect(inspection).toMatchObject({ ok: true, kind: 'jpeg', width: 4032, height: 3024, orientation: 6 })
  })

  it('refuses a WebP canvas that claims bomb dimensions', () => {
    const inspection = inspectImage(webpHeader(80_000, 80_000))
    expect(inspection.ok).toBe(false)
    if (!inspection.ok) expect(inspection.code).toBe('bomb')
  })

  it('reads HEIC ispe dimensions and refuses an oversized one', () => {
    expect(inspectImage(heicHeader(4032, 3024))).toMatchObject({
      ok: true,
      kind: 'heic',
      width: 4032,
      height: 3024,
    })
    const bomb = inspectImage(heicHeader(90_000, 90_000))
    expect(bomb).toMatchObject({ ok: false, code: 'bomb' })
  })
})

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set(ascii('IHDR'), 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpegHeader(width: number, height: number, orientation: number): Uint8Array {
  const tiff = new Uint8Array(26)
  const tiffView = new DataView(tiff.buffer)
  tiff[0] = 0x49
  tiff[1] = 0x49
  tiffView.setUint16(2, 42, true)
  tiffView.setUint32(4, 8, true)
  tiffView.setUint16(8, 1, true)
  tiffView.setUint16(10, 0x0112, true)
  tiffView.setUint16(12, 3, true)
  tiffView.setUint32(14, 1, true)
  tiffView.setUint16(18, orientation, true)
  const payload = new Uint8Array(6 + tiff.length)
  payload.set(ascii('Exif\0\0'), 0)
  payload.set(tiff, 6)
  const app1 = new Uint8Array(4 + payload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  new DataView(app1.buffer).setUint16(2, payload.length + 2)
  app1.set(payload, 4)
  const sof = new Uint8Array([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 255,
    height & 255,
    (width >> 8) & 255,
    width & 255,
    0x01,
    0x01,
    0x11,
    0x00,
  ])
  const bytes = new Uint8Array(2 + app1.length + sof.length + 2)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes.set(app1, 2)
  bytes.set(sof, 2 + app1.length)
  bytes[bytes.length - 2] = 0xff
  bytes[bytes.length - 1] = 0xd9
  return bytes
}

function webpHeader(width: number, height: number): Uint8Array {
  const chunk = new Uint8Array(18)
  chunk.set(ascii('VP8X'), 0)
  new DataView(chunk.buffer).setUint32(4, 10, true)
  const canvasWidth = width - 1
  const canvasHeight = height - 1
  chunk[12] = canvasWidth & 255
  chunk[13] = (canvasWidth >> 8) & 255
  chunk[14] = (canvasWidth >> 16) & 255
  chunk[15] = canvasHeight & 255
  chunk[16] = (canvasHeight >> 8) & 255
  chunk[17] = (canvasHeight >> 16) & 255
  const bytes = new Uint8Array(12 + chunk.length)
  bytes.set(ascii('RIFF'), 0)
  new DataView(bytes.buffer).setUint32(4, 4 + chunk.length, true)
  bytes.set(ascii('WEBP'), 8)
  bytes.set(chunk, 12)
  return bytes
}

function heicHeader(width: number, height: number): Uint8Array {
  const ispeBody = new Uint8Array(12)
  const ispeView = new DataView(ispeBody.buffer)
  ispeView.setUint32(4, width)
  ispeView.setUint32(8, height)
  const ispe = box('ispe', ispeBody)
  const ipco = box('ipco', ispe)
  const iprp = box('iprp', ipco)
  const metaBody = new Uint8Array(4 + iprp.length)
  metaBody.set(iprp, 4)
  const meta = box('meta', metaBody)
  const ftypBody = new Uint8Array(12)
  ftypBody.set(ascii('heic'), 0)
  ftypBody.set(ascii('heic'), 8)
  return concat(box('ftyp', ftypBody), meta)
}

function box(type: string, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + content.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(ascii(type), 4)
  out.set(content, 8)
  return out
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
