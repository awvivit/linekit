import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from './sanitize.ts'

const SECRET = 'vacation-gps-photo.jpg GPS 37.8199,-122.4783'

describe('sanitizeSvg', () => {
  it('strips scripts, handlers, foreignObject, images, metadata, and comments', () => {
    const dirty = `
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)" desc="Created with imagetracer.js">
        <!-- ${SECRET} -->
        <metadata>${SECRET}</metadata>
        <title>${SECRET}</title>
        <desc>${SECRET}</desc>
        <script>alert('${SECRET}')</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">${SECRET}</div></foreignObject>
        <image href="https://evil.example/pixel.png" xlink:href="data:image/png;base64,AAAA${SECRET}" />
        <path fill="rgb(0,0,0)" d="M0 0 L10 0 L10 10 Z" />
        <a href="javascript:alert(1)"><path d="M0 0 L1 1" /></a>
      </svg>
    `
    const clean = sanitizeSvg(dirty)
    expect(clean).toContain('<path')
    expect(clean).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(clean.toLowerCase()).not.toContain('<script')
    expect(clean.toLowerCase()).not.toContain('foreignobject')
    expect(clean.toLowerCase()).not.toContain('<image')
    expect(clean.toLowerCase()).not.toContain('<metadata')
    expect(clean.toLowerCase()).not.toContain('<title')
    expect(clean.toLowerCase()).not.toContain('<desc')
    expect(clean).not.toContain('<!--')
    expect(clean.toLowerCase()).not.toContain('onload')
    expect(clean.toLowerCase()).not.toContain('javascript:')
    expect(clean.toLowerCase()).not.toContain('base64')
    expect(clean.toLowerCase()).not.toContain('data:')
    expect(clean).not.toContain('xlink:href')
    expect(clean).not.toContain('https://evil.example')
    expect(clean).not.toContain(SECRET)
    expect(clean).not.toContain('imagetracer')
  })
})
