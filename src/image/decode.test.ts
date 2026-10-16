import { describe, expect, it, vi } from 'vitest'
import {
  decodeImage,
  isWebKitUserAgent,
  probeBitmapResize,
  type BitmapLike,
} from './decode.ts'
import { inspectImage } from './inspect.ts'
import {
  BOMB_MESSAGE,
  MAX_PIXELS,
  MAX_PIXELS_UNSCALED,
  isDecompressionBomb,
  pixelCap,
  targetSize,
  orientedDimensions,
} from './limits.ts'
import { preparePhoto } from './process.ts'

const jpeg = (width: number, height: number, orientation = 1) =>
  ({ ok: true, kind: 'jpeg', width, height, orientation }) as const

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function bitmap(width: number, height: number, close = () => undefined): BitmapLike {
  return { width, height, close }
}

describe('pixel caps', () => {
  it('keeps a 4032×3024 photo under both caps and a 35 MP photo under only the resize cap', () => {
    expect(isDecompressionBomb(4032, 3024, MAX_PIXELS_UNSCALED)).toBe(false)
    expect(isDecompressionBomb(4032, 3024, MAX_PIXELS)).toBe(false)
    expect(isDecompressionBomb(7000, 5000, MAX_PIXELS_UNSCALED)).toBe(true)
    expect(isDecompressionBomb(7000, 5000, MAX_PIXELS)).toBe(false)
    expect(isDecompressionBomb(4000, 6000, MAX_PIXELS_UNSCALED)).toBe(false)
  })

  it('uses the 24 MP cap on WebKit and when resize does not work', () => {
    expect(pixelCap({ webkit: true, resizeWorks: true })).toBe(MAX_PIXELS_UNSCALED)
    expect(pixelCap({ webkit: true, resizeWorks: false })).toBe(MAX_PIXELS_UNSCALED)
    expect(pixelCap({ webkit: false, resizeWorks: false })).toBe(MAX_PIXELS_UNSCALED)
    expect(pixelCap({ webkit: false, resizeWorks: true })).toBe(MAX_PIXELS)
  })
})

