import { describe, it, expect } from 'vitest'
import {
  canopyScenery,
  treeVariantFor,
  palmVariantFor,
  tileJitter,
  TREE_VARIANTS,
  PALM_VARIANTS,
} from '../scenery'

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

  it('plants the INTERIOR of a mass too, not just its fringe', () => {
    /**
     * REVERSED, and the premise is what changed rather than the taste.
     *
     * Ticket 010a planted the fringe alone because a trunk inside a dense mass
     * is hidden by the crowns around it — and it said so explicitly on the
     * strength of the interior being "raised foliage-coloured terrain". That
     * terrain is gone: canopy now lies flat and is tinted exactly like grass,
     * because a raised, differently-tinted tile is what drew a hard-edged square
     * on the ground under every tree.
     *
     * With fringe-only planting on flat, untinted canopy the interior of every
     * forest was BARE GRASS ringed by a single line of trees. Whatever the
     * terrain stops carrying, the trees have to carry.
     */
    const lvl = level(10, 10, (x, y) => x >= 2 && x < 6 && y >= 2 && y < 6)
    expect(canopyScenery(lvl)).toHaveLength(16) // the whole 4x4, interior included
  })

  it('plants the enclosed centre of a 3x3 block', () => {
    // The centre tile is the one `isFringeCanopy` excludes, so it is the single
    // tile that distinguishes the two rules. It must get a tree.
    const lvl = level(5, 5, (x, y) => x >= 1 && x < 4 && y >= 1 && y < 4)
    expect(canopyScenery(lvl)).toHaveLength(9)
    expect(canopyScenery(lvl).some((t) => t.tileX === 2 && t.tileY === 2)).toBe(true)
  })

  it('plants every tile of a map that is entirely canopy', () => {
    const lvl = level(3, 3, () => true)
    expect(canopyScenery(lvl)).toHaveLength(9)
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

  it('is exactly one tree per canopy tile, however large the mass', () => {
    // The assertion this replaces required the count to be UNDER a quarter of
    // the canopy tiles, which was the whole point of fringe-only planting and is
    // now precisely the bug: a 20x20 block of jungle drew 76 trees around an
    // empty 18x18 field of grass.
    const lvl = level(30, 30, (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25)
    expect(canopyScenery(lvl)).toHaveLength(20 * 20)
  })

  it('gives every tree a distinct id, so 1,205 of them do not collide', () => {
    // Ids are the row-major tile index. Fringe-only planting never exercised a
    // dense block, and a renderer keyed on a duplicated id drops sprites.
    const lvl = level(12, 12, (x, y) => x >= 2 && x < 10 && y >= 2 && y < 10)
    const items = canopyScenery(lvl)
    expect(new Set(items.map((t) => t.id)).size).toBe(items.length)
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

  it('never puts a palm on canopy terrain', () => {
    // The two pools are separate ON PURPOSE: palms are for the map's hand-placed
    // `tree` annotations, the broadleaves are the forest. A palm leaking into
    // the canopy is the exact regression this split exists to prevent, and it
    // would be invisible in a passing suite that only checked "some variant".
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        expect(PALM_VARIANTS).not.toContain(treeVariantFor(x, y))
      }
    }
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

describe('palmVariantFor', () => {
  it('is deterministic for a tile', () => {
    expect(palmVariantFor(45, 36)).toBe(palmVariantFor(45, 36))
  })

  it('returns a declared palm for any tile', () => {
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) expect(PALM_VARIANTS).toContain(palmVariantFor(x, y))
    }
  })

  it('uses all three palms across a field', () => {
    const seen = new Set<string>()
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) seen.add(palmVariantFor(x, y))
    expect(seen.size).toBe(3)
  })

  it('does not track the canopy choice — the two rolls are independent', () => {
    // Both hash the same two coordinates. Sharing a salt would make the palm a
    // pure function of the tree variant, which is not wrong on a map with one
    // annotation but is a trap waiting for a map with fifty.
    let agreements = 0
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        const treeIndex = TREE_VARIANTS.indexOf(treeVariantFor(x, y))
        const palmIndex = PALM_VARIANTS.indexOf(palmVariantFor(x, y))
        if (treeIndex === palmIndex) agreements++
      }
    }
    // 900 tiles, 3 buckets: correlated salts would agree on all 900; independent
    // ones land near 300. Anything under half is comfortably not lock-step.
    expect(agreements).toBeLessThan(450)
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
