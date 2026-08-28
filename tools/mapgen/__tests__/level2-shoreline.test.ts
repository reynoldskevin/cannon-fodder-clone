import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TILE } from '../terrain'

/**
 * Ticket 035 — the shoreline of the level 2 that is actually shipped.
 *
 * Every other test in this ticket runs on a synthetic fixture, and a fixture
 * cannot catch what produced the ticket: the importer was correct about the
 * colours it was given, and the ARTWORK put a dark red stroke along the water's
 * edge that nothing masks. So this reads the committed `level2.json` — the file
 * the browser fetches — and asserts the bank came out as ground rather than as a
 * line of trees and grey blocks.
 *
 * It is also the test that fails if `npm run import:levels` was not re-run.
 */

const DIR = new URL('../../../public/generated/levels/', import.meta.url).pathname
const level = JSON.parse(readFileSync(join(DIR, 'level2.json'), 'utf8')) as {
  size: { w: number; h: number }
  terrain: number[][]
  walkable: boolean[][]
}

const { w, h } = level.size
const at = (x: number, y: number): number => level.terrain[y]?.[x] ?? -1

/** Non-water tiles with a four-connected water neighbour. */
const shoreline = (): { x: number; y: number }[] => {
  const found: { x: number; y: number }[] = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (at(x, y) === TILE.WATER) continue
      const touchesWater = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => at(x + (dx ?? 0), y + (dy ?? 0)) === TILE.WATER)
      if (touchesWater) found.push({ x, y })
    }
  }
  return found
}

const countOf = (id: number): number => shoreline().filter((t) => at(t.x, t.y) === id).length

describe('level 2`s bank reads as ground', () => {
  it('has a shoreline at all, which is what says the import was re-run', () => {
    // Without this every count below is vacuously satisfied on an empty list.
    expect(shoreline().length).toBeGreaterThan(150)
  })

  it('draws far fewer grey blocks than it used to', () => {
    /**
     * Rock at the waterline is the artefact with no defence: it is the painted
     * red stroke averaged into the tile until `r > g`, and it renders as a solid
     * block 0.7 units tall standing in the river. There were 47.
     *
     * The residual tiles are honest — slivers where so little land falls inside
     * the tile that the outline really is the plurality of it. The bound is the
     * ticket's, declared before the rule was written.
     */
    expect(countOf(TILE.ROCK)).toBeLessThanOrEqual(30)
  })

  it('and no trees standing in the river', () => {
    /**
     * Canopy at the waterline plants a tree, because `scenery.ts` plants one per
     * fringe canopy tile and does not consult walkability at all. There were 48.
     *
     * THE LOWER BOUND THAT USED TO SIT HERE IS GONE, AND DELIBERATELY (ticket
     * 079). It read `> 10` and argued that a rule flattening every bank to grass
     * would silently open ground the artist had blocked. The argument is right;
     * the assertion was not, because it was a claim about one PAINTING rather
     * than about the rule — and the painting changed. Measured off
     * `level2/map.png` with water pixels excluded exactly as the classifier
     * excludes them, the darkest land mean on all 196 shoreline tiles is
     * luminance 71.5 against a canopy cut of 55: not one bank tile is within
     * sixteen points of being scrub. Zero is the correct answer here, not a
     * flattened one.
     *
     * WHAT IT PROTECTED IS STILL PROTECTED, and at the level it belongs to:
     * `shoreline.test.ts` — "but stays canopy when its land really is canopy" —
     * feeds the rule a bank tile whose land IS canopy and requires canopy back.
     * That claim is about the rule and survives any repaint. Holding the count
     * here instead meant the artwork had to be repainted to satisfy a test.
     */
    expect(countOf(TILE.CANOPY)).toBeLessThanOrEqual(35)
  })

  it('and most of it is now walkable ground', () => {
    /**
     * ACCEPTANCE CRITERION 7, WHICH NOTHING WAS CHECKING. Feeding the adjusted
     * grid to `buildTerrain` but NOT to `buildWalkable` left all 2010 tests green
     * while changing 46 tiles' passability — the bank would look right and play
     * wrong, which the ticket argues is worse than looking wrong, because nothing
     * on screen explains it.
     *
     * 94 of 187 shoreline tiles were blocked before, against 27% for the map as a
     * whole.
     */
    const bank = shoreline()
    const blocked = bank.filter((t) => level.walkable[t.y]?.[t.x] !== true).length
    expect(blocked).toBeLessThanOrEqual(70)
    expect(countOf(TILE.GRASS)).toBeGreaterThanOrEqual(120)
  })

  it('and every shoreline tile classified as grass is walkable', () => {
    // Terrain and passability come from the same land mean, so they cannot
    // disagree: a tile that reads as open grass and cannot be walked on is the
    // invisible wall this ticket exists to remove.
    const stuck = shoreline().filter(
      (t) => at(t.x, t.y) === TILE.GRASS && level.walkable[t.y]?.[t.x] !== true,
    )
    expect(stuck).toEqual([])
  })

  it('and the bridge is untouched by any of it', () => {
    // Every deck tile touches water, so every one is a shoreline tile. Ticket
    // 033 must survive ticket 035.
    const deck: { x: number; y: number }[] = []
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) if (at(x, y) === TILE.BRIDGE) deck.push({ x, y })
    }
    expect(deck).toHaveLength(28)
    expect(deck.filter((t) => level.walkable[t.y]?.[t.x] !== true)).toEqual([])
  })
})
