/**
 * Shared fixtures for the ticket 007 squad tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 *
 * THE COORDINATE TRAP THIS EXISTS TO DEFUSE. Entities hold continuous WORLD
 * positions (origin-centred, `core/view/projection`); the nav grid and flow
 * fields are TILE-space, origin at the corner. On any level whose size is even
 * the two differ by a half-unit, and on a centred fixture a sign error still
 * puts units somewhere plausible — they just walk to the wrong place, slowly.
 * Every helper here speaks TILES and converts at the boundary, so no test has to
 * remember which space it is in.
 */

import { World } from '../../world/world'
import type { Entity } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid, type NavGrid } from '../../pathing/navgrid'
import { tileToWorld, worldToTile } from '../../view/projection'
import type { LevelData } from '../../level/types'
import { createSquadSystem, type SquadOptions, type SquadSystem } from '../index'

export interface Scene {
  readonly world: World
  readonly grid: NavGrid
  readonly squad: SquadSystem
  readonly level: LevelData
  /** Spawn a player unit at a TILE coordinate (may be fractional). */
  spawn(tileX: number, tileY: number, kind?: string): Entity
  /** Run `ticks` simulation steps. */
  run(ticks: number): void
  /** Where a unit is, in fractional TILE coordinates. */
  tileOf(id: number): { x: number; y: number }
  /** Distance between two units, in tiles. */
  gap(a: number, b: number): number
}

/**
 * A scene over an ASCII map (`#` blocked), with the squad system registered.
 *
 * Options are passed through explicitly by most tests rather than relying on the
 * defaults: a test that silently depends on `speedTilesPerSecond` being 3 breaks
 * the day someone tunes the feel, which is a thing this ticket fully expects to
 * happen.
 */
export function scene(art: string, options: SquadOptions = {}): Scene {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const squad = createSquadSystem(grid, options)
  world.addSystem(squad)

  const tileOf = (id: number): { x: number; y: number } => {
    const e = world.get(id)
    if (!e) throw new Error(`no entity ${String(id)}`)
    return worldToTileFractional(e.x, e.z, level.size)
  }

  return {
    world,
    grid,
    squad,
    level,
    spawn(tileX, tileY, kind = 'rifleman') {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind, team: 'player', x: p.x, z: p.z })
    },
    run(ticks) {
      for (let i = 0; i < ticks; i++) world.tick()
    },
    tileOf,
    gap(a, b) {
      const pa = tileOf(a)
      const pb = tileOf(b)
      return Math.hypot(pa.x - pb.x, pa.y - pb.y)
    },
  }
}

/**
 * World XZ back to FRACTIONAL tile coordinates, CENTRE-INDEXED.
 *
 * Integer values name tile CENTRES, matching `tileToWorld` — so a unit spawned
 * at `spawn(2, 5)` reads back as exactly `{x: 2, y: 5}` and every assertion in
 * these tests is written in the same coordinates the test used to place things.
 *
 * `core/view/projection`'s `worldToTile` rounds and clamps, which is right for
 * "which tile was clicked" and wrong here: rounding would hide exactly the
 * sub-tile drift these tests are checking for, and clamping would quietly turn a
 * unit that escaped the map into a unit sitting politely on its edge.
 *
 * DO NOT `Math.floor` THE RESULT to get a tile index. That is the half-tile bug
 * this comment exists to prevent, and an earlier version of this fixture shipped
 * it: centre-indexed tile `n` spans `[n - 0.5, n + 0.5)`, so the index is
 * `Math.round`, not `Math.floor`. Flooring silently reports a unit standing 0.6
 * tiles east of tile 3's centre — which is in tile 4 — as being in tile 3, and a
 * walkability assertion built on it passes while the man's feet are in a tree.
 * `occupiedTile` below is the only sanctioned way to get an index from a
 * position, and it defers to `worldToTile` so it cannot drift from the engine.
 */
export function worldToTileFractional(
  wx: number,
  wz: number,
  size: { readonly w: number; readonly h: number },
): { x: number; y: number } {
  return { x: wx + (size.w - 1) / 2, y: wz + (size.h - 1) / 2 }
}

/** Re-exported so tests can assert the rounding helper agrees with the engine's. */
export { tileToWorld, worldToTile }

/**
 * Which tile a unit OCCUPIES, straight from the shared projection helper.
 *
 * Deliberately not computed here. The whole hazard this ticket has to survive is
 * two modules disagreeing about which tile a world position is in; a fixture
 * that reimplements the conversion can only ever confirm that the squad system
 * agrees with the fixture.
 */
export function occupiedTile(s: Scene, id: number): { x: number; y: number } {
  const e = s.world.get(id)
  if (!e) throw new Error(`no entity ${String(id)}`)
  return worldToTile(e.x, e.z, s.level.size)
}

/** Every unit is standing on a passable tile. Returns the first offender, if any. */
export function offMapOrBlocked(s: Scene, ids: readonly number[], mask: number): number | null {
  for (const id of ids) {
    const t = occupiedTile(s, id)
    if (!s.grid.passable(t.x, t.y, mask)) return id
  }
  return null
}
