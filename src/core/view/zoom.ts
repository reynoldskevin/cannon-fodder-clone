/**
 * Zoom maths (ticket 009).
 *
 * Engine-free, next to the other `src/core/view` helpers, for the same reason
 * they are: the rig is Three.js plumbing, but the *numbers* it zooms to are
 * decisions and belong on this side of the boundary.
 *
 * The one subtlety these functions exist to encapsulate: the visible ground
 * footprint of the tilted, yawed orthographic camera is a ROTATED rectangle, so
 * "how much viewport do I need to see the whole level?" is not simply the
 * level's width. It is the level's corner reach measured along each of the
 * viewport's own axes.
 */

import type { WorldBounds } from './projection'
import { FLAT_RELIEF, reliefAllowance, type ReliefRange } from './relief'

/** A unit direction on the ground plane (the XZ components of a screen axis). */
export interface GroundAxis {
  readonly x: number
  readonly z: number
}

/**
 * Half-extent the viewport must have along `axis` to cover the whole level.
 *
 * The level is an axis-aligned rectangle centred on the origin, so the largest
 * projection of any of its four corners onto a unit axis is reached by the
 * corner whose signs match the axis's — hence the sum of absolute terms.
 */
export function coverExtent(bounds: WorldBounds, axis: GroundAxis): number {
  const halfX = (bounds.maxX - bounds.minX) / 2
  const halfZ = (bounds.maxZ - bounds.minZ) / 2
  return halfX * Math.abs(axis.x) + halfZ * Math.abs(axis.z)
}

/**
 * The orthographic viewport height (in world units) that frames the ENTIRE level.
 *
 * Two constraints, both of which must hold:
 *   - across the screen: `halfHeight * aspect >= reach along screenRight`
 *   - into the screen:   `halfHeight >= reach along screenUp * sin(elevation)
 *                         + relief allowance * cos(elevation)`
 *
 * The depth term is the ground rectangle seen obliquely: a camera tilted by
 * `elevation` spends `sin(elevation)` of screen height on each unit of ground
 * depth. The relief term is the part this used to miss. A point `h` above the
 * ground plane projects `h * cos(elevation)` further up the screen than the
 * ground beneath it, so extruded terrain makes the level's on-screen silhouette
 * taller than its footprint — by more and more as the camera drops toward the
 * horizon, since `cos` grows as `sin` shrinks. Framing only the footprint
 * therefore pushes the raised far edge off the top of the viewport, which is
 * exactly the clipping this term removes. On a flat level the allowance is 0 and
 * this reduces to the ground-only formula.
 *
 * Relief costs nothing ACROSS the screen: at yaw 0 height projects purely
 * vertically, so the horizontal constraint is untouched.
 *
 * `margin` > 1 leaves a little breathing room around the level edges.
 */
export function fitViewHeight(
  bounds: WorldBounds,
  screenRight: GroundAxis,
  screenUp: GroundAxis,
  aspect: number,
  elevationRad: number,
  margin = 1,
  relief: ReliefRange = FLAT_RELIEF,
): number {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const elevation = Number.isFinite(elevationRad) ? elevationRad : 0
  const acrossHalfHeight = coverExtent(bounds, screenRight) / safeAspect
  const depthHalfHeight =
    coverExtent(bounds, screenUp) * Math.abs(Math.sin(elevation)) +
    reliefAllowance(relief) * Math.abs(Math.cos(elevation))
  return 2 * Math.max(acrossHalfHeight, depthHalfHeight) * margin
}

/**
 * Clamp a requested viewport height into the legal zoom range.
 *
 * `max` is deliberately floored at `min`: on a freakishly small window the
 * fit-to-level height can fall below the closest-zoom limit, and an inverted
 * range must degrade to "as close as allowed", never to NaN or a swap.
 */
export function clampViewHeight(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const hi = max > min ? max : min
  return value < min ? min : value > hi ? hi : value
}
