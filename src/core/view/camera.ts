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
 * impossible". WHICH half-extents get handed to it is the caller's decision.
 * Since ticket 009a the rig hands it the real visible ground footprint
 * (`viewGroundExtents` at yaw 0), which makes the clamp edge-tight: no
 * background can appear past the level edge, and a level that already fits on
 * screen is centred by the inverted-range branch below.
 */
export interface ViewportExtent {
  readonly halfW: number
  readonly halfZ: number
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
