/**
 * Tile <-> world projection (ticket 009).
 *
 * Engine-free by design (ARCHITECTURE.md — the `src/core/**` boundary): these
 * are the numbers the renderer draws with, so they are unit tested even though
 * the drawing itself is not.
 *
 * Conventions, fixed here once so nothing downstream has to re-derive them:
 *   - World space is **y-up**; the terrain lies in the **XZ** plane at y = 0.
 *   - Tile x grows with world x, tile y grows with world z.
 *   - A level is **centred on the world origin**, whatever its size, so the
 *     camera rig has a stable pivot and clamping is symmetric.
 */

import type { LevelSize } from '../level'

/** Edge length of one tile in world units. */
export const TILE_WORLD_SIZE = 1

/** A point on the ground plane. `y` is always 0 — kept so callers can feed a Vector3. */
export interface WorldPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A tile coordinate in the level grid. */
export interface TileCoord {
  readonly x: number
  readonly y: number
}

/** Axis-aligned extent of a level on the ground plane. */
export interface WorldBounds {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/**
 * Centre of tile (`x`, `y`) in world space.
 *
 * The `(n - 1) / 2` offset is what centres the level: it maps the *first* and
 * *last* tile centres to equal-and-opposite offsets, leaving half a tile of
 * geometry beyond each on either side.
 */
export function tileToWorld(x: number, y: number, size: LevelSize): WorldPoint {
  return {
    x: (x - (size.w - 1) / 2) * TILE_WORLD_SIZE,
    y: 0,
    z: (y - (size.h - 1) / 2) * TILE_WORLD_SIZE,
  }
}

/**
 * The tile containing a world-space point, clamped to the grid.
 *
 * Clamping rather than returning `null` for an off-map point: every caller
 * (pointer picking, pathing hints) wants the nearest legal tile, and a `null`
 * would just be re-clamped at each call site.
 *
 * NOTE: `src/input/pointer-controller.ts` reimplements this mapping (minus the
 * clamp — an off-map click is refused there, not snapped) because importing
 * `core/view` from `src/input` would breach the layering rule. Change the maths
 * here and that copy needs the same change.
 */
export function worldToTile(wx: number, wz: number, size: LevelSize): TileCoord {
  return { x: worldToTileX(wx, size), y: worldToTileY(wz, size) }
}

/**
 * The two axes of `worldToTile`, separately — same rounding, same clamp, no
 * object.
 *
 * `worldToTile` is DEFINED in terms of these rather than the other way round, so
 * there is exactly one spelling of the mapping in the codebase and no chance of
 * the pair drifting half a tile apart. They exist for the per-tick callers (the
 * AI's order and aim dedupes, `core/ai/system.ts`) that need to know WHICH TILE a
 * position is in without allocating a `TileCoord` to find out, 60 times a second,
 * only to discover the answer has not changed. Prefer `worldToTile` anywhere the
 * coordinate is actually used as a pair.
 */
export function worldToTileX(wx: number, size: LevelSize): number {
  return clamp(Math.round(wx / TILE_WORLD_SIZE + (size.w - 1) / 2), 0, size.w - 1)
}

export function worldToTileY(wz: number, size: LevelSize): number {
  return clamp(Math.round(wz / TILE_WORLD_SIZE + (size.h - 1) / 2), 0, size.h - 1)
}

/** The level's full extent on the ground plane, symmetric about the origin. */
export function levelWorldBounds(size: LevelSize): WorldBounds {
  const halfX = (size.w * TILE_WORLD_SIZE) / 2
  const halfZ = (size.h * TILE_WORLD_SIZE) / 2
  return { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ }
}