describe('bitmap resize', () => {
  it('decodes straight to the 4000px target when resize is honored', async () => {
    const source = jpeg(8000, 4000)
    const target = targetSize(source.width, source.height)
    const close = vi.fn()
    const create = vi.fn(async (_blob: Blob, options?: ImageBitmapOptions) =>
      bitmap(options?.resizeWidth ?? source.width, options?.resizeHeight ?? source.height, close),
    )
    const read = vi.fn((image: BitmapLike) => ({
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(4),
    }))

    const decoded = await decodeImage(new Uint8Array([1, 2, 3, 4]), source, {
      environment: { webkit: false, resizeWorks: true },
      createImageBitmap: create,
      readBitmap: read,
    })

    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
    })
    expect(read).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(decoded.raster).toMatchObject({ width: 4000, height: 2000 })
    expect(decoded.upright).toBe(true)
  })

  it('requests the oriented target size for a sideways photo', async () => {
    const oriented = orientedDimensions(4032, 3024, 6)
    const target = targetSize(oriented.width, oriented.height)
    const create = vi.fn(async (_blob: Blob, options?: ImageBitmapOptions) =>
      bitmap(options?.resizeWidth ?? 1, options?.resizeHeight ?? 1),
    )

    await decodeImage(new Uint8Array([1]), jpeg(4032, 3024, 6), {
      environment: { webkit: false, resizeWorks: true },
      createImageBitmap: create,
      readBitmap: (image) => ({ width: image.width, height: image.height, data: new Uint8ClampedArray(4) }),
    })

    expect(create.mock.calls[0]?.[1]).toMatchObject({
      resizeWidth: target.width,
      resizeHeight: target.height,
    })
    expect(target).toEqual({ width: 3000, height: 4000 })
  })

  it('refuses a photo over 24 MP before decoding when resize is unavailable', async () => {
    const create = vi.fn()
    await expect(
      decodeImage(new Uint8Array([1]), jpeg(7000, 5000), {
        environment: { webkit: false, resizeWorks: false },
        createImageBitmap: create,
      }),
    ).rejects.toThrow(BOMB_MESSAGE)
    expect(create).not.toHaveBeenCalled()
  })

  it('downscales a 4032×3024 photo when the browser cannot resize during decode', async () => {
    const create = vi.fn(async (_blob: Blob, _options?: ImageBitmapOptions) => bitmap(4032, 3024))
    const decoded = await decodeImage(pngHeader(4032, 3024), jpeg(4032, 3024), {
      environment: { webkit: false, resizeWorks: false },
      createImageBitmap: create,
      readBitmap: (image) => ({
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.width * image.height * 4),
      }),
    })

    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('resizeWidth')
    expect(decoded.raster.width).toBe(4000)
    expect(decoded.raster.height).toBe(3000)
  })

  it('closes a bitmap that ignored resize and refuses it above 24 MP', async () => {
    const close = vi.fn()
    const read = vi.fn()
    const create = vi.fn(async (_blob: Blob, _options?: ImageBitmapOptions) => bitmap(7000, 5000, close))

    await expect(
      decodeImage(new Uint8Array([1]), jpeg(7000, 5000), {
        environment: { webkit: false, resizeWorks: true },
        createImageBitmap: create,
        readBitmap: read,
      }),
    ).rejects.toThrow(BOMB_MESSAGE)

    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 4000, resizeQuality: 'high' })
    expect(close).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })

  it('closes an oversized bitmap even when the header is under 24 MP', async () => {
    const close = vi.fn()
    const create = vi.fn(async (_blob: Blob, _options?: ImageBitmapOptions) => bitmap(8000, 4000, close))

    await expect(
      decodeImage(new Uint8Array([1]), jpeg(1000, 800), {
        environment: { webkit: false, resizeWorks: true },
        createImageBitmap: create,
      }),
    ).rejects.toThrow(BOMB_MESSAGE)

    expect(create).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a bitmap that ignored resize and downscales it within 24 MP', async () => {
    const events: string[] = []
    let calls = 0
    const create = vi.fn(async (_blob: Blob, options?: ImageBitmapOptions) => {
      calls += 1
      events.push(options?.resizeWidth ? `resize:${options.resizeWidth}` : 'full')
      return bitmap(4032, 3024, () => {
        events.push(`close:${calls}`)
      })
    })
    const read = vi.fn((image: BitmapLike) => {
      events.push(`read:${image.width}`)
      return {
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.width * image.height * 4),
      }
    })

    const decoded = await decodeImage(new Uint8Array([1]), jpeg(4032, 3024), {
      environment: { webkit: false, resizeWorks: true },
      createImageBitmap: create,
      readBitmap: read,
    })

    expect(events.slice(0, 4)).toEqual(['resize:4000', 'close:1', 'full', 'read:4032'])
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]?.[1]).not.toHaveProperty('resizeWidth')
    expect(decoded.raster).toMatchObject({ width: 4000, height: 3000 })
  })

  it('applies the 24 MP header cap on WebKit before decoding', async () => {
    const create = vi.fn()
    const header = pngHeader(7000, 5000)
    expect(inspectImage(header)).toMatchObject({ ok: true, width: 7000, height: 5000 })

    await expect(
      decodeImage(header, jpeg(7000, 5000), {
        environment: { webkit: true, resizeWorks: true },
        createImageBitmap: create,
      }),
    ).rejects.toThrow(BOMB_MESSAGE)
    expect(create).not.toHaveBeenCalled()

    const decode = vi.fn()
    await expect(
      preparePhoto(header, decode, { environment: { webkit: true, resizeWorks: true } }),
    ).rejects.toThrow(BOMB_MESSAGE)
    expect(decode).not.toHaveBeenCalled()
  })

  it('still decodes a 12 MP photo on WebKit and asks for a resized bitmap', async () => {
    const create = vi.fn(async (_blob: Blob, options?: ImageBitmapOptions) =>
      bitmap(options?.resizeWidth ?? 4032, options?.resizeHeight ?? 3024),
    )
    const decoded = await decodeImage(pngHeader(4032, 3024), jpeg(4032, 3024), {
      environment: { webkit: true, resizeWorks: true },
      createImageBitmap: create,
      readBitmap: (image) => ({ width: image.width, height: image.height, data: new Uint8ClampedArray(4) }),
    })

    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 4000, resizeHeight: 3000, resizeQuality: 'high' })
    expect(decoded.raster.width).toBe(4000)
    expect(decoded.raster.height).toBe(3000)
  })
})

describe('resize probe', () => {
  it('reports support only when the bitmap comes back at the requested size', async () => {
    const source = new Blob(['probe'])
    await expect(
      probeBitmapResize(async () => bitmap(4, 2), source),
    ).resolves.toBe(true)
    await expect(
      probeBitmapResize(async () => bitmap(8, 4), source),
    ).resolves.toBe(false)
    await expect(
      probeBitmapResize(async () => {
        throw new Error('unsupported options')
      }, source),
    ).resolves.toBe(false)
  })
})

describe('WebKit detection', () => {
  it('treats Safari and iOS browsers as WebKit and desktop Chromium as resize-capable', () => {
    expect(
      isWebKitUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe(true)
    expect(
      isWebKitUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(true)
    expect(
      isWebKitUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe(false)
  })
})
