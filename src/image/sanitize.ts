const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])

const ALLOWED_ATTRIBUTES = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'clip-rule',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'transform',
  'preserveaspectratio',
  'version',
])

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const UNSAFE_SVG_MESSAGE = "Couldn't make a safe SVG from this photo."

/**
 * Rebuild an SVG from an allowlist. Scripts, event handlers, foreignObject,
 * embedded images, external URLs, metadata, title, desc, and comments are dropped.
 */
export function sanitizeSvg(svg: string): string {
  const parser = new SvgParser(svg)
  const output = parser.parse()
  assertSafe(output)
  return output
}

class SvgParser {
  private readonly source: string
  private index = 0

  constructor(source: string) {
    this.source = source
  }

  parse(): string {
    this.skipIgnorable()
    const root = this.readElement()
    if (!root || root.tag !== 'svg') {
      throw new Error(UNSAFE_SVG_MESSAGE)
    }
    return root.markup
  }

  private readElement(): { tag: string; markup: string } | null {
    this.skipIgnorable()
    if (this.index >= this.source.length) return null
    if (this.source[this.index] !== '<') {
      this.skipText()
      return this.readElement()
    }
    if (this.source.startsWith('</', this.index)) {
      return null
    }
    const tag = this.readTag()
    if (!tag) {
      throw new Error(UNSAFE_SVG_MESSAGE)
    }
    if (!ALLOWED_TAGS.has(tag.name)) {
      if (!tag.selfClosing) this.skipSubtree(tag.name)
      return this.readElement()
    }
    const attributes = this.filterAttributes(tag.attributes)
    if (tag.selfClosing) {
      return { tag: tag.name, markup: `<${tag.name}${attributes}/>` }
    }
    const children: string[] = []
    for (;;) {
      this.skipIgnorable()
      if (this.source.startsWith('</', this.index)) {
        const close = this.readClose()
        if (close !== tag.name) {
          throw new Error(UNSAFE_SVG_MESSAGE)
        }
        break
      }
      if (this.index >= this.source.length) break
      const child = this.readElement()
      if (!child) break
      children.push(child.markup)
    }
    return { tag: tag.name, markup: `<${tag.name}${attributes}>${children.join('')}</${tag.name}>` }
  }

  private readTag(): { name: string; attributes: Attribute[]; selfClosing: boolean } | null {
    if (this.source[this.index] !== '<') return null
    this.index += 1
    const name = this.readName()
    if (!name) return null
    const attributes: Attribute[] = []
    for (;;) {
      this.skipSpaces()
      if (this.startsWith('/>')) {
        this.index += 2
        return { name: name.toLowerCase(), attributes, selfClosing: true }
      }
      if (this.source[this.index] === '>') {
        this.index += 1
        return { name: name.toLowerCase(), attributes, selfClosing: false }
      }
      const attribute = this.readAttribute()
      if (!attribute) return null
      attributes.push(attribute)
    }
  }

  private readAttribute(): Attribute | null {
    const name = this.readName()
    if (!name) return null
    this.skipSpaces()
    if (this.source[this.index] !== '=') return null
    this.index += 1
    this.skipSpaces()
    const quote = this.source[this.index]
    if (quote !== '"' && quote !== "'") return null
    this.index += 1
    const start = this.index
    while (this.index < this.source.length && this.source[this.index] !== quote) {
      this.index += 1
    }
    if (this.source[this.index] !== quote) return null
    const value = this.source.slice(start, this.index)
    this.index += 1
    return { name, value: decodeEntities(value) }
  }

  private readClose(): string {
    this.index += 2
    const name = this.readName()
    this.skipSpaces()
    if (this.source[this.index] === '>') this.index += 1
    return name.toLowerCase()
  }

  private skipSubtree(name: string): void {
    let depth = 1
    while (this.index < this.source.length && depth > 0) {
      const next = this.source.indexOf('<', this.index)
      if (next === -1) {
        this.index = this.source.length
        return
      }
      this.index = next
      if (this.startsWith('<!--')) {
        this.skipComment()
        continue
      }
      if (this.startsWith('</')) {
        const close = this.readClose()
        if (close === name) depth -= 1
        continue
      }
      const tag = this.readTag()
      if (!tag) return
      if (!tag.selfClosing && tag.name === name) depth += 1
    }
  }

  private skipIgnorable(): void {
    for (;;) {
      const start = this.index
      this.skipSpaces()
      if (this.startsWith('<!--')) {
        this.skipComment()
      } else if (this.startsWith('<?')) {
        const end = this.source.indexOf('?>', this.index)
        this.index = end === -1 ? this.source.length : end + 2
      } else if (this.startsWith('<!')) {
        const end = this.source.indexOf('>', this.index)
        this.index = end === -1 ? this.source.length : end + 1
      }
      if (this.index === start) return
    }
  }

  private skipComment(): void {
    const end = this.source.indexOf('-->', this.index + 4)
    this.index = end === -1 ? this.source.length : end + 3
  }

  private skipText(): void {
    const next = this.source.indexOf('<', this.index)
    this.index = next === -1 ? this.source.length : next
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? '')) {
      this.index += 1
    }
  }

  private readName(): string {
    const start = this.index
    while (this.index < this.source.length && /[A-Za-z0-9:._-]/.test(this.source[this.index] ?? '')) {
      this.index += 1
    }
    return this.source.slice(start, this.index)
  }

  private startsWith(value: string): boolean {
    return this.source.startsWith(value, this.index)
  }

  private filterAttributes(attributes: Attribute[]): string {
    let markup = ''
    for (const attribute of attributes) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name)) continue
      if (!valueIsSafe(name, attribute.value)) continue
      markup += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
    }
    return markup
  }
}

type Attribute = { name: string; value: string }

function valueIsSafe(name: string, value: string): boolean {
  if (name === 'xmlns') return value === SVG_NAMESPACE
  const normalized = value.replace(/\s+/g, '').toLowerCase()
  if (normalized.includes('javascript:')) return false
  if (normalized.includes('data:')) return false
  if (normalized.includes('http:') || normalized.includes('https:')) return false
  if (normalized.includes('//')) return false
  if (normalized.includes('url(')) return false
  if (normalized.includes('<') || normalized.includes('>')) return false
  return true
}

function assertSafe(svg: string): void {
  const forbidden =
    /<script|<foreignobject|<image|<metadata|<title|<desc|<!--|<!doctype|<iframe|\son[a-z]+\s*=|javascript:|data:|base64|xlink:href|foreignobject/i
  if (forbidden.test(svg) || !svg.startsWith('<svg')) {
    throw new Error(UNSAFE_SVG_MESSAGE)
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
