/**
 * Flight, as pure arithmetic (ticket 015).
 *
 * NO GRID, NO WORLD, NO CLOCK. Where a projectile is at tick *n* is a function
 * of where it left from, where it was aimed and the spec it was launched with —
 * nothing else. Two things fall out of that and both are load-bearing:
 *
 *   - THE ARC IS ASSERTABLE BY INSPECTION. Height, apex and landing point are
 *     numbers a test can check without a world to throw a grenade in.
 *   - THE COVER CLAMP LIVES IN `system.ts`, where the grid is. A `flat`
 *     projectile stopping at a wall genuinely needs terrain, so it is applied to
 *     the AIM POINT before a trajectory is planned rather than inside the
 *     integration — which is what keeps this file free of the grid entirely.
 *
 * A TRAJECTORY IS SOLVED ONCE, AT LAUNCH, AND THEN ONLY SAMPLED. Nothing here
 * accumulates a velocity from tick to tick. Step integration would make a
 * projectile's landing point depend on how many times it had been asked where it
 * was — so a renderer sampling between ticks would perturb the simulation — and
 * it would drift a grenade off the point the player aimed at, at which point the
 * blast radius is covering for the error rather than being the mechanic.
 *
 * TIME IS TICKS and speed is tiles per tick, exactly as `combat/weapons.ts`
 * measures a cooldown. See the header of `table.ts` for why.
 */

import { GRAVITY_TILES_PER_TICK_SQUARED } from './table'
import type { OrdnanceSpec } from './table'

/** A sampled point along a flight. World units; `y` is height above the ground. */
export interface FlightPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * A solved flight: everything `positionAt` needs, and nothing that changes.
 *
 * Held by the system for the life of the projectile and never mutated, so two
 * samples of the same trajectory can never disagree.
 */
export interface Trajectory {
  /** Where it left from, in world units. */
  readonly originX: number
  readonly originZ: number
  /** Where it arrives, in world units — already cover-clamped by the caller. */
  readonly targetX: number
  readonly targetZ: number
  /**
   * Whole ticks from launch to impact. Always a positive integer: the sim has
   * no half ticks, and a flight of zero divides by zero when the arc is solved.
   */
  readonly flightTicks: number
  /**
   * Initial upward velocity in tiles per tick, chosen so height returns to zero
   * exactly at `flightTicks`. Zero for a flat arc.
   */
  readonly verticalVelocity: number
  /**
   * Downward acceleration in tiles per tick squared.
   *
   * ZERO for a flat arc, and that is not the same as gravity with a zero
   * initial velocity: the latter puts the projectile underground on tick 1.
   */
  readonly gravity: number
}

/**
 * Solve the flight from (`originX`, `originZ`) to (`targetX`, `targetZ`) for
 * `spec`. All four coordinates are WORLD units.
 *
 * FLIGHT TIME is `max(1, ceil(distance / speed))` ticks. Ceiling because the sim
 * has no half ticks and a projectile must land ON one; the floor of 1 because a
 * zero-tick flight would detonate inside the tick that launched it, before
 * anything — a renderer, a test, a player — had a chance to see it exist.
 *
 * HOSTILE INPUT IS ARITHMETIC, NOT A THROW. A table is data somebody will get
 * wrong, and both bad cases here are silent rather than loud: a zero-length
 * throw (right-clicking the tile you are standing on) has no direction and would
 * produce `NaN` coordinates that propagate into a blast centre and damage nobody
 * anywhere; a non-positive speed makes `ceil(distance / 0)` infinite, and a
 * projectile with an infinite flight time never detonates, never expires and
 * never leaves the in-flight array — a leak that looks exactly like a grenade
 * that did nothing. Both fall back to the minimum flight rather than being
 * refused, because a refusal here would have to be handled at every call site.
 *
 * HORIZONTAL VELOCITY IS CONSTANT even for a ballistic arc: the projectile
 * travels a straight line in plan view and only the height is curved. A grenade
 * that curved sideways is a mortar shell with windage, and the player aiming it
 * has no way to predict where it goes.
 */
export function planTrajectory(
  spec: OrdnanceSpec,
  originX: number,
  originZ: number,
  targetX: number,
  targetZ: number,
): Trajectory {
  const distance = Math.hypot(targetX - originX, targetZ - originZ)
  const speed = spec.speedTilesPerTick
  // Written as a positive test so a NaN speed falls out on the safe side, the
  // same discipline `inRange` documents at length: every comparison against NaN
  // is false, so `speed > 0` is false and the minimum flight is used.
  const raw = speed > 0 ? Math.ceil(distance / speed) : 1
  const flightTicks = Number.isFinite(raw) && raw > 1 ? raw : 1

  // A flat arc gets NO gravity term at all rather than gravity with a zero
  // initial velocity — see `Trajectory.gravity`.
  const gravity = spec.arc === 'ballistic' ? GRAVITY_TILES_PER_TICK_SQUARED : 0
  // `v0 = g * T / 2` is the launch velocity for which `y(T) = 0`: it climbs for
  // half the flight and falls for the other half, which is why the apex is at
  // `T / 2` and why a longer throw is also a higher one.
  const verticalVelocity = (gravity * flightTicks) / 2

  return { originX, originZ, targetX, targetZ, flightTicks, verticalVelocity, gravity }
}

/**
 * Where the projectile is `tick` ticks after launch. `tick` may be fractional —
 * the renderer interpolates between simulation steps and samples in between.
 *
 * CLAMPED AT BOTH ENDS. Past the landing the parabola continues downward and the
 * last frame of a grenade would be drawn under the map, which a long frame asks
 * for routinely; before the launch there is nothing to report but the muzzle.
 * Clamping is what makes reading outside the flight harmless rather than a
 * source of positions no projectile ever occupied.
 *
 * A FRESH POINT EVERY CALL, never one shared buffer. Reusing a single object is
 * the obvious allocation win and it means a caller holding two samples is
 * holding the same sample twice — the trap `render-state/tracers.ts` already
 * caught once. This is called a handful of times per projectile per frame, not
 * per entity per tick, so the allocation is not on a hot path.
 */
export function positionAt(trajectory: Trajectory, tick: number): FlightPoint {
  const { flightTicks } = trajectory
  const t = tick < 0 ? 0 : tick > flightTicks ? flightTicks : tick
  // `flightTicks` is guaranteed >= 1 by `planTrajectory`, so this never divides
  // by zero — which is the reason that floor exists.
  const along = t / flightTicks
  return {
    x: trajectory.originX + (trajectory.targetX - trajectory.originX) * along,
    y: trajectory.verticalVelocity * t - 0.5 * trajectory.gravity * t * t,
    z: trajectory.originZ + (trajectory.targetZ - trajectory.originZ) * along,
  }
}
