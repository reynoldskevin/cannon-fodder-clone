import zlib from 'node:zlib'

/**
 * A minimal PNG *encoder* used to build test fixtures.
 *
 * Deliberately independent of whatever decoder the importer uses: a fixture
 * built here and read back by the importer exercises a real encode/decode
 * round-trip rather than two halves of the same assumption. Emits 8-bit
 * non-interlaced truecolour (colour type 2), which is what the real map assets are.
 */

export type RGB = readonly [number, number, number]

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A blank canvas of `fill`, ready to draw markers onto. */
export function canvas(width: number, height: number, fill: RGB): Buffer {
  const buf = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0]
    buf[i * 3 + 1] = fill[1]
    buf[i * 3 + 2] = fill[2]
  }
  return buf
}

export function setPixel(
  data: Buffer, width: number, x: number, y: number, rgb: RGB,
): void {
  const i = (y * width + x) * 3
  data[i] = rgb[0]
  data[i + 1] = rgb[1]
  data[i + 2] = rgb[2]
}

export function fillRect(
  data: Buffer, width: number,
  x0: number, y0: number, w: number, h: number, rgb: RGB,
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPixel(data, width, x, y, rgb)
  }
}

/**
 * Draw a crosshair glyph matching the real asset's convention: a 25x25 square
 * footprint made of a ring plus centre cross, centred on (cx, cy).
 */
export function drawCrosshair(
  data: Buffer, width: number, cx: number, cy: number, rgb: RGB, size = 25,
): void {
  const r = Math.floor(size / 2)
  for (let d = -r; d <= r; d++) {
    setPixel(data, width, cx + d, cy, rgb) // horizontal arm
    setPixel(data, width, cx, cy + d, rgb) // vertical arm
    // ring
    setPixel(data, width, cx + d, cy - r, rgb)
    setPixel(data, width, cx + d, cy + r, rgb)
    setPixel(data, width, cx - r, cy + d, rgb)
    setPixel(data, width, cx + r, cy + d, rgb)
  }
}

/**
 * Draw a text-label-shaped blob: wide and short, to the right of a glyph.
 * The importer must discard these, never treat them as spawns.
 */
export function drawLabel(
  data: Buffer, width: number, x: number, cy: number, rgb: RGB,
  labelWidth = 30, labelHeight = 7,
): void {
  fillRect(data, width, x, cy - Math.floor(labelHeight / 2), labelWidth, labelHeight, rgb)
}

export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
