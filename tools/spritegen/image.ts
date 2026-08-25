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
 * Alpha below which a pixel counts as "mostly matte" for `lightMatteFraction`,
 * and the per-channel level at which a pixel counts as near-white.
 */
const MATTE_PROBE_ALPHA = 128
const NEAR_WHITE = 200

/**
 * Fraction of an image's low-alpha antialiased pixels that are near-white.
 *
 * This is the fingerprint of art that was flattened over a light background
 * before its alpha channel was cut: the antialiased rim of the silhouette is a
 * blend of the subject with the backdrop, so a white backdrop leaves white RGB
 * sitting under partial alpha. Over the atlas's own transparent field that is
 * invisible; composited over the dark jungle terrain in game it is a white halo
 * round the whole silhouette.
 *
 * Measured on the supplied art the statistic separates cleanly — 0.56/0.93 for
 * the matted sheets and props, exactly 0.0000 for the one sheet that is clean —
 * so `LIGHT_MATTE_THRESHOLD` sits in a very wide empty gap rather than on a
 * tuned edge.
 */
export function lightMatteFraction(src: RgbaImage): number {
  let total = 0
  let white = 0
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] ?? 0
    if (a === 0 || a >= MATTE_PROBE_ALPHA) continue
    total++
    const r = src.data[i] ?? 0
    const g = src.data[i + 1] ?? 0
    const b = src.data[i + 2] ?? 0
    if (r > NEAR_WHITE && g > NEAR_WHITE && b > NEAR_WHITE) white++
  }
  return total === 0 ? 0 : white / total
}

/** Above this, an image is treated as light-matted. See `lightMatteFraction`. */
export const LIGHT_MATTE_THRESHOLD = 0.1

/**
 * Replace the RGB of every partially transparent pixel with the RGB of its
 * nearest fully opaque pixel. Alpha is never read as anything but a mask and
 * never written, so the silhouette is bit-identical afterwards.
 *
 * Why this and not the algebraic un-matte `true = (observed - (1-a)*255) / a`:
 * that formula assumes alpha is exactly the backdrop's coverage, and on this art
 * it is not — the mask was derived separately from the RGB, so pixels that are
 * pure 255,255,255 sit at alpha 70. White is a FIXED POINT of the un-matte (any
 * alpha maps 255 to 255), so those pixels survive it untouched. Measured, the
 * un-matte only moved the near-white share of the soldier's edge pixels from
 * 24.9% to 19.9% and the trees' from 45.6% to 14.1% — it does not remove the
 * halo. Both estimate the same thing (the subject's colour under the rim), but
 * the un-matte is *biased* wherever alpha understates coverage, whereas the
 * nearest opaque neighbour is only wrong by the subject's own colour gradient
 * over one or two pixels. So the neighbour wins on the merits, and it collapses
 * the near-white share to ~0%.
 *
 * It cannot desaturate the art: opaque pixels are never written, and a rim pixel
 * beside a legitimately light detail inherits that light detail's colour.
 *
 * The search is a multi-source BFS seeded from every opaque pixel in raster
 * order with a fixed neighbour order, so the result is deterministic — the atlas
 * is a committed artifact.
 */
export function bleedOpaqueColour(src: RgbaImage): MutableImage {
  const { width, height } = src
  const out = { width, height, data: new Uint8Array(src.data) }
  const count = width * height
  const from = new Int32Array(count).fill(-1)
  const queue = new Int32Array(count)
  let head = 0
  let tail = 0

  for (let p = 0; p < count; p++) {
    if (src.data[p * 4 + 3] === 255) {
      from[p] = p
      queue[tail++] = p
    }
  }
  // No opaque pixel to bleed from — nothing this function can say about colour.
  if (tail === 0) return out

  while (head < tail) {
    const p = queue[head++]!
    const x = p % width
    const y = (p - x) / width
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= height) continue
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= width) continue
        const np = ny * width + nx
        if (from[np] !== -1) continue
        from[np] = from[p]!
        queue[tail++] = np
      }
    }
  }

  for (let p = 0; p < count; p++) {
    const a = src.data[p * 4 + 3] ?? 0
    if (a === 0 || a === 255) continue
    const s = (from[p] ?? -1) * 4
    if (s < 0) continue
    out.data[p * 4] = src.data[s] ?? 0
    out.data[p * 4 + 1] = src.data[s + 1] ?? 0
    out.data[p * 4 + 2] = src.data[s + 2] ?? 0
  }
  return out
}

/** Why an image was or was not de-matted. Reported so the choice is auditable. */
export type MatteReason = 'score' | 'override'

/** The de-matte decision for one source image. Surfaced in `BuildResult`. */
export interface MatteDecision {
  /** The asset id, e.g. `soldier/walk` or `prop/tree1`. */
  readonly id: string
  /** `lightMatteFraction` for this image, always measured even when overridden. */
  readonly score: number
  /** True when `bleedOpaqueColour` was applied. */
  readonly bled: boolean
  /** `override` when a `BuildOptions.matte` entry decided it, else `score`. */
  readonly reason: MatteReason
}

/**
 * Strip a baked-in light matte from `src` if it has one, otherwise hand back
 * `src` untouched. Always reports what it decided and why.
 *
 * Detection is per image and not a blanket rule because the supplied art is
 * mixed: the walk and die sheets and all four props are matted, the fire sheet
 * is not. The fire sheet also carries genuinely soft semi-transparent content
 * (muzzle smoke reaching 53px from the nearest opaque pixel, against 1-3px of
 * plain antialiasing on the matted art), so bleeding it would flatten real
 * artwork to fix a problem it does not have.
 *
 * The heuristic is deliberately simple, and it has two known blind spots. A
 * genuinely white soft-edged sprite — smoke, a muzzle flash, a cloud — scores
 * 1.0 by construction and would be bled flat, which is exactly the damage
 * excluding the fire sheet avoids. And `NEAR_WHITE` is a hard cliff: a matte
 * laid over grey 200 scores 0.00 while grey 201 scores 1.00, so an off-white
 * matte keeps its halo. Rather than chase a cleverer detector, `override` lets
 * a caller settle either case per asset, and the returned decision (logged by
 * `build:models`) means the automatic choice is never invisible. On today's
 * seven assets the two populations are 0.00 against 0.56-0.93, so the automatic
 * path is not close to either failure.
 *
 * Must run BEFORE any downscale, so the box filter averages corrected colours
 * instead of smearing the matte further into the sprite.
 */
export function stripLightMatte(
  id: string,
  src: RgbaImage,
  override?: boolean,
): { image: RgbaImage; decision: MatteDecision } {
  const score = lightMatteFraction(src)
  const bled = override ?? score > LIGHT_MATTE_THRESHOLD
  return {
    image: bled ? bleedOpaqueColour(src) : src,
    decision: { id, score, bled, reason: override === undefined ? 'score' : 'override' },
  }
}

/**
 * Area-average (box filter) resample of `rect` from `src` into a `dstW x dstH`
 * image.
 *
 * Averaging is done on PREMULTIPLIED alpha and un-premultiplied afterwards.
 * Averaging straight RGB would pull the (arbitrary) colour of fully transparent
 * pixels into every antialiased edge — black on the soldier sheets, white on the
 * props — producing a halo round every sprite at exactly the edges the artist
 * antialiased to hide.
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
