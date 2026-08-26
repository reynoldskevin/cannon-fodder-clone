import { describe, it, expect } from 'vitest'
import { bakeNavGrid, INFANTRY, VEHICLE, ALL_TRAVERSAL } from '../navgrid'
import { traversalForTerrain, TERRAIN } from '../../level'
import type { LevelData } from '../../level/types'

/**
 * Ticket 003a — who may enter a tile, decided by what the tile IS.
 *
 * `NavGrid` has reserved `INFANTRY` and `VEHICLE` since ticket 006 and nothing
 * has ever used them: `bakeNavGrid` bakes every walkable tile to
 * `ALL_TRAVERSAL`. Its own comment says why, and the reason is a good one — the
 * walkability it is handed is a heuristic that "carries no opinion about *who*
 * can walk there", and inventing one inside the grid would be "a fabricated
 * restriction dressed up as level design".
 *
 * That comment also says where the opinion belongs: with whatever later writes
 * it in. This is that. The rule is a table in `core/level` keyed by tile id, so
 * the grid gains no knowledge of what water is — it asks — and the next terrain
 * with a traversal rule is a row rather than an edit to the pathfinder.
 *
 * WHY INFANTRY-ONLY MATTERS BEFORE A SINGLE VEHICLE EXISTS. Nothing spawns a
 * `VEHICLE` today, so this bit changes no behaviour now. It is still the right
 * data: it is what makes a BRIDGE structurally meaningful rather than
 * decorative. A bridge that saves a man a few seconds is scenery; a bridge that
 * is the only way a vehicle ever crosses is level design — and that cannot be
 * reconstructed later from a map where every crossing was equally passable.
 */

/** A level of `terrain`, with `walkable` supplied independently of it. */
function level(terrain: number[][], walkable: boolean[][]): LevelData {
  return {
    schemaVersion: 2,
    name: 'traversal-fixture',
    size: { w: terrain[0]?.length ?? 0, h: terrain.length },
    terrain,
    walkable,
    walkableSource: 'mask',
    spawns: { avatars: [], enemies: [], props: [], chests: [] },
    objectives: [{ type: 'kill_all' }],
  }
}

/** One row of tiles, every one of them walkable. */
const row = (...ids: number[]): LevelData =>
  level([ids], [ids.map(() => true)])

describe('traversalForTerrain', () => {
  it('lets men into water and keeps vehicles out', () => {
    expect(traversalForTerrain(TERRAIN.WATER)).toBe(INFANTRY)
  })

  it('lets both onto dry walkable ground', () => {
    for (const dry of [TERRAIN.GRASS, TERRAIN.ROCK]) {
      expect({ dry, mask: traversalForTerrain(dry) }).toEqual({ dry, mask: ALL_TRAVERSAL })
    }
  })

  it('lets both onto a tile id it has never heard of', () => {
    /**
     * `TileId` IS AN OPEN ENUM BY DESIGN — the schema says adding a tile id must
     * never be a schema break — so this table has to have a neutral answer. A
     * level from a newer importer must not have its unfamiliar tiles silently
     * turn into walls, which would be a map that quietly loses its far half to
     * a build that is merely out of date.
     */
    for (const unknown of [99, 4096, -1]) {
      expect({ unknown, mask: traversalForTerrain(unknown) }).toEqual({
        unknown,
        mask: ALL_TRAVERSAL,
      })
    }
  })

  it('never returns a mask with bits this build cannot name', () => {
    // A mask that truncated on write would make a cell passable to a class
    // nobody can see, which `navgrid.ts` calls the hardest kind of pathing bug
    // to look at.
    for (const id of [TERRAIN.GRASS, TERRAIN.CANOPY, TERRAIN.ROCK, TERRAIN.WATER, 77]) {
      expect({ id, extra: traversalForTerrain(id) & ~ALL_TRAVERSAL }).toEqual({ id, extra: 0 })
    }
  })
})

