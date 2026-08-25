import { describe, it, expect } from 'vitest'
import { packRects, PackError } from '../pack'

/**
 * Ticket 004 — atlas packing.
 *
 * Correctness here is unglamorous but load-bearing: overlapping rects silently
 * corrupt frames, and missing padding lets bilinear filtering bleed a
 * neighbour's pixels into a sprite's edge — which on a 96-frame character atlas
 * shows up as coloured fringes on soldiers.
 */

const rects = (n: number, w: number, h: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, width: w, height: h }))

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
         a.y < b.y + b.height && b.y < a.y + a.height
}

describe('packRects', () => {
  it('places every rect', () => {
    const out = packRects(rects(20, 40, 30), { maxSize: 1024, padding: 2 })
    expect(out.placements).toHaveLength(20)
  })

  it('never overlaps two rects', () => {
    const out = packRects(rects(60, 50, 40), { maxSize: 2048, padding: 2 })
    for (let i = 0; i < out.placements.length; i++) {
      for (let j = i + 1; j < out.placements.length; j++) {
        expect(overlaps(out.placements[i]!, out.placements[j]!)).toBe(false)
      }
    }
  })

  it('keeps at least `padding` between neighbours', () => {
    const padding = 4
    const out = packRects(rects(30, 40, 40), { maxSize: 1024, padding })
    for (let i = 0; i < out.placements.length; i++) {
      for (let j = i + 1; j < out.placements.length; j++) {
        const a = out.placements[i]!, b = out.placements[j]!
        const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width))
        const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height))
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(padding)
      }
    }
  })

  it('keeps every rect inside the reported atlas size', () => {
    const out = packRects(rects(40, 60, 50), { maxSize: 2048, padding: 2 })
    for (const p of out.placements) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.width).toBeLessThanOrEqual(out.width)
      expect(p.y + p.height).toBeLessThanOrEqual(out.height)
    }
  })

  it('never exceeds maxSize', () => {
    const out = packRects(rects(50, 90, 90), { maxSize: 1024, padding: 2 })
    expect(out.width).toBeLessThanOrEqual(1024)
    expect(out.height).toBeLessThanOrEqual(1024)
  })

  it('is deterministic — same input, same placements', () => {
    const input = rects(45, 37, 53)
    const a = packRects(input, { maxSize: 2048, padding: 2 })
    const b = packRects(input, { maxSize: 2048, padding: 2 })
    expect(b).toEqual(a)
  })

  it('does not depend on input array order', () => {
    // A stable sort inside the packer means a reordered manifest cannot
    // silently reshuffle the atlas and invalidate every cached UV.
    const input = rects(30, 44, 61)
    const a = packRects(input, { maxSize: 2048, padding: 2 })
    const b = packRects([...input].reverse(), { maxSize: 2048, padding: 2 })
    const key = (p: { id: string; x: number; y: number }) => `${p.id}@${p.x},${p.y}`
    expect(new Set(b.placements.map(key))).toEqual(new Set(a.placements.map(key)))
  })

  it('throws PackError rather than dropping rects that do not fit', () => {
    expect(() => packRects(rects(200, 500, 500), { maxSize: 512, padding: 2 }))
      .toThrow(PackError)
  })

  it('throws PackError when a single rect exceeds maxSize', () => {
    expect(() => packRects([{ id: 'big', width: 900, height: 20 }], { maxSize: 512, padding: 2 }))
      .toThrow(PackError)
  })

  it('handles an empty input without inventing an atlas', () => {
    const out = packRects([], { maxSize: 1024, padding: 2 })
    expect(out.placements).toEqual([])
  })

  it('packs rects of wildly differing sizes', () => {
    // The real set mixes ~150x210 soldier frames with ~980x960 props.
    const mixed = [
      ...rects(96, 150, 210),
      { id: 'tree1', width: 647, height: 967 },
      { id: 'bush', width: 978, height: 958 },
    ]
    const out = packRects(mixed, { maxSize: 4096, padding: 2 })
    expect(out.placements).toHaveLength(98)
    for (let i = 0; i < out.placements.length; i++) {
      for (let j = i + 1; j < out.placements.length; j++) {
        expect(overlaps(out.placements[i]!, out.placements[j]!)).toBe(false)
      }
    }
  })
})
