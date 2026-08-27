import { describe, it, expect } from 'vitest'
import { TILE, classifyTile, shorelineAdjustedAverages, tileAverages } from '../terrain'
import type { Image, RGB } from '../image'

/**
 * Ticket 035 — a tile at the waterline is what its LAND is.
 *
 * `classifyTile` reads one averaged colour per tile. At a boundary that average
 * is a blend of two terrains and describes neither — and level 2's artwork makes
 * it worse by painting a dark red stroke along the whole water's edge, which is
 * 14.6% of every shoreline tile's pixels and nowhere near any declared marker
 * colour, so nothing masks it.
 *
 * MEASURED ON THE REAL ARTWORK: the shoreline averages `rgb(45,42,20)` at
 * luminance 40, against open grass at 83 and a walkable cut of 55. All 94 of its
 * blocked tiles fall under that cut. Where the stroke dominates, `r > g` sends
 * the tile down the rock branch and it draws as a raised grey block; where green
 * survives it is dark green, so it is canopy, and a tree is planted on it.
 *
 * THE RULE IS SELF-CALIBRATING AND KNOWS NOTHING ABOUT RED, which is the whole
 * design. "Also drop reddish pixels" needs a hand-tuned threshold, and
 * `image.ts` documents dark red foliage around `rgb(178,64,0)` in this very
 * artwork — any test tuned to catch the stroke catches that too. A modal vote
 * over the land pixels needs no such constant: the stroke is a minority of the
 * land, so it loses.
 */

const TS = 8
const WATER: RGB = [0, 32, 80]
/** Level 2's open grass, off the artwork. */
const GRASS: RGB = [80, 100, 8]
const CANOPY: RGB = [30, 50, 10]
/** The shoreline stroke, straight off level 2's artwork. */
const STROKE: RGB = [80, 0, 0]

/** Build an image from a grid of tiles, each tile given as `TS` column colours. */
function imageOf(tiles: readonly (readonly RGB[])[][]): Image {
  const h = tiles.length
  const w = tiles[0]?.length ?? 0
  const width = w * TS
  const height = h * TS
  const rgb = new Uint8Array(width * height * 3)
  for (let ty = 0; ty < h; ty += 1) {
    for (let tx = 0; tx < w; tx += 1) {
      const columns = tiles[ty]?.[tx] ?? []
      for (let py = 0; py < TS; py += 1) {
        for (let px = 0; px < TS; px += 1) {
          const c = columns[px] ?? [0, 0, 0]
          const i = ((ty * TS + py) * width + (tx * TS + px)) * 3
          rgb[i] = c[0]
          rgb[i + 1] = c[1]
          rgb[i + 2] = c[2]
        }
      }
    }
  }
  return { width, height, rgb }
}

/** A tile of `TS` columns: `n` of `a`, then the rest `b`, then `strokes` of STROKE. */
const mix = (a: RGB, n: number, b: RGB, strokes = 0): RGB[] =>
  Array.from({ length: TS }, (_, i) =>
    i < n ? a : i < TS - strokes ? b : STROKE,
  )

const solid = (c: RGB): RGB[] => Array.from({ length: TS }, () => c)

/** Run the whole pipeline stage: plain averages, then the shoreline adjustment. */
function adjust(tiles: readonly (readonly RGB[])[][], cut = 55) {
  const image = imageOf(tiles)
  const w = tiles[0]?.length ?? 0
  const h = tiles.length
  const { averages } = tileAverages(image, TS, w, h)
  const adjusted = shorelineAdjustedAverages(image, TS, averages, cut)
  return {
    before: averages.map((row) => row.map((c) => classifyTile(c, cut))),
    after: adjusted.map((row) => row.map((c) => classifyTile(c, cut))),
    averages,
    adjusted,
  }
}

describe('a tile at the waterline', () => {
  it('is grass when its land is grass, however dark the whole tile averages', () => {
    /**
     * THE DEFECT, IN MINIATURE. Two of four columns are water, one is grass, one
     * is the painted stroke. The tile's mean is dark enough and green enough to
     * be canopy — so it grows a tree and blocks movement — while the only LAND
     * in it is plainly grass.
     */
    const bank = mix(WATER, 4, GRASS, 1)
    const { before, after } = adjust([[solid(WATER), bank, solid(GRASS)]])

    expect(before[0]?.[1]).toBe(TILE.CANOPY)
    expect(after[0]?.[1]).toBe(TILE.GRASS)
  })

  it('and the stroke does not get a vote, without anything knowing it is red', () => {
    /**
     * The same tile with and without the stroke painted on it reaches the same
     * verdict. That is the property that makes this rule safe on artwork nobody
     * has looked at: it is not "ignore red", it is "the majority of the land
     * wins", and the stroke is a minority of the land.
     */
    const withStroke = adjust([[solid(WATER), mix(WATER, 4, GRASS, 1), solid(GRASS)]])
    const without = adjust([[solid(WATER), mix(WATER, 4, GRASS, 0), solid(GRASS)]])
    expect(withStroke.after[0]?.[1]).toBe(without.after[0]?.[1])
    expect(withStroke.after[0]?.[1]).toBe(TILE.GRASS)
  })

  it('but stays canopy when its land really is canopy', () => {
    /**
     * The rule must not simply open every bank. Level 2's artist painted a band
     * of dark scrub along the water and the classifier is not wrong about it —
     * a rule that flattened it to grass would be trading one wrong answer for
     * another, and would silently open ground the artist blocked.
     */
    const bank = mix(WATER, 3, CANOPY, 0)
    const { after } = adjust([[solid(WATER), bank, solid(CANOPY)]])
    expect(after[0]?.[1]).toBe(TILE.CANOPY)
  })

  it('and a tile that is mostly stroke keeps the answer the stroke gives', () => {
    /**
     * HONEST ABOUT ITS OWN LIMIT. Where a tile catches only a sliver of land, the
     * painted outline really is the plurality of that land, and the modal vote
     * says rock. That is the rule working, not failing — 28 such tiles survive on
     * level 2, and the fix for them is the artwork or a declared colour, not a
     * cleverer heuristic. Pinned so nobody "improves" it into a special case.
     */
    const sliver = mix(WATER, 3, STROKE, 0)
    const { after } = adjust([[solid(WATER), sliver, solid(GRASS)]])
    expect(after[0]?.[1]).toBe(TILE.ROCK)
  })
})

