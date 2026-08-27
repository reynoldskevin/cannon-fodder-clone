import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLevel } from '../index'
import {
  TILE,
  buildTerrain,
  buildWalkable,
  declaredTerrainAt,
  despeckleTerrain,
} from '../terrain'
import type { TerrainColour } from '../legend'
import { canvas, encodePng, drawCrosshair, fillRect, type RGB } from './helpers/png'

/**
 * Ticket 033 — a declared tile skips the heuristic entirely.
 *
 * `classifyTile` reads one averaged colour and guesses. That guess is right most
 * of the time and was catastrophically wrong about level 2's bridge, which it
 * called canopy: trees grew out of it and it blocked movement, so the only
 * crossing on the map was to swim — defeating the whole of ticket 007b on the
 * one level that has a bridge at all.
 *
 * A DECLARATION IS NOT A GUESS, and almost every rule below follows from that
 * one sentence. The despeckle exists to tidy up guesses and must not touch a
 * declaration. Walkability-by-luminance is a guess about brightness and must not
 * overrule a declaration. The ink mask is about annotation drawn ON terrain and
 * must not swallow a colour that IS terrain.
 */

const BLUE: RGB = [60, 160, 255]
const RED: RGB = [255, 60, 60]
const GRASS: RGB = [90, 130, 40]
/** Level 2's river, straight off the artwork. */
const WATER: RGB = [0, 32, 80]
/** The deck, as the artist marked it. */
const DECK: RGB = [100, 100, 100]

const TS = 16

