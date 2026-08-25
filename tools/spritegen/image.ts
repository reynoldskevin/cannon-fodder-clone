/**
 * RGBA image plumbing for the sprite pipeline: decode, area-average downscale,
 * blit and edge extrusion.
 *
 * Decoding and encoding are delegated to `pngjs` (a devDependency — nothing
 * here ships to the browser). The game never parses a sheet at runtime; it
 * loads only what this pipeline emits.
 */

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { SpritegenError } from './errors'
import type { RgbaImage } from './slice'

export interface MutableImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export function blankImage(width: number, height: number): MutableImage {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

export function decodePngFile(path: string, what: string): RgbaImage {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (cause) {
    throw new SpritegenError(`${what} could not be read: ${path}`, { cause })
  }

  let png: PNG
  try {
    png = PNG.sync.read(raw)
  } catch (cause) {
    throw new SpritegenError(`${what} is not a readable PNG: ${path}`, { cause })
  }

  if (png.width <= 0 || png.height <= 0) {
    throw new SpritegenError(
      `${what} has zero extent (${String(png.width)}x${String(png.height)}): ${path}`,
    )
  }
  // pngjs always normalises to 8-bit RGBA, whatever the source colour type.
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  png.data.set(image.data)
  // Fixed deflate settings: the atlas is a committed artifact, so the bytes must
  // be reproducible across runs and machines, not merely equivalent as pixels.
  return PNG.sync.write(png, { deflateLevel: 9, deflateStrategy: 3, filterType: -1 })
}

/**
 * Area-average (box filter) resample of `rect` from `src` into a `dstW x dstH`
 * image.
 *
 * Averaging is done on PREMULTIPLIED alpha and un-premultiplied afterwards.
 * Averaging straight RGB would pull the (arbitrary) colour of fully transparent
 * pixels into every antialiased edge, which on this art — transparent black
 * surround — produces a dark halo round every soldier at exactly the edges the
 * artist antialiased to hide.
 */
export function resampleRegion(
  src: RgbaImage,
  rect: { originX: number; originY: number; width: number; height: number },
  dstW: number,
  dstH: number,
): MutableImage {
  const dst = blankImage(dstW, dstH)
  const sx = rect.width / dstW
  const sy = rect.height / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = dy * sy
    const y1 = (dy + 1) * sy
    const iy0 = Math.floor(y0)
    const iy1 = Math.min(rect.height, Math.ceil(y1))
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = dx * sx
      const x1 = (dx + 1) * sx
      const ix0 = Math.floor(x0)
      const ix1 = Math.min(rect.width, Math.ceil(x1))

      let r = 0, g = 0, b = 0, a = 0, wsum = 0
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        if (wy <= 0) continue
        const row = ((rect.originY + y) * src.width + rect.originX) * 4
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0)
          if (wx <= 0) continue
          const w = wx * wy
          const i = row + x * 4
          const alpha = (src.data[i + 3] ?? 0) / 255
          const pw = w * alpha
          r += (src.data[i] ?? 0) * pw
          g += (src.data[i + 1] ?? 0) * pw
          b += (src.data[i + 2] ?? 0) * pw
          a += alpha * w
          wsum += w
        }
      }

      const o = (dy * dstW + dx) * 4
      if (wsum <= 0 || a <= 0) continue
      const alphaAvg = a / wsum
      dst.data[o] = clamp255(r / (a || 1))
      dst.data[o + 1] = clamp255(g / (a || 1))
      dst.data[o + 2] = clamp255(b / (a || 1))
      dst.data[o + 3] = clamp255(alphaAvg * 255)
    }
  }
  return dst
}

function clamp255(v: number): number {
  const n = Math.round(v)
  return n < 0 ? 0 : n > 255 ? 255 : n
}

/** Copy the sub-rectangle `rect` of `src` into a new image. */
export function cropImage(
  src: RgbaImage,
  rect: { originX: number; originY: number; width: number; height: number },
): MutableImage {
  const dst = blankImage(rect.width, rect.height)
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.originY + y) * src.width + rect.originX) * 4
    dst.data.set(src.data.subarray(from, from + rect.width * 4), y * rect.width * 4)
  }
  return dst
}

/** Draw `src` into `dst` with its top-left at (x, y). */
export function blit(dst: MutableImage, src: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const from = row * src.width * 4
    dst.data.set(src.data.subarray(from, from + src.width * 4), ((y + row) * dst.width + x) * 4)
  }
}

/**
 * Repeat the outermost pixels of a placed rect outward into its padding.
 *
 * Padding alone stops a NEIGHBOUR bleeding in; extrusion stops the sprite's own
 * edge fading into transparent black when a texel sample straddles the boundary,
 * which is the standard fix for alpha fringing on a filtered atlas.
 */
export function extrudeEdges(
  dst: MutableImage,
  rect: { x: number; y: number; width: number; height: number },
  amount: number,
): void {
  const get = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, rect.x), rect.x + rect.width - 1)
    const cy = Math.min(Math.max(y, rect.y), rect.y + rect.height - 1)
    return (cy * dst.width + cx) * 4
  }
  for (let y = rect.y - amount; y < rect.y + rect.height + amount; y++) {
    if (y < 0 || y >= dst.height) continue
    for (let x = rect.x - amount; x < rect.x + rect.width + amount; x++) {
      if (x < 0 || x >= dst.width) continue
      const inside =
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
      if (inside) continue
      const s = get(x, y)
      const o = (y * dst.width + x) * 4
      dst.data[o] = dst.data[s] ?? 0
      dst.data[o + 1] = dst.data[s + 1] ?? 0
      dst.data[o + 2] = dst.data[s + 2] ?? 0
      dst.data[o + 3] = dst.data[s + 3] ?? 0
    }
  }
}
