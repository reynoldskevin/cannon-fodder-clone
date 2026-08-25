import { describe, it, expect } from 'vitest'
import { blockedGrassToCanopy, despeckleTerrain, TILE } from '../terrain'

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

describe('blocked grass becomes canopy, so it gets a tree instead of a block', () => {
  /**
   * The last of the squares. A blocked-grass tile is not mis-classified in any
   * way the map can see — the colour is right and the passability is right — and
   * it still looks wrong, because the style table draws it as 0.45 world units
   * of flat dark green with nothing standing on it. In an open field that is a
   * coloured square lying on the grass.
   *
   * As canopy it lies flat and `core/render-state/scenery` plants a tree on it,
   * because an isolated blocked tile in a field is always FRINGE canopy. The
   * square becomes the thing that is actually in the way.
   */
  const F = false
  const T = true

  it('converts a blocked grass tile', () => {
    const out = blockedGrassToCanopy([[G, G, G]], [[T, F, T]])
    expect(out).toEqual([[G, C, G]])
  })

  it('leaves walkable grass alone', () => {
    const out = blockedGrassToCanopy([[G, G, G]], [[T, T, T]])
    expect(out).toEqual([[G, G, G]])
  })

  it('leaves every other terrain alone, blocked or not', () => {
    // Blocked ROCK is a wall and should look like one; blocked WATER is deep
    // water. Only grass is the case where "blocked" has no visual of its own.
    const out = blockedGrassToCanopy(
      [
        [R, W, C],
        [R, W, C],
      ],
      [
        [F, F, F],
        [T, T, T],
      ],
    )
    expect(out).toEqual([
      [R, W, C],
      [R, W, C],
    ])
  })

  it('never writes to the walkability mask it reads', () => {
    // The property that makes this safe at all. A pass that could edit
    // passability could make a mission unwinnable from a cosmetic tweak.
    const walkable = [[T, F, T]]
    const before = JSON.stringify(walkable)
    blockedGrassToCanopy([[G, G, G]], walkable)
    expect(JSON.stringify(walkable)).toBe(before)
  })

  it('does not mutate the terrain it was given', () => {
    const terrain = [[G, G, G]]
    const before = JSON.stringify(terrain)
    blockedGrassToCanopy(terrain, [[T, F, T]])
    expect(JSON.stringify(terrain)).toBe(before)
  })

  it('tolerates a mask shorter than the terrain', () => {
    // Ragged input degrades to "not known to be blocked" rather than throwing,
    // matching how the rest of the importer treats a malformed row.
    expect(blockedGrassToCanopy([[G, G]], [])).toEqual([[G, G]])
  })

  it('MUST run after the despeckle, not before', () => {
    /**
     * The ordering bug this test exists to prevent, spelled out because it is
     * silent and severe. Run first, a lone blocked-grass tile becomes a lone
     * canopy tile in a sea of grass — an island of one, unanimously shored by
     * grass — and the despeckle faithfully dissolves it straight back. The tile
     * then looks like open field and cannot be walked on.
     *
     * Asserted as the composition, in both orders, so the difference is visible
     * rather than merely documented.
     */
    const terrain = [
      [G, G, G],
      [G, G, G],
      [G, G, G],
    ]
    const walkable = [
      [T, T, T],
      [T, F, T],
      [T, T, T],
    ]
    const wrong = despeckleTerrain(blockedGrassToCanopy(terrain, walkable))
    expect(wrong[1]?.[1]).toBe(G) // dissolved away — an invisible wall

    const right = blockedGrassToCanopy(despeckleTerrain(terrain), walkable)
    expect(right[1]?.[1]).toBe(C) // survives, and will be given a tree
  })
})
