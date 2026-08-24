/**
 * Camera rig maths (ticket 009).
 *
 * The rig itself is Three.js and untested by design; every *decision* it makes
 * lives here, engine-free and unit tested: where the camera is allowed to look,
 * how it eases toward that point, and how screen shake decays.
 */

import type { WorldBounds } from './projection'

/** A point on the ground plane the camera looks at. */
export interface GroundPoint {
  readonly x: number
  readonly z: number
}

/**
 * Half-extents, in world units, of the margin the camera target must keep from
 * the level edge on each axis.
 *
 * A general shape rather than a fixed policy: `clampCameraTarget` only knows
 * "keep the target this far inside the level, or centre it if that is
 * impossible". WHICH half-extents get handed to it is the caller's decision —
 * see `panClampExtent` for the one the rig makes and why.
 */
export interface ViewportExtent {
  readonly halfW: number
  readonly halfZ: number
}

/**
 * The half-extents to clamp the camera target with, given whether the whole
 * level currently fits on screen.
 *
 * THE RULE, and its consequence, spelled out once:
 *
 *   - Level NOT fully visible: `{0, 0}`. `clampCameraTarget` then keeps the
 *     *look-at point* inside the level rectangle, so EVERY tile — corners
 *     included — can be brought to screen centre at every zoom level. Panned
 *     hard into a corner this shows sky past the level edge; the scene's sky
 *     colour and matching fog make that read as a deliberate matte, exactly as
 *     it does in the fit view. That is the price, and it is the right one: the
 *     alternative (never show void) makes the outer third of the map
 *     unreachable at mid zoom and turns panning into a silent no-op.
 *   - Level fully visible: the level's own half-extents. That is precisely the
 *     inverted-range case of `clampCameraTarget`, so the level is centred and
 *     stays centred — panning a level that is already entirely on screen would
 *     only slide it around inside a frame of void.
 *
 * Zero is the TIGHTEST extent that satisfies "every tile can be centred":
 * centring a corner requires the target to sit on it, so the allowed region can
 * be no smaller than the level rectangle itself.
 */
export function panClampExtent(bounds: WorldBounds, levelFullyVisible: boolean): ViewportExtent {
  if (!levelFullyVisible) return { halfW: 0, halfZ: 0 }
  return {
    halfW: (bounds.maxX - bounds.minX) / 2,
    halfZ: (bounds.maxZ - bounds.minZ) / 2,
  }
}

/** Shake decays at this fraction-per-second (exponential). */
const SHAKE_DECAY_PER_SECOND = 8

/**
 * Below this the shake is snapped to exactly 0.
 *
 * An exponential decay is asymptotic and never reaches zero, so without a snap
 * the rig would jitter the camera by sub-micron amounts forever and the "is the
 * shake finished?" question would have no answer.
 */
const SHAKE_EPSILON = 1e-4

/**
 * Clamp the camera's look-at point to the level, inset by `view` on each axis.
 *
 * When the inset is *wider* than the level on an axis there is no valid pan
 * range at all — the clamp would invert and produce nonsense — so the level is
 * centred on that axis instead.
 */
export function clampCameraTarget(
  target: GroundPoint,
  bounds: WorldBounds,
  view: ViewportExtent,
): GroundPoint {
  return {
    x: clampAxis(target.x, bounds.minX, bounds.maxX, view.halfW),
    z: clampAxis(target.z, bounds.minZ, bounds.maxZ, view.halfZ),
  }
}

function clampAxis(value: number, min: number, max: number, half: number): number {
  const lo = min + half
  const hi = max - half
  if (lo > hi) return (min + max) / 2
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * One frame of smooth follow toward `target`.
 *
 * Framerate-independent exponential easing: the blend factor is
 * `1 - e^(-stiffness * dt)`, which is bounded to [0, 1] for any positive
 * timestep, so a frame spike converges *at* the target instead of flinging the
 * camera past it and oscillating — the failure mode of a naive `p += (t - p) * k * dt`.
 */
export function followStep(
  current: GroundPoint,
  target: GroundPoint,
  stiffness: number,
  dt: number,
): GroundPoint {
  if (!(dt > 0) || !(stiffness > 0)) return { x: current.x, z: current.z }
  const blend = 1 - Math.exp(-stiffness * dt)
  const t = blend < 0 ? 0 : blend > 1 ? 1 : blend
  return {
    x: current.x + (target.x - current.x) * t,
    z: current.z + (target.z - current.z) * t,
  }
}

/** One frame of screen-shake decay. Reaches exactly 0 and stays there. */
export function shakeStep(amount: number, dt: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  if (!(dt > 0)) return amount
  const next = amount * Math.exp(-SHAKE_DECAY_PER_SECOND * dt)
  return next < SHAKE_EPSILON ? 0 : next
}

/**
 * Average of a set of ground points — the squad centroid the camera follows.
 *
 * An empty list returns the origin rather than NaN: a wiped squad must not
 * blank the screen by sending the camera to an unrenderable position.
 */
export function centroid(points: readonly GroundPoint[]): GroundPoint {
  if (points.length === 0) return { x: 0, z: 0 }
  let x = 0
  let z = 0
  for (const p of points) {
    x += p.x
    z += p.z
  }
  return { x: x / points.length, z: z / points.length }
}
