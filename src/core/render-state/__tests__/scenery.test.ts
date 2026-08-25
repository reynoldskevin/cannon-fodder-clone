import { describe, it, expect } from 'vitest'
import { canopyScenery, treeVariantFor, tileJitter, TREE_VARIANTS } from '../scenery'

/**
 * Ticket 010a — scenery derived from the terrain itself.
 *
 * The source map draws dense jungle; the importer turned that into ~1000
 * blocked "canopy" tiles. Those tiles are where the tree art belongs. The
 * level's `tree` annotation is a separate gameplay marker with no asset yet.
 */

const CANOPY = 2
const GRASS = 1

/** A level of `w x h` tiles, all `fill`, with `canopyAt` overriding to canopy. */
function level(w: number, h: number, canopyAt: (x: number, y: number) => boolean, fill = GRASS) {
  const terrain: number[][] = []
  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) row.push(canopyAt(x, y) ? CANOPY : fill)
    terrain.push(row)
  }
  return { size: { w, h }, terrain }
}

describe('canopyScenery', () => {
  it('produces one tree per canopy tile', () => {
    const lvl = level(4, 4, (x, y) => x === 0 && y === 0)
    expect(canopyScenery(lvl)).toHaveLength(1)
  })

  it('produces nothing for a level with no canopy', () => {
    expect(canopyScenery(level(6, 6, () => false))).toEqual([])
  })

  it('ignores grass, rock and unknown tiles', () => {
    const lvl = level(3, 1, () => false, GRASS)
    lvl.terrain[0] = [0, 1, 3] // unknown, grass, rock — none are canopy
    expect(canopyScenery(lvl)).toEqual([])
  })

  it('covers every canopy tile of a solid mass', () => {
    const lvl = level(10, 10, (x, y) => x >= 2 && x < 6 && y >= 2 && y < 6)
    expect(canopyScenery(lvl)).toHaveLength(16)
  })

  it('places each tree within its own tile', () => {
    const lvl = level(8, 8, (x, y) => x === 3 && y === 5)
    const t = canopyScenery(lvl)[0]!
    expect(t.tileX).toBe(3)
    expect(t.tileY).toBe(5)
    expect(Math.abs(t.jitterX)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(t.jitterY)).toBeLessThanOrEqual(0.5)
  })

  it('gives every tree one of the declared variants', () => {
    const lvl = level(12, 12, () => true)
    for (const t of canopyScenery(lvl)) {
      expect(TREE_VARIANTS).toContain(t.sprite)
    }
  })

  it('is deterministic — same level, same scenery', () => {
    const lvl = level(9, 9, (x, y) => (x + y) % 3 === 0)
    expect(canopyScenery(lvl)).toEqual(canopyScenery(lvl))
  })

  it('gives every tree a distinct id', () => {
    const lvl = level(10, 10, () => true)
    const ids = canopyScenery(lvl).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('treeVariantFor', () => {
  it('is deterministic for a tile', () => {
    expect(treeVariantFor(4, 7)).toBe(treeVariantFor(4, 7))
  })

  it('returns a declared variant for any tile', () => {
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) expect(TREE_VARIANTS).toContain(treeVariantFor(x, y))
    }
  })

  it('uses all three variants across a field', () => {
    const seen = new Set<string>()
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) seen.add(treeVariantFor(x, y))
    expect(seen.size).toBe(3)
  })

  it('spreads variants reasonably evenly', () => {
    const counts = new Map<string, number>()
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const v = treeVariantFor(x, y)
        counts.set(v, (counts.get(v) ?? 0) + 1)
      }
    }
    for (const v of TREE_VARIANTS) {
      // 1600 tiles over 3 variants ~ 533 each; no variant should be rare.
      expect(counts.get(v)!).toBeGreaterThan(300)
    }
  })

  it('does not stripe — neighbours are not always the same variant', () => {
    let differing = 0
    for (let x = 0; x < 40; x++) if (treeVariantFor(x, 0) !== treeVariantFor(x + 1, 0)) differing++
    expect(differing).toBeGreaterThan(10)
  })
})

describe('tileJitter', () => {
  it('is deterministic for a tile', () => {
    expect(tileJitter(3, 9)).toEqual(tileJitter(3, 9))
  })

  it('stays inside the tile', () => {
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 25; x++) {
        const j = tileJitter(x, y)
        expect(Math.abs(j.x)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(j.y)).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('differs between neighbouring tiles, so the canopy is not a grid', () => {
    const a = tileJitter(5, 5), b = tileJitter(6, 5), c = tileJitter(5, 6)
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('actually displaces — it is not all zeroes', () => {
    let moved = 0
    for (let i = 0; i < 100; i++) {
      const j = tileJitter(i, i * 3)
      if (Math.abs(j.x) > 0.05 || Math.abs(j.y) > 0.05) moved++
    }
    expect(moved).toBeGreaterThan(80)
  })

  it('produces finite values', () => {
    for (let i = 0; i < 50; i++) {
      const j = tileJitter(i, 100 - i)
      expect(Number.isFinite(j.x)).toBe(true)
      expect(Number.isFinite(j.y)).toBe(true)
    }
  })
})
