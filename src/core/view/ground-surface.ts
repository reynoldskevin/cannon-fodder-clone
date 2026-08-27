/**
 * Which tileable ground texture a tile's TOP face samples (ticket 034).
 *
 * Before this, every top sampled one image — the jungle floor — and terrain was
 * separated by tint alone. That is right for grass, canopy and rock, which share
 * an image on purpose (three images would put a hard, axis-aligned seam at every
 * boundary between them; see `CANOPY_COLOUR` in `terrain-style`). It is wrong for
 * water and the bridge, which have art of their own: the river was jungle floor
 * tinted blue and the deck was jungle floor tinted brown.
 *
 * WHY THIS IS HERE AND NOT IN THE RENDERER. Not because `src/render` is
 * untestable — `src/render/__tests__` exists and runs in node in milliseconds,
 * because geometry, materials and textures are plain objects until a
 * `WebGLRenderer` uploads them. What genuinely cannot be checked under
 * `environment: 'node'` is narrower: shaders, uploads, draw calls, and anything
 * that reads pixels back.
 *
 * The reason is that this is a DECISION rather than plumbing. The renderer's job
 * is to turn this answer into a geometry group; the answer itself belongs in
 * `core`, the engine-free layer, where the simulation can read it too — the same
 * argument `terrain-style` makes about colour and height.
 */

import { TERRAIN } from '../level/terrain'
import type { TileId } from '../level/types'

/**
 * Every ground surface the renderer can ask for, in a fixed order.
 *
 * The same list `tools/spritegen`'s `GROUND_TEXTURES` emits, restated here for
 * the reason `core/level/terrain` restates `tools/mapgen`'s tile ids: `tools/`
 * is offline build-time tooling and must never be linked into the game, so
 * `src/core/**` does not depend on it.
 */
export const GROUND_SURFACES = ['jungle', 'water', 'bridge'] as const
export type GroundSurface = (typeof GROUND_SURFACES)[number]

/**
 * The ground texture a tile is drawn on.
 *
 * EVERYTHING ELSE FALLS BACK TO THE JUNGLE, INCLUDING AN ID THIS BUILD HAS NEVER
 * SEEN. `TileId` is an open enum — `types.ts` states that adding one must never
 * be a schema break — so this has to answer for a level from a newer importer.
 * The jungle is the answer that covers the map. Throwing, or returning a surface
 * with no texture behind it, would put an untextured hole in a level that a
 * merely-out-of-date build could otherwise draw fine. The same argument
 * `traversalForTerrain` makes about passability: degrade to the harmless answer,
 * never to the one that breaks the level.
 */
export function groundSurfaceFor(tileId: TileId): GroundSurface {
  if (tileId === TERRAIN.WATER) return 'water'
  if (tileId === TERRAIN.BRIDGE) return 'bridge'
  return 'jungle'
}
