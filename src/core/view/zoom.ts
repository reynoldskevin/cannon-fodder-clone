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
 *   - into the screen:   `halfHeight / sin(elevation) >= reach along screenUp`
 *     (a camera tilted by `elevation` sees `halfHeight / sin(elevation)` of
 *     ground depth for `halfHeight` of screen height)
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
): number {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const acrossHalfHeight = coverExtent(bounds, screenRight) / safeAspect
  const depthHalfHeight = coverExtent(bounds, screenUp) * Math.sin(elevationRad)
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