describe('bakeNavGrid asks the table', () => {
  it('a walkable water tile admits infantry and refuses vehicles', () => {
    const grid = bakeNavGrid(row(TERRAIN.WATER))
    expect({
      infantry: grid.passable(0, 0, INFANTRY),
      vehicle: grid.passable(0, 0, VEHICLE),
    }).toEqual({ infantry: true, vehicle: false })
  })

  it('a walkable grass tile admits both', () => {
    const grid = bakeNavGrid(row(TERRAIN.GRASS))
    expect({
      infantry: grid.passable(0, 0, INFANTRY),
      vehicle: grid.passable(0, 0, VEHICLE),
    }).toEqual({ infantry: true, vehicle: true })
  })

  it('an UNWALKABLE tile admits nobody, whatever it is made of', () => {
    /**
     * The precedence that must not invert. `walkable` is the level author's
     * answer to "may anything be here at all"; the terrain table only ever
     * narrows it. Water that an authored mask marked black is a torrent, and a
     * table that widened it back to passable would overrule the one source of
     * authored truth the importer has.
     */
    for (const id of [TERRAIN.WATER, TERRAIN.GRASS, TERRAIN.CANOPY]) {
      const grid = bakeNavGrid(level([[id]], [[false]]))
      expect({ id, infantry: grid.passable(0, 0, INFANTRY), vehicle: grid.passable(0, 0, VEHICLE) })
        .toEqual({ id, infantry: false, vehicle: false })
    }
  })

  it('an unknown tile id is passable to both rather than to nobody', () => {
    const grid = bakeNavGrid(row(1234))
    expect({
      infantry: grid.passable(0, 0, INFANTRY),
      vehicle: grid.passable(0, 0, VEHICLE),
    }).toEqual({ infantry: true, vehicle: true })
  })
})

describe('a river is a crossing for men and a wall for vehicles', () => {
  /** Dry, dry, WATER, dry, dry — a one-tile river with a bank either side. */
  const ford = (): LevelData => row(TERRAIN.GRASS, TERRAIN.GRASS, TERRAIN.WATER, TERRAIN.GRASS, TERRAIN.GRASS)

  it('infantry can get from one bank to the other', () => {
    const grid = bakeNavGrid(ford())
    for (let x = 0; x < 5; x += 1) {
      expect({ x, passable: grid.passable(x, 0, INFANTRY) }).toEqual({ x, passable: true })
    }
  })

  it('a vehicle is stopped at the water and the far bank is cut off', () => {
    /**
     * Stated as the WHOLE row rather than just the water tile, so a rule that
     * closed the banks as well as the river would be caught too.
     *
     * It asserts PASSABILITY, cell by cell — not reachability. Nothing here runs
     * a search, and saying "the far bank is unreachable" would be describing a
     * flow field this test never builds. On a one-tile-wide fixture the two
     * coincide; on a real map they would not, and the honest claim is the one
     * the assertions actually make.
     */
    const grid = bakeNavGrid(ford())
    expect([0, 1, 2, 3, 4].map((x) => grid.passable(x, 0, VEHICLE))).toEqual([
      true,
      true,
      false,
      true,
      true,
    ])
  })

  it('and a bridge across the river opens it again for both', () => {
    /**
     * The bridge is dry ground drawn across the water, so it needs no rule of
     * its own — it is simply not `WATER`. Asserted because "the bridge works" is
     * the whole reason the water rule is safe to ship.
     *
     * THE FIXTURE MUST CONTAIN WATER, which the first draft's did not: it was
     * four dry tiles, so it asserted nothing this ticket changed and passed
     * against `traversalForTerrain` returning `ALL_TRAVERSAL` for everything —
     * the entire ticket removed. A bridge with no river either side of it is not
     * a bridge.
     *
     * Two rows: the bridge column is dry where the river column is wet, so the
     * same x is crossable on one and not the other.
     */
    const bridged = level(
      [
        [TERRAIN.GRASS, TERRAIN.WATER, TERRAIN.GRASS],
        [TERRAIN.GRASS, TERRAIN.ROCK, TERRAIN.GRASS],
      ],
      [
        [true, true, true],
        [true, true, true],
      ],
    )
    const grid = bakeNavGrid(bridged)
    // The ford: men only.
    expect({ infantry: grid.passable(1, 0, INFANTRY), vehicle: grid.passable(1, 0, VEHICLE) })
      .toEqual({ infantry: true, vehicle: false })
    // The bridge, one row down at the same x: everybody.
    expect({ infantry: grid.passable(1, 1, INFANTRY), vehicle: grid.passable(1, 1, VEHICLE) })
      .toEqual({ infantry: true, vehicle: true })
  })
})