describe('everything away from the water is left exactly alone', () => {
  it('changes no tile that has no water neighbour', () => {
    /**
     * THE WHOLE SAFETY ARGUMENT, and it is one careless predicate away from
     * being false. Asserted on the averages themselves rather than on the
     * classification: a rule that recomputed an inland tile and happened to
     * arrive at the same id would still be a rule that had escaped its scope.
     */
    const dry = [
      [solid(GRASS), mix(GRASS, 4, CANOPY, 1), solid(CANOPY)],
      [solid(CANOPY), solid(GRASS), mix(GRASS, 2, CANOPY, 2)],
    ]
    const { averages, adjusted } = adjust(dry)
    expect(adjusted).toEqual(averages)
  })

  it('and a diagonal neighbour is not a shoreline', () => {
    /**
     * Four-connected, matching every other neighbourhood in this pipeline — the
     * despeckle's flood and the walkability reachability check both are. A tile
     * touching water only at a corner does not share an edge with it and cannot
     * have caught any of it.
     */
    const tiles = [
      [solid(WATER), solid(GRASS)],
      [solid(GRASS), mix(GRASS, 4, CANOPY, 1)],
    ]
    const { averages, adjusted } = adjust(tiles)
    expect(adjusted[1]?.[1]).toEqual(averages[1]?.[1])
  })

  it('so a map with no water at all imports byte-identically', () => {
    // Level 1 has no water anywhere, so it cannot move. By construction rather
    // than by luck, which is what this says.
    const { averages, adjusted } = adjust([
      [solid(GRASS), solid(CANOPY), mix(GRASS, 4, CANOPY, 1)],
      [mix(CANOPY, 2, GRASS, 0), solid(GRASS), solid(CANOPY)],
    ])
    expect(adjusted).toEqual(averages)
  })

  it('and a water tile itself is never adjusted', () => {
    // The rule is about land that caught some water, not about water.
    const { averages, adjusted } = adjust([[solid(WATER), solid(WATER), solid(GRASS)]])
    expect(adjusted[0]?.[0]).toEqual(averages[0]?.[0])
    expect(adjusted[0]?.[1]).toEqual(averages[0]?.[1])
  })
})

describe('it drops exactly the pixels the classifier calls water', () => {
  it('leaves the land mean undiluted, which is what says they were dropped', () => {
    /**
     * The sharpest available statement of "water pixels are excluded": a bank
     * tile of three water columns and five grass ones must adjust to EXACTLY the
     * grass colour. Any water left in the sum shifts every channel, so this
     * cannot pass on a rule that merely weighted the water down.
     *
     * It also pins that the rule uses `classifyTile`'s own water test rather
     * than a second threshold of its own — a drift between the two would show up
     * as a shoreline that moved without the artwork changing, and the arithmetic
     * here would stop landing on the nose.
     */
    const { adjusted } = adjust([[solid(WATER), mix(WATER, 3, GRASS, 0), solid(GRASS)]])
    expect(adjusted[0]?.[1]).toEqual([...GRASS])
  })

  it('and never emits a NaN channel, whatever it is handed', () => {
    /**
     * A DEFENSIVE GUARD, and labelled as one rather than dressed up as a case
     * from the artwork. Averaging an empty set is NaN; a NaN colour falls
     * through `classifyTile` to `unknown` and draws as a hole in the map. I could
     * not construct a non-water tile whose every pixel is water — the tile mean
     * tends to follow its pixels — so this asserts the property across the whole
     * battery rather than claiming to have reached the state.
     */
    const battery = [
      [solid(WATER), mix(WATER, 4, GRASS, 1), solid(GRASS)],
      [solid(WATER), mix(WATER, 3, STROKE, 0), solid(CANOPY)],
      [mix(WATER, 7, GRASS, 0), solid(WATER), mix(WATER, 1, CANOPY, 6)],
    ]
    for (const row of adjust(battery).adjusted) {
      for (const colour of row) {
        expect(colour.every((channel) => Number.isFinite(channel))).toBe(true)
      }
    }
  })
})

describe('the adjustment is a pure function of the image', () => {
  it('produces the same grid twice, so the import stays idempotent', () => {
    const tiles = [[solid(WATER), mix(WATER, 2, GRASS, 1), solid(GRASS)]]
    expect(adjust(tiles).adjusted).toEqual(adjust(tiles).adjusted)
  })

  it('and never mutates the averages it was given', () => {
    // The caller keeps the plain averages: `buildWalkable`'s declared-colour
    // lookup and the ink-fill report both still read them.
    const tiles = [[solid(WATER), mix(WATER, 2, GRASS, 1), solid(GRASS)]]
    const image = imageOf(tiles)
    const { averages } = tileAverages(image, TS, 3, 1)
    const snapshot = JSON.stringify(averages)
    shorelineAdjustedAverages(image, TS, averages, 55)
    expect(JSON.stringify(averages)).toBe(snapshot)
  })
})
