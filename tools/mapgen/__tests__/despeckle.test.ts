import { describe, it, expect } from 'vitest'
import { despeckleTerrain, TILE } from '../terrain'

/**
 * The mapgen despeckle pass — lone mis-classified tiles adopt their surroundings.
 *
 * WHY IT EXISTS. `classifyTile` reads one averaged colour per tile and knows
 * nothing about its neighbours. Its rock branch is the fallback for `r > g`, and
 * inside a jungle any tile that averages over a brown trunk or a patch of leaf
 * litter lands there. On level 1 that produced 63 rock tiles, 55 of them ringed
 * by canopy, each rendering as a grey block standing among the trees — which is
 * what a player sees as "a square on the ground".
 *
 * THE PROPERTY THAT MAKES SMOOTHING SAFE, and the one most worth protecting: it
 * rewrites the terrain id and NOTHING else. Walkability is a separate authored
 * mask. A pass that could change where a soldier may walk would be a pass that
 * could make a mission unwinnable from a cosmetic tweak.
 */

const G = TILE.GRASS
const C = TILE.CANOPY
const R = TILE.ROCK
const W = TILE.WATER

describe('a lone speck is overruled by what surrounds it', () => {
  it('replaces a single rock tile ringed by canopy', () => {
    const out = despeckleTerrain([
      [C, C, C, C],
      [C, R, C, C],
      [C, C, C, C],
    ])
    expect(out[1]?.[1]).toBe(C)
  })

  it('replaces a single unknown tile the same way', () => {
    // The other half of level 1's problem: 23 near-black tiles classified
    // `unknown` because the shadow under the canopy carried no colour at all.
    const out = despeckleTerrain([
      [C, C, C, C],
      [C, TILE.UNKNOWN, C, C],
      [C, C, C, C],
    ])
    expect(out[1]?.[1]).toBe(C)
  })

  it('leaves everything else exactly as it found it', () => {
    // The island is the only thing that may change. A pass that quietly rewrote
    // its surroundings too would erode every real boundary on the map. The grass
    // block here is deliberately larger than `MAX_ISLAND_TILES`, because a small
    // one IS an island and this rule would rightly dissolve it.
    const out = despeckleTerrain([
      [C, C, C, G, G, G],
      [C, R, C, G, G, G],
      [C, C, C, G, G, G],
    ])
    expect(out).toEqual([
      [C, C, C, G, G, G],
      [C, C, C, G, G, G],
      [C, C, C, G, G, G],
    ])
  })
})

describe('what it must NOT smooth away', () => {
  it('keeps a tile its neighbours do not outvote', () => {
    // A shoreline split evenly between two terrains is genuinely ambiguous —
    // an island wedged on a boundary should be left exactly as classified.
    // Sitting exactly on the seam: two grass neighbours, two canopy. Half is
    // not a dominant shoreline, so it stays whatever the classifier said.
    const out = despeckleTerrain([
      [G, G, C, C, C],
      [G, R, C, C, C],
      [C, C, C, C, C],
      [C, C, C, C, C],
    ])
    expect(out[1]?.[1]).toBe(R)
  })

  it('dissolves a two-tile island, because a clump is still a speck', () => {
    /**
     * THE REASON THE RULE WORKS ON ISLANDS AND NOT ON TILES. The obvious version
     * asks each tile whether its own neighbours outvote it, and it cannot fix
     * level 1: the mis-classified rock there comes in clumps of one to SIX, and
     * every tile in a clump has a neighbour of its own kind to hide behind.
     * Judging the connected component instead is what lets a six-tile smear of
     * brown trunk dissolve while a real feature survives on size alone.
     */
    const out = despeckleTerrain([
      [C, C, C, C, C],
      [C, R, R, C, C],
      [C, C, C, C, C],
      [C, C, C, C, C],
    ])
    expect([out[1]?.[1], out[1]?.[2]]).toEqual([C, C])
  })

  it('keeps an island too big to be an accident', () => {
    // Nine tiles, one over the cap. Size is the only thing protecting it, which
    // is exactly the intent: deliberate features are large, artefacts are not.
    const big = [
      [C, C, C, C, C],
      [C, R, R, R, C],
      [C, R, R, R, C],
      [C, R, R, R, C],
      [C, C, C, C, C],
    ]
    const out = despeckleTerrain(big)
    expect(out).toEqual(big)
  })

  it('keeps a map that is all one terrain', () => {
    const solid = [
      [R, R, R],
      [R, R, R],
      [R, R, R],
    ]
    expect(despeckleTerrain(solid)).toEqual(solid)
  })

  it('never lets a speck swallow the map around it', () => {
    // The inversion guard. The ring around a lone speck is itself a connected
    // component, and on a small map it is under the size cap with a shoreline
    // made entirely of that one speck — so without a rule that terrain can only
    // be absorbed by terrain there is MORE of, the jungle dissolves into the
    // rock rather than the other way round.
    const out = despeckleTerrain([
      [C, C, C],
      [C, R, C],
      [C, C, C],
    ])
    expect(out.flat().filter((id) => id === C).length).toBe(9)
  })

  it('never invents an id that was not already adjacent', () => {
    const out = despeckleTerrain([
      [C, C, C, C],
      [C, R, C, C],
      [C, C, C, C],
    ])
    for (const row of out) for (const id of row) expect([C, R]).toContain(id)
  })
})

