/**
 * How much of a man the terrain he is standing on hides (ticket 041).
 *
 * Before this, nothing in the codebase had a submersion concept at all:
 * `terrain-style.ts` puts the water surface at `-0.12` and the session places
 * every unit at the ground height, so a soldier crossing the river stood with
 * his feet ON it, a tenth of a tile below grade and otherwise entirely dry. The
 * fire gate (ticket 007b) was already silencing him, so the player watched a man
 * walk across water and stop shooting for no visible reason — a rule the player
 * cannot see is a rule the player experiences as a bug.
 *
 * A FRACTION, NOT A DISTANCE, AND THAT SPLIT IS THE WHOLE INTERFACE. How tall a
 * soldier is DRAWN is a sprite metric: it comes off the atlas manifest, and it
 * is multiplied again by the renderer's `1 / cos(elevation)` pre-stretch, which
 * moves with a runtime camera knob. `src/core/**` may not import the renderer
 * and must not restate either number. So core answers "how much of him is under"
 * and `src/render/entity-renderer.ts` turns that into world units against the
 * quad height only it has.
 *
 * A PLAIN TILE ID IN, DELIBERATELY — not a world, not an entity. `core/view` may
 * not import `core/combat`, `core/ordnance` or `core/world`, so the caller does
 * the lookup and this module stays a table.
 */

import { TERRAIN } from '../level/terrain'
import type { TileId } from '../level/types'

/**
 * How much of a wading man is below the water surface, as a fraction of his
 * drawn height.
 *
 * CHEST-DEEP, and both ends of that are load-bearing rather than taste. At 0 the
 * ticket is a no-op and nothing on screen changed; at 1 the man is entirely
 * behind the water plane and simply disappears mid-crossing, which reads as the
 * river deleting units rather than as men wading through it. 0.7 leaves head,
 * shoulders and rifle above the surface — enough silhouette to keep a unit the
 * player is trying to command visible and selectable while it crosses.
 *
 * It is also the number the ORDNANCE gate is argued from: at 70% under he is
 * chest-deep in a current, which is why ticket 007b's "a man can plausibly throw
 * a grenade while wading" no longer holds. See `core/ordnance/system.ts`.
 *
 * Not measured against a running build — nobody has watched this — so it is an
 * opening value chosen to sit clear of both failure ends, and the unit test
 * bounds it rather than pinning it, so it can be tuned without a test edit.
 */
export const SUBMERSION_FRACTION = 0.7

/**
 * How deep a man standing on `tile` is, in `[0, 1)`.
 *
 * THE BRIDGE IS ZERO, AND THAT IS THE ENTIRE POINT OF THE BRIDGE. Every deck
 * tile of level 2's crossing is surrounded by water and the deck spans it, so a
 * rule keyed off being NEAR water — a neighbour scan, a distance field — would
 * sink the squad while it walked over the thing built to keep them out of the
 * river, undoing tickets 033 and 035 in one line. The question is only ever
 * about the tile a man is standing ON, exactly as `canFireFromTerrain`'s is.
 *
 * AN UNKNOWN TILE ID IS DRY, matching every other lookup in `level/terrain.ts`.
 * `TileId` is an open enum by design, and a man mysteriously waist-deep in a
 * field on a level from a newer importer is a stranger bug than one who is not
 * submerged where he should be.
 *
 * NO EXPLICIT `NaN` GUARD IS NEEDED and none is written: a strict comparison
 * against `TERRAIN.WATER` is false for `NaN` and both infinities, so they take
 * the dry branch and the result is always one of two finite constants. That
 * matters because the value is multiplied by a sprite height and subtracted from
 * a world position — a `NaN` there puts the soldier nowhere at all, and nothing
 * on screen explains a unit that has stopped being drawn.
 */
export function submersionFor(tile: TileId): number {
  return tile === TERRAIN.WATER ? SUBMERSION_FRACTION : 0
}
