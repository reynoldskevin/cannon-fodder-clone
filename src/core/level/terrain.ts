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
 * offline Node tooling and the eslint boundary forbids `src/core/**` from
 * importing it — the importer runs once at build time and must never be linked
 * into the game. So the ids are restated here, exactly as
 * `core/render-state/scenery.ts` already restates `CANOPY_TILE_ID = 2` with the
 * same pointer comment, and exactly as `core/world`'s `DEFAULT_HEALTH`
 * restates `core/combat`'s `INFANTRY_HEALTH` rather than depending upward.
 *
 * NO TEST ASSERTS THE TWO AGREE, and one would be a lie: nothing in this repo
 * can import both tables, so any such test would have to hardcode the numbers a
 * third time and would only ever prove itself. `tools/mapgen/terrain.ts` is the
 * source of truth; a change there is a change here, by hand.
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
