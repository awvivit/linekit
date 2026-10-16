export function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(offset)
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(offset, true)
}

export function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0)
  }
  return text
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const CRC_TABLE = new Uint32Array(256)
for (let value = 0; value < 256; value += 1) {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  CRC_TABLE[value] = crc
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0
    const tableIndex = (crc ^ byte) & 0xff
    crc = (CRC_TABLE[tableIndex] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
