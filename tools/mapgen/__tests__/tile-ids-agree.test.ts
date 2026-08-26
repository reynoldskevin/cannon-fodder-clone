import { describe, it, expect } from 'vitest'
import { TILE } from '../terrain'
import { TERRAIN } from '../../../src/core/level/terrain'

/**
 * Ticket 003a — the two tile-id tables must agree, and this is what says so.
 *
 * THE TICKET DECLARED THIS TEST IMPOSSIBLE, AND WAS WRONG. It reasoned that
 * `tools/` is offline tooling `src/core/**` may not import, so nothing could
 * ever see both tables at once and any such test would be a lie. The first half
 * is true and the second does not follow: the restriction runs one way. A file
 * under `tools/` may import from `src/`, which is exactly what the importer
 * already does — `tools/mapgen/index.ts` imports `LevelData` from
 * `src/core/level`. So the guard lives here rather than in `core`, and it costs
 * four lines.
 *
 * WHAT IT COSTS TO NOT HAVE IT, measured: changing `TILE.WATER` from 4 to 5
 * leaves the entire suite green. On the next import every one of level 2's 685
 * river tiles is emitted as id 5, `traversalForTerrain` has never heard of 5 and
 * returns `ALL_TRAVERSAL` so vehicles drive up the river, and the renderer has
 * no style for 5 so the whole river draws in the fallback colour. The ticket
 * silently becomes a no-op and nothing anywhere says so.
 *
 * The duplication itself is right and stays — it is the same shape as
 * `core/world`'s `DEFAULT_HEALTH` restating `core/combat`'s `INFANTRY_HEALTH`
 * rather than depending upward. What was missing was the mechanism that keeps a
 * duplicate honest, which every other duplicate in this codebase has.
 */

describe('core/level TERRAIN and tools/mapgen TILE', () => {
  it('agree on every id the importer can emit', () => {
    /**
     * Compared as whole objects rather than key by key: a per-key loop over one
     * table's keys passes happily when the OTHER table grows a name, which is
     * the direction this drifts in practice — the importer learns a new terrain
     * and `core` is not told.
     */
    expect({ ...TERRAIN }).toEqual({ ...TILE })
  })

  it('and neither has a name the other lacks', () => {
    // Stated separately so a failure says WHICH table gained something, rather
    // than printing two object literals and leaving the reader to diff them.
    expect(Object.keys(TERRAIN).sort()).toEqual(Object.keys(TILE).sort())
  })

  it('name WATER as the same id, which is the one this ticket turns on', () => {
    // Called out on its own because it is the id that now carries a traversal
    // rule: a drift here does not merely mis-colour a tile, it decides whether a
    // river is a road.
    expect(TERRAIN.WATER).toBe(TILE.WATER)
  })
})
