/**
 * Terrain relief — how far the level's geometry rises above and falls below the
 * ground plane (ticket 009a).
 *
 * WHY THIS EXISTS. Everything else in `src/core/view` frames the level as a flat
 * rectangle on y = 0, because for panning and clamping that is exactly right:
 * the camera looks at the ground plane and the pan range is a ground-plane
 * question. Fit-to-level is the one place where it is wrong. The terrain is
 * extruded — blocked tiles and canopy stand proud of the ground, water sits
 * below it, and the map's outer edge drops away to a skirt — so the shape the
 * player actually sees is TALLER than the ground rectangle, and at a tilted
 * camera that extra height projects straight up and down the screen. Framing the
 * ground rectangle therefore frames slightly less than the level, and the raised
 * far edge is the first thing to be pushed off the top of the viewport.
 *
 * The allowance is derived from the level's REAL tiles rather than a constant:
 * `tileStyle` heights are data (`TILE_STYLES` is editable, tile ids are an open
 * enum, and an unknown id resolves to the fallback style), so a hardcoded guess
 * would silently stop covering the map the day mapgen emits something taller.
 *
 * Engine-free like its neighbours: `TerrainRenderer` bakes exactly these numbers
 * into geometry, so the fit and the mesh cannot disagree.
 */

import type { LevelData } from '../level'
import { tileStyle } from './terrain-style'

/**
 * Bottom of the skirt the renderer drops at the map edge, in world units.
 *
 * Lives here rather than in the renderer because it is part of the level's
 * on-screen silhouette: the near edge of the map shows this face, so fit-to-level
 * has to leave room for it. `TerrainRenderer` imports it, which keeps one
 * definition rather than two numbers that must be remembered to match.
 */
export const TERRAIN_SKIRT_FLOOR = -1.5

/** Lowest and highest world-space y of a level's baked terrain geometry. */
export interface ReliefRange {
  readonly min: number
  readonly max: number
}

/**
 * The relief of a perfectly flat level: no allowance at all.
 *
 * The default for callers that have no terrain to measure, so "I don't know"
 * reproduces the flat-ground framing rather than inventing an allowance.
 */
export const FLAT_RELIEF: ReliefRange = { min: 0, max: 0 }

/**
 * The vertical span of the geometry `TerrainRenderer` will build for `level`.
 *
 * `max` is the tallest tile top; `min` is the lowest surface the mesh reaches,
 * which is the skirt floor rather than the lowest tile — the map edge always
 * drops to it, so it is always part of the silhouette.
 *
 * Missing or ragged rows degrade to tile id 0 / not-walkable, matching
 * `TerrainRenderer`'s own `?? 0` / `?? false`: a malformed level must produce a
 * slightly-too-generous frame, never a NaN that blanks the camera.
 */
export function levelRelief(level: LevelData): ReliefRange {
  let max = 0
  let min = TERRAIN_SKIRT_FLOOR
  for (let y = 0; y < level.size.h; y += 1) {
    const terrainRow = level.terrain[y]
    const walkRow = level.walkable[y]
    for (let x = 0; x < level.size.w; x += 1) {
      const { height } = tileStyle(terrainRow?.[x] ?? 0, walkRow?.[x] ?? false)
      if (!Number.isFinite(height)) continue
      if (height > max) max = height
      if (height < min) min = height
    }
  }
  return { min, max }
}

/**
 * Half-height, in world units, that framing must add ABOVE and BELOW the ground
 * plane to contain the relief.
 *
 * Deliberately symmetric — the larger of the two overhangs, applied both ways —
 * because the camera looks at the ground plane and the only way to frame an
 * asymmetric silhouette *asymmetrically* is to aim the camera off the ground,
 * which is precisely what would break the edge-tight pan clamp (it reasons about
 * where the ground plane meets the viewport). One symmetric number costs a few
 * pixels of extra margin on one side and keeps the clamp honest.
 */
export function reliefAllowance(relief: ReliefRange): number {
  const above = Number.isFinite(relief.max) && relief.max > 0 ? relief.max : 0
  const below = Number.isFinite(relief.min) && relief.min < 0 ? -relief.min : 0
  return above > below ? above : below
}