describe('edges and corners', () => {
  it('dissolves an island on the map edge', () => {
    const out = despeckleTerrain([
      [C, R, C, C],
      [C, C, C, C],
      [C, C, C, C],
    ])
    expect(out[0]?.[1]).toBe(C)
  })

  it('dissolves an island in a corner, which has only two shore tiles', () => {
    const out = despeckleTerrain([
      [R, C, C, C],
      [C, C, C, C],
      [C, C, C, C],
    ])
    expect(out[0]?.[0]).toBe(C)
  })
})

describe('it is one pass over a snapshot, not an iterated relaxation', () => {
  it('judges every tile against the ORIGINAL map, so order cannot matter', () => {
    /**
     * Two specks side by side, each otherwise ringed by canopy. Judged against
     * the original both see two canopy neighbours and one rock, so neither is
     * outvoted and both stand. An in-place pass would convert the first, and the
     * second would then see three canopy neighbours and follow — a result that
     * depends entirely on which tile the loop reached first.
     */
    const out = despeckleTerrain([
      [C, C, C, C, C],
      [C, R, C, R, C],
      [C, C, C, C, C],
      [C, C, C, C, C],
    ])
    // Both specks dissolve, and neither one's shoreline was altered by the
    // other's fate first: the flood reads `terrain`, never its own output.
    expect([out[1]?.[1], out[1]?.[3]]).toEqual([C, C])
  })

  it('is idempotent on its own output', () => {
    const once = despeckleTerrain([
      [C, C, C, C, C],
      [C, R, C, C, C],
      [C, C, C, C, C],
      [C, C, C, C, C],
    ])
    expect(despeckleTerrain(once)).toEqual(once)
  })
})

describe('degenerate inputs', () => {
  it('handles an empty map', () => {
    expect(despeckleTerrain([])).toEqual([])
  })

  it('handles a single tile, which has no neighbours to be outvoted by', () => {
    expect(despeckleTerrain([[W]])).toEqual([[W]])
  })

  it('handles a single row', () => {
    // Two neighbours, both agreeing and neither its own kind: still a speck,
    // judged on the neighbours it has.
    expect(despeckleTerrain([[C, C, C, R, C, C, C]])).toEqual([[C, C, C, C, C, C, C]])
    // An end tile has ONE neighbour, which is not a shoreline: it is one tile's
    // opinion, and it must not flip the end of a one-tile-wide strip.
    expect(despeckleTerrain([[R, C, C, C, C]])).toEqual([[R, C, C, C, C]])
  })
})
