/**
 * What a tile IS, and who may therefore walk on it (ticket 003a).
 *
 * `LevelData.walkable` answers "may anything be here at all" — it is the level
 * author's mask when there is one, and the importer's brightness guess when
 * there is not. It says nothing about *who*. This module is the other half:
 * given a tile id, which traversal classes the terrain admits.
 */

import { ALL_TRAVERSAL, INFANTRY } from '../pathing/traversal-mask'
import type { TraversalMask } from '../pathing/traversal-mask'
import type { TileId } from './types'

/**
 * The tile ids `tools/mapgen` emits, named for the code in `core` that needs to
 * reason about them.
 *
 * THIS DUPLICATES `tools/mapgen/terrain.ts`'s `TILE`, DELIBERATELY. `tools/` is
 * offline Node tooling that runs once at build time and must never be linked
 * into the game, so `src/core/**` does not depend on it. The ids are restated
 * here instead — the same shape as `core/world`'s `DEFAULT_HEALTH` restating
 * `core/combat`'s `INFANTRY_HEALTH` rather than depending upward, and as
 * `core/render-state/scenery.ts` restating `CANOPY_TILE_ID = 2`.
 *
 * THE TWO ARE KEPT HONEST BY A TEST: `tools/mapgen/__tests__/tile-ids-agree.test.ts`.
 * The no-dependency rule runs one way only — a file under `tools/` may import
 * from `src/`, which the importer already does (`tools/mapgen/index.ts` imports
 * `LevelData` from `src/core/level`) — so that test can see both tables at once
 * and asserts they match. It is not decoration: before it existed, changing
 * `TILE.WATER` from 4 to 5 left the whole suite green while making this ticket a
 * silent no-op. `tools/mapgen/terrain.ts` is the source of truth; a change there
 * is a change here, by hand, and that test is what says so.
 *
 * Folding `scenery.ts`'s `CANOPY_TILE_ID` into this table is left alone on
 * purpose — it is a rename that touches the renderer, and ticket 003a is about
 * a river.
 */
export const TERRAIN = {
  /** Anything the importer's heuristic could not place. */
  UNKNOWN: 0,
  /** Light green: grass, clearings, open ground cover. */
  GRASS: 1,
  /** Dark green: dense canopy / undergrowth. */
  CANOPY: 2,
  /** Warm or neutral: dirt, rock, path. */
  ROCK: 3,
  /** Blue-dominant: water. Passable on foot only. */
  WATER: 4,
} as const

/**
 * Which traversal classes this terrain admits, for a tile that is walkable at
 * all.
 *
 * WATER IS INFANTRY-ONLY, AND THAT BIT MATTERS BEFORE A SINGLE VEHICLE EXISTS.
 * Nothing in the game spawns a `VEHICLE` today, so this changes no behaviour
 * now. It is still the right data: it is what makes a BRIDGE structurally
 * meaningful rather than decorative. A bridge that saves a man a few seconds is
 * scenery; a bridge that is the only way a vehicle ever crosses is level
 * design — and that cannot be reconstructed later from a map on which every
 * crossing was equally passable. A bridge needs no rule of its own here: it is
 * drawn as dry ground across the water, so it is simply not `WATER`.
 *
 * AN UNKNOWN TILE ID IS PASSABLE TO EVERYONE, NEVER TO NOBODY. `TileId` is an
 * open enum by design — `types.ts` states that adding a tile id must never be a
 * schema break — so this table has to have a neutral answer for an id it has
 * never seen. Defaulting to "impassable" would mean a level from a newer
 * importer quietly loses its far half to a build that is merely out of date,
 * which is a map that looks intact and cannot be finished.
 *
 * This only ever NARROWS `walkable`; it can never widen it. See `bakeNavGrid`.
 */
export function traversalForTerrain(tile: TileId): TraversalMask {
  return tile === TERRAIN.WATER ? INFANTRY : ALL_TRAVERSAL
}

/**
 * How fast a man moves while STANDING on this terrain, as a fraction of his
 * ground speed (ticket 007b).
 *
 * Half speed in the water, so crossing the river takes twice as long as
 * crossing the bridge. That is the whole of what makes the bridge a decision
 * rather than scenery: 003a made the river passable, and a crossing that costs
 * nothing is a crossing nobody thinks about.
 *
 * IT IS NEVER ZERO, AND THAT IS A CORRECTNESS RULE RATHER THAN A TUNING ONE. A
 * tile that stops a man dead is an obstacle, and impassability has exactly one
 * spelling in this engine — `traversalForTerrain`, which `bakeNavGrid` folds
 * into the nav grid the flow field is solved over. A speed of zero would be a
 * second spelling that PATHING CANNOT SEE: the field would route a squad
 * happily into the water and the man would stand in it for the rest of the
 * mission, which reads as a hang rather than as terrain.
 *
 * AN UNKNOWN TILE ID MOVES AT FULL SPEED, for the reason `traversalForTerrain`
 * returns `ALL_TRAVERSAL` for one: `TileId` is an open enum, so a level from a
 * newer importer must not silently bog a squad down in terrain this build
 * cannot name.
 *
 * WHAT THIS DOES NOT DO — and it is a real limitation, written down here rather
 * than left to be discovered. PATHING IS NOT TAUGHT THE COST. The flow field
 * treats a water tile as no more expensive than grass, so a squad ordered to
 * the far bank takes the SHORTEST route and not the FASTEST: order a man across
 * and he may wade straight over where a human would have run to the bridge.
 * Fixing that means a weighted flow field rather than a breadth-first one,
 * which is its own ticket with its own performance budget. What it must not
 * become is water made impassable to pathing while passable to movement — that
 * produces a man who cannot be ORDERED into the water but drifts into it.
 */
export function speedMultiplierForTerrain(tile: TileId): number {
  return tile === TERRAIN.WATER ? WATER_SPEED_MULTIPLIER : 1
}

/**
 * The opening value, and it is feel rather than structure: half speed reads as
 * wading without making a crossing feel like a punishment.
 */
const WATER_SPEED_MULTIPLIER = 0.7

/**
 * Whether a man STANDING on this terrain may fire at all (ticket 007b).
 *
 * The other half of what makes the bridge a decision. A man in the water is
 * swimming, not fighting, so crossing under fire is a commitment rather than a
 * slower walk — and it applies to both sides, which is the point: an enemy who
 * wades in to flank cannot shoot while he does it either.
 *
 * THE QUESTION IS ABOUT THE SHOOTER, NEVER THE TARGET. A swimmer is a target
 * like any other; being unable to shoot back is the whole risk of crossing.
 *
 * AN UNKNOWN TILE ID CAN FIRE, matching the two lookups above: a level from a
 * newer importer must not silently disarm a squad standing on terrain this
 * build cannot name.
 */
export function canFireFromTerrain(tile: TileId): boolean {
  return tile !== TERRAIN.WATER
}