let dir: string
let outDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapgen-declared-'))
  outDir = mkdtempSync(join(tmpdir(), 'mapgen-declared-out-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

const bridge: TerrainColour = { colour: [100, 100, 100], name: 'bridge', terrain: TILE.BRIDGE }

describe('declaredTerrainAt', () => {
  it('claims a tile within tolerance and reports the declared id', () => {
    expect(declaredTerrainAt([100, 100, 100], [bridge], 40)).toBe(TILE.BRIDGE)
    // Chebyshev, so the worst channel decides — 24 away on every channel.
    expect(declaredTerrainAt([76, 79, 81], [bridge], 40)).toBe(TILE.BRIDGE)
  })

  it('claims nothing outside tolerance', () => {
    // Real level-2 jungle and river averages: distance 99 and 100.
    expect(declaredTerrainAt([37, 57, 1], [bridge], 40)).toBeUndefined()
    expect(declaredTerrainAt([0, 30, 77], [bridge], 40)).toBeUndefined()
  })

  it('is a max-channel test, not a euclidean one', () => {
    /**
     * The same choice `colourMatches` documents for markers. A colour 60 away
     * on ONE channel and exact on the other two is euclidean-close and must
     * still be rejected, or a declaration starts absorbing terrain that merely
     * averages out near it.
     */
    expect(declaredTerrainAt([160, 100, 100], [bridge], 40)).toBeUndefined()
  })

  it('claims nothing when nothing is declared', () => {
    expect(declaredTerrainAt([100, 100, 100], [], 40)).toBeUndefined()
  })
})

describe('a declared colour beats the classifier', () => {
  it('takes the declared id where the heuristic would have said otherwise', () => {
    /**
     * THE BUG, IN MINIATURE. `classifyTile` sends `rgb(100,100,100)` down the
     * green branch — `g >= r` is true when they are equal — and out the other
     * side as GRASS. Not canopy, in this fixture, but the point is the same:
     * the heuristic has an opinion about the deck and it is not the artist's.
     */
    const averages = [[DECK, GRASS]]
    expect(buildTerrain(averages, 55, [], 40)[0]).toEqual([TILE.GRASS, TILE.GRASS])
    expect(buildTerrain(averages, 55, [bridge], 40)[0]).toEqual([TILE.BRIDGE, TILE.GRASS])
  })

  it('and a tile outside tolerance is classified exactly as before', () => {
    // The declaration must be inert everywhere it does not apply — that is what
    // makes it safe to add to one level's legend and no others.
    const averages = [[GRASS, WATER, [37, 57, 1] as RGB]]
    expect(buildTerrain(averages, 55, [bridge], 40)).toEqual(buildTerrain(averages, 55, [], 40))
  })
})

describe('a declared tile is exempt from the despeckle', () => {
  /**
   * `despeckleTerrain` dissolves an island of eight tiles or fewer whose
   * shoreline is overwhelmingly one other terrain. That is right for a guess and
   * wrong for a declaration.
   *
   * LEVEL 2's BRIDGE SURVIVES TODAY ONLY BY BEING BIG. It is 26 tiles against a
   * cap of 8. A three-tile footbridge would be dissolved straight back into the
   * river with every test in the suite green, and the level would ship with a
   * crossing the artist drew and the importer deleted.
   */

  const water = (w: number, h: number): number[][] =>
    Array.from({ length: h }, () => new Array<number>(w).fill(TILE.WATER))

  const mask = (w: number, h: number, cells: readonly (readonly [number, number])[]) => {
    const m = Array.from({ length: h }, () => new Array<boolean>(w).fill(false))
    for (const [x, y] of cells) m[y]![x] = true
    return m
  }

  const footbridge = [
    [2, 1],
    [2, 2],
    [2, 3],
  ] as const

  it('dissolves an UNDECLARED three-tile island, which is the behaviour being excepted', () => {
    // Stated first and on its own: without this the exemption test below could
    // pass on a despeckle that never dissolved anything.
    const grid = water(5, 5)
    for (const [x, y] of footbridge) grid[y]![x] = TILE.BRIDGE
    const out = despeckleTerrain(grid)
    expect(footbridge.map(([x, y]) => out[y]?.[x])).toEqual([TILE.WATER, TILE.WATER, TILE.WATER])
  })

  it('leaves the same island alone once it is declared', () => {
    const grid = water(5, 5)
    for (const [x, y] of footbridge) grid[y]![x] = TILE.BRIDGE
    const out = despeckleTerrain(grid, mask(5, 5, footbridge))
    expect(footbridge.map(([x, y]) => out[y]?.[x])).toEqual([
      TILE.BRIDGE,
      TILE.BRIDGE,
      TILE.BRIDGE,
    ])
  })

  it('and a declared tile casts no vote in a neighbour`s shoreline', () => {
    /**
     * THE HALF THAT IS EASY TO MISS. Exempting a declared island from being
     * dissolved is the obvious rule; this is the other direction, where a
     * declaration reaches out and absorbs a tile nobody declared.
     *
     * One rock tile boxed in on three sides by declared bridge. Counted as
     * shoreline, bridge holds 3 of 4 — over the two-thirds dominance cut — and
     * the rock becomes bridge, widening the deck by a tile the artist never
     * painted. Ignored, the only real evidence is a single canopy neighbour,
     * and a single neighbour is explicitly not a shoreline, so the tile stands.
     */
    const grid = Array.from({ length: 5 }, () => new Array<number>(5).fill(TILE.CANOPY))
    const declared = [
      [1, 2],
      [2, 1],
      [2, 3],
    ] as const
    for (const [x, y] of declared) grid[y]![x] = TILE.BRIDGE
    grid[2]![2] = TILE.ROCK

    /**
     * Asserted as "does not survive" rather than "becomes bridge", because the
     * pass runs to a fixed point: the lone bridge tiles are themselves specks in
     * a canopy field, so a later pass dissolves the tile they just captured. The
     * claim under test is that the rock is disturbed at all — which side of the
     * cascade it lands on is not the point and would make this test a
     * description of the despeckle's internals.
     */
    expect(despeckleTerrain(grid)[2]?.[2]).not.toBe(TILE.ROCK)
    expect(despeckleTerrain(grid, mask(5, 5, declared))[2]?.[2]).toBe(TILE.ROCK)
  })

  it('is still idempotent with declarations in play', () => {
    // The pipeline's standing rule since ticket 003: running it twice on its own
    // output changes nothing.
    const grid = water(7, 7)
    for (const [x, y] of footbridge) grid[y]![x] = TILE.BRIDGE
    const m = mask(7, 7, footbridge)
    const once = despeckleTerrain(grid, m)
    expect(despeckleTerrain(once, m)).toEqual(once)
  })
})

describe('a declared tile`s walkability comes from what it is, not how bright it is', () => {
  it('a declared bridge is walkable however dark the deck is painted', () => {
    /**
     * `rgb(100,100,100)` clears the luminance cut of 55 at luma 100, so today's
     * artwork is walkable BY LUCK. A deck painted in a dark stain would fail the
     * cut and come out solid — a bridge you cannot walk on, with the classifier
     * cheerfully calling it a bridge.
     */
    const dark: RGB = [20, 20, 20]
    const declared: TerrainColour = { colour: dark, name: 'bridge', terrain: TILE.BRIDGE }
    expect(buildWalkable([[dark]], 55, [], 40)[0]).toEqual([false])
    expect(buildWalkable([[dark]], 55, [declared], 40)[0]).toEqual([true])
  })

  it('a declared canopy is blocked however bright it is', () => {
    // The table has to have an answer for every name the legend accepts, and
    // "declared" cannot simply mean "walkable" — canopy is the counter-example.
    const pale: RGB = [200, 220, 200]
    const declared: TerrainColour = { colour: pale, name: 'canopy', terrain: TILE.CANOPY }
    expect(buildWalkable([[pale]], 55, [declared], 40)[0]).toEqual([false])
  })

  it('and an undeclared tile keeps the luminance rule byte for byte', () => {
    const averages = [[GRASS, WATER, [20, 20, 20] as RGB]]
    expect(buildWalkable(averages, 55, [bridge], 40)).toEqual(buildWalkable(averages, 55, [], 40))
  })
})

describe('through the real importer', () => {
  /**
   * A map cut in two by a river, with a declared deck across it — level 2's
   * shape at a size a test can read.
   */
  function build(withDeclaration: boolean, w = 12, h = 7): void {
    const px = canvas(w * TS, h * TS, GRASS)
    // The river, edge to edge.
    fillRect(px, w * TS, 5 * TS, 0, 2 * TS, h * TS, WATER)
    // The deck across it.
    fillRect(px, w * TS, 5 * TS, 3 * TS, 2 * TS, 1 * TS, DECK)
    drawCrosshair(px, w * TS, 1 * TS + TS / 2, 1 * TS + TS / 2, BLUE)
    drawCrosshair(px, w * TS, 10 * TS + TS / 2, 1 * TS + TS / 2, RED)
    writeFileSync(join(dir, 'map.png'), encodePng(w * TS, h * TS, px))
    writeFileSync(
      join(dir, 'legend.json'),
      JSON.stringify({
        tileSize: TS,
        colourTolerance: 40,
        markerColours: { '60,160,255': 'avatars', '255,60,60': 'enemies' },
        labels: [],
        ...(withDeclaration ? { terrainColours: { '100,100,100': 'bridge' } } : {}),
      }),
    )
  }

  it('emits the declared id on the deck, and it is walkable', () => {
    build(true)
    const { level } = importLevel({ sourceDir: dir, outDir, name: 'declared' })
    for (const x of [5, 6]) {
      expect({ x, terrain: level.terrain[3]?.[x], walkable: level.walkable[3]?.[x] }).toEqual({
        x,
        terrain: TILE.BRIDGE,
        walkable: true,
      })
    }
  })

  it('and the river either side of it is still water', () => {
    build(true)
    const { level } = importLevel({ sourceDir: dir, outDir, name: 'declared' })
    expect(level.terrain[1]?.[5]).toBe(TILE.WATER)
    expect(level.terrain[5]?.[6]).toBe(TILE.WATER)
  })

  it('declaring terrain changes the ink mask not at all', () => {
    /**
     * THE DISTINCTION THIS TICKET TURNS ON. `markerColours` are ANNOTATION:
     * `detect.ts` masks those pixels out of every tile average, precisely so a
     * white crosshair drawn over dark jungle cannot lift the jungle above the
     * walkable cut. A terrain colour is the opposite — it IS the terrain, and it
     * is what the average has to measure. Route it through the ink mask and the
     * deck would be erased from the map it is supposed to describe.
     *
     * `inkMask` is internal, so this asserts its one observable consequence: the
     * markers found, and the terrain of every tile the declaration does not
     * claim, are identical with and without it.
     */
    build(false)
    const without = importLevel({ sourceDir: dir, outDir, name: 'declared' }).level
    build(true)
    const withIt = importLevel({ sourceDir: dir, outDir, name: 'declared' }).level

    expect(withIt.spawns).toEqual(without.spawns)

    const changed: string[] = []
    for (let y = 0; y < withIt.size.h; y += 1) {
      for (let x = 0; x < withIt.size.w; x += 1) {
        if (withIt.terrain[y]?.[x] !== without.terrain[y]?.[x]) changed.push(`${String(x)},${String(y)}`)
      }
    }
    // Exactly the two deck tiles, and nothing else anywhere on the map.
    expect(changed.sort()).toEqual(['5,3', '6,3'])
  })

  it('which makes the two banks one map without anybody swimming', () => {
    /**
     * The acceptance criterion, phrased as the thing a player does. Flood from
     * the west bank across walkable tiles that are NOT water: before the
     * declaration the deck was grass (walkable, so this passed for the wrong
     * reason) — so the assertion is on the id as well, below.
     */
    build(true)
    const { level } = importLevel({ sourceDir: dir, outDir, name: 'declared' })
    const { w, h } = level.size
    const seen = new Set<number>()
    const queue: [number, number][] = [[0, 0]]
    seen.add(0)
    while (queue.length > 0) {
      const next = queue.pop()
      if (next === undefined) break
      const [x, y] = next
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const key = ny * w + nx
        if (seen.has(key)) continue
        if (level.walkable[ny]?.[nx] !== true) continue
        if (level.terrain[ny]?.[nx] === TILE.WATER) continue
        seen.add(key)
        queue.push([nx, ny])
      }
    }
    // The far bank is reachable, and the ONLY dry route there is the deck.
    expect(seen.has(3 * w + 11)).toBe(true)
    expect(seen.has(3 * w + 5)).toBe(true)
    expect(seen.has(1 * w + 5)).toBe(false)
  })

  it('and is idempotent — the same source imports byte-identically twice', () => {
    build(true)
    const first = importLevel({ sourceDir: dir, outDir, name: 'declared' }).level
    const second = importLevel({ sourceDir: dir, outDir, name: 'declared' }).level
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
