import { describe, it, expect } from 'vitest'
import { TILE, TERRAIN_NAMES } from '../terrain'
import { TERRAIN } from '../../../src/core/level/terrain'
import { tileStyle } from '../../../src/core/view/terrain-style'

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

  it('and name BRIDGE as the same id, which ticket 033 adds', () => {
    /**
     * The second id with a traversal rule, and the first one a LEVEL AUTHOR can
     * summon by name: `legend.json` says `"100,100,100": "bridge"` and this
     * table is what turns that word into the number written to disk. A drift
     * here does not mis-colour a tile, it decides whether the only crossing on
     * level 2 is a road or a river.
     */
    expect(TERRAIN.BRIDGE).toBe(TILE.BRIDGE)
  })
})

describe('every id the importer can emit has somewhere to be drawn', () => {
  it('has a real style, never the magenta fallback', () => {
    /**
     * `FALLBACK_TILE_STYLE` is deliberately alarming so that a new tile id shows
     * up on screen the moment mapgen emits one. That makes it a warning, not a
     * destination — and nothing was checking that the warning had been answered.
     *
     * MEASURED: deleting `TILE_STYLES[5]` left all 1953 tests green, so the
     * bridge could have shipped drawing in magenta with the acceptance criterion
     * ticked. The guard belongs here for the same reason the id comparison above
     * does — this is the one file that can see the importer's table and the
     * renderer's at the same time.
     */
    for (const [name, id] of Object.entries(TILE)) {
      expect({ name, isFallback: tileStyle(id, true).isFallback }).toEqual({
        name,
        isFallback: false,
      })
      expect({ name, isFallback: tileStyle(id, false).isFallback }).toEqual({
        name,
        isFallback: false,
      })
    }
  })

  it('and a blocked tile is never drawn lower than its walkable form', () => {
    // The standing invariant of the style table: raised blocked terrain is what
    // makes the map read as cover at an isometric angle. Asserted across every
    // id so a new one cannot quietly break it.
    for (const [name, id] of Object.entries(TILE)) {
      const walkable = tileStyle(id, true)
      const blocked = tileStyle(id, false)
      expect({ name, ok: blocked.height >= walkable.height }).toEqual({ name, ok: true })
    }
  })
})

describe('the legend`s terrain vocabulary', () => {
  it('names every id in the tile table, and only those', () => {
    /**
     * `TERRAIN_NAMES` is what a level author is allowed to write. An id missing
     * from it is a terrain nobody can declare; a name with no id is a legend
     * that parses and then resolves to nothing. Both are silent, so both are
     * asserted.
     */
    expect(Object.keys(TERRAIN_NAMES).sort()).toEqual(
      Object.keys(TILE)
        .map((k) => k.toLowerCase())
        .sort(),
    )
    for (const [name, id] of Object.entries(TERRAIN_NAMES)) {
      expect({ name, id }).toEqual({ name, id: TILE[name.toUpperCase() as keyof typeof TILE] })
    }
  })
})
