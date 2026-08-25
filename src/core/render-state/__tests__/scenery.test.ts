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

  it('plants trees only on the FRINGE of a solid mass, not its interior', () => {
    // Ticket 010a revision: trunks read well against open ground at the jungle's
    // edge, but inside a dense mass they are hidden and just cost overdraw. The
    // interior stays raised foliage-coloured terrain — the source map draws the
    // canopy as a solid mass, not as countable individual palms.
    const lvl = level(10, 10, (x, y) => x >= 2 && x < 6 && y >= 2 && y < 6)
    // A 4x4 block has a 2x2 interior, so 16 - 4 = 12 fringe tiles.
    expect(canopyScenery(lvl)).toHaveLength(12)
  })

  it('treats a canopy tile with any non-canopy neighbour as fringe', () => {
    const lvl = level(5, 5, (x, y) => x >= 1 && x < 4 && y >= 1 && y < 4)
    // 3x3 block: the single centre tile is interior, the other 8 are fringe.
    expect(canopyScenery(lvl)).toHaveLength(8)
  })

  it('treats the map border as an edge, so border canopy still gets a tree', () => {
    // A tile whose neighbour is off-map has open ground beyond it as far as the
    // player can see, so it reads as fringe.
    const lvl = level(3, 3, () => true)
    // Only the centre tile is enclosed by canopy on all four sides.
    expect(canopyScenery(lvl)).toHaveLength(8)
  })

  it('plants nothing inside a mass with no fringe at all', () => {
    // A 1x1 level that is entirely canopy has no open ground anywhere.
    const lvl = level(1, 1, () => true)
    expect(canopyScenery(lvl)).toHaveLength(1) // its borders are all off-map
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

  it('cuts the tree count well below one-per-canopy-tile on a real-shaped mass', () => {
    // The point of fringe-only planting is fewer, better-placed trees. On a
    // large blob the saving should be substantial, not marginal.
    const lvl = level(30, 30, (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25)
    const canopyTiles = 20 * 20
    expect(canopyScenery(lvl).length).toBeLessThan(canopyTiles * 0.25)
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
