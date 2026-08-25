/**
 * Atlas packing.
 *
 * Unglamorous but load-bearing: overlapping rects silently corrupt frames, and
 * missing padding lets bilinear filtering bleed a neighbour's pixels into a
 * sprite's edge — which on a 96-frame character atlas shows up as coloured
 * fringes down the side of every soldier.
 *
 * The algorithm is shelf packing over a height-sorted list. It is not the
 * tightest packer in existence, but the input here is ~100 rects of two size
 * classes (150x210 soldier frames and ~1000px props), where a shelf packer is
 * within a few percent of optimal, and it has the two properties that matter
 * more than density: it is trivially verifiable as non-overlapping, and it is
 * deterministic and independent of input order, so a reordered manifest can
 * never silently reshuffle the atlas and invalidate every cached UV.
 */

import { PackError } from './errors'

export { PackError }

export interface PackInput {
  readonly id: string
  readonly width: number
  readonly height: number
}

export interface Placement {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PackOptions {
  /** Hard limit on both atlas dimensions (4096 is the GPU floor we target). */
  readonly maxSize: number
  /** Minimum gap left between any two rects, and around the atlas edge. */
  readonly padding: number
}

export interface PackResult {
  readonly width: number
  readonly height: number
  readonly placements: Placement[]
}

/** Powers of two from 64 up to `maxSize`, plus `maxSize` itself if it is not one. */
function candidateWidths(maxSize: number): number[] {
  const out: number[] = []
  for (let w = 64; w < maxSize; w *= 2) out.push(w)
  out.push(maxSize)
  return out
}

/**
 * Shelf-pack the (already sorted) padded boxes into a strip `width` wide.
 * Returns the used height, or null if any box is too wide for the strip.
 */
function shelfPack(
  boxes: readonly { input: PackInput; boxW: number; boxH: number }[],
  width: number,
): { height: number; positions: { id: string; x: number; y: number }[] } | null {
  const positions: { id: string; x: number; y: number }[] = []
  let shelfY = 0
  let shelfH = 0
  let cursorX = 0

  for (const box of boxes) {
    if (box.boxW > width) return null
    if (cursorX + box.boxW > width) {
      shelfY += shelfH
      shelfH = 0
      cursorX = 0
    }
    positions.push({ id: box.input.id, x: cursorX, y: shelfY })
    cursorX += box.boxW
    if (box.boxH > shelfH) shelfH = box.boxH
  }
  return { height: shelfY + shelfH, positions }
}

/**
 * Place every rect, or throw.
 *
 * Padding is applied by packing each rect inside a box `padding` wider and
 * taller than itself and seating the rect at the box's top-left. Two
 * non-overlapping boxes are therefore always at least `padding` apart along at
 * least one axis, and the strip origin is offset by `padding` so the outermost
 * rects also keep a gap from the atlas edge.
 */
export function packRects(rects: readonly PackInput[], options: PackOptions): PackResult {
  const { maxSize, padding } = options
  if (rects.length === 0) return { width: 0, height: 0, placements: [] }

  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) {
      throw new PackError(
        `rect "${r.id}" has a non-positive size (${String(r.width)}x${String(r.height)})`,
      )
    }
    if (r.width + 2 * padding > maxSize || r.height + 2 * padding > maxSize) {
      throw new PackError(
        `rect "${r.id}" (${String(r.width)}x${String(r.height)}) does not fit in a ` +
          `${String(maxSize)}x${String(maxSize)} atlas with ${String(padding)}px padding`,
      )
    }
  }

  // Sorted tallest-first, then widest, then by id: a total order, so the result
  // depends on the SET of rects and never on the order they arrived in.
  const boxes = rects
    .map((input) => ({ input, boxW: input.width + padding, boxH: input.height + padding }))
    .sort(
      (a, b) =>
        b.boxH - a.boxH ||
        b.boxW - a.boxW ||
        (a.input.id < b.input.id ? -1 : a.input.id > b.input.id ? 1 : 0),
    )

  let best: { width: number; height: number; positions: { id: string; x: number; y: number }[] } | null =
    null

  for (const stripWidth of candidateWidths(maxSize)) {
    // `padding` of the strip width is spent on the left/top margin.
    const usable = stripWidth - padding
    if (usable <= 0) continue
    const packed = shelfPack(boxes, usable)
    if (!packed) continue
    // The height is the content height, NOT rounded up to a power of two.
    // Rounding cost 1675 empty rows on the real asset set (content ends at
    // y=2421, POT would be 4096) — 32.0 MB of VRAM against 18.9 MB tight, and
    // worse again with mipmaps. WebGL2 samples NPOT textures fine under
    // CLAMP_TO_EDGE, which is what this atlas uses; the one texture that must
    // genuinely wrap is the floor tile, and that is emitted separately.
    // The candidate widths stay powers of two, which costs nothing here (the
    // strip is filled either way) and keeps the width friendly to any driver
    // that still prefers it.
    const height = packed.height + padding
    if (height > maxSize) continue
    const area = stripWidth * height
    if (best === null || area < best.width * best.height) {
      best = { width: stripWidth, height, positions: packed.positions }
    }
  }

  if (best === null) {
    const total = rects.reduce((sum, r) => sum + (r.width + padding) * (r.height + padding), 0)
    throw new PackError(
      `cannot pack ${String(rects.length)} rects (${String(total)}px² padded) into ` +
        `${String(maxSize)}x${String(maxSize)}`,
    )
  }

  const byId = new Map(boxes.map((b) => [b.input.id, b.input]))
  const placements = best.positions.map((p) => {
    const input = byId.get(p.id)
    /* c8 ignore next */
    if (!input) throw new PackError(`internal: lost rect "${p.id}" during packing`)
    return { id: p.id, x: p.x + padding, y: p.y + padding, width: input.width, height: input.height }
  })

  return { width: best.width, height: best.height, placements }
}
