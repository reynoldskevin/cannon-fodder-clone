/**
 * Choosing which of the eight sprite directions to draw (ticket 010).
 *
 * Engine-free by design (ARCHITECTURE.md — the `src/core/**` boundary): the
 * renderer asks these functions which row of the sprite sheet to sample, so the
 * decision is unit tested even though the drawing is not.
 *
 * WORLD CONVENTION, fixed by `src/core/view/projection.ts`: y-up, terrain in
 * XZ, yaw 0. `+x` is screen-right and `+z` is screen-down — toward the camera.
 * So **north is `-z`**: the back view, a soldier walking away from the viewer,
 * which is the sprite sheet's `N` row.
 */

/** The eight compass points, clockwise from north — the sprite sheet's own order. */
export const FACINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

export type Facing = (typeof FACINGS)[number]

/**
 * What a unit with no direction at all faces.
 *
 * South — toward the camera. A stationary unit with no history should be
 * looking at the player, not showing its back; and this is only ever reached by
 * `facingFromVector`, because `stableFacing` keeps the previous facing instead.
 *
 * Exported because a renderer holding hysteresis memory has to seed it with
 * something on an entity's first frame, and that seed is this same decision.
 * `FACINGS[0]` is 'N' and would put a newly spawned idle unit's back to the
 * player — the exact failure this constant exists to avoid.
 */
export const DEFAULT_FACING: Facing = 'S'

const SECTOR = (Math.PI * 2) / FACINGS.length

/**
 * Extra angle a direction must travel past a sector boundary before the sprite
 * changes, in radians (10 degrees on top of the 22.5-degree half-sector).
 *
 * This is the whole point of `stableFacing`. A unit walking almost due north
 * has a direction vector that lands either side of the N/NE boundary from tick
 * to tick, and an undamped mapping strobes between two sprites — which reads as
 * a graphical fault rather than as movement. Ten degrees is comfortably more
 * than steering noise and comfortably less than a real turn.
 */
const HYSTERESIS = (10 * Math.PI) / 180

/** Signed angle from north, clockwise, in radians. */
function bearing(dx: number, dz: number): number {
  // atan2(east, north): east is +x, north is -z.
  return Math.atan2(dx, -dz)
}

/** Shortest signed distance between two angles, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/**
 * The compass sprite for a direction vector on the ground plane.
 *
 * Magnitude is irrelevant — only the bearing matters. A zero or non-finite
 * vector has no bearing at all, so it falls back to `DEFAULT_FACING` rather
 * than to a NaN index; `atan2(0, 0)` is 0 in JavaScript, which would silently
 * mean "north" and leave every idle unit facing away from the player.
 */
export function facingFromVector(dx: number, dz: number): Facing {
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return DEFAULT_FACING
  if (dx === 0 && dz === 0) return DEFAULT_FACING

  const index = Math.round(bearing(dx, dz) / SECTOR)
  // `%` keeps the sign in JS, so -1 must be brought back into range.
  const wrapped = ((index % FACINGS.length) + FACINGS.length) % FACINGS.length
  return FACINGS[wrapped] ?? DEFAULT_FACING
}

/**
 * The facing to draw this frame, given the one drawn last frame.
 *
 * Hysteresis: the current facing is kept until the direction is more than
 * `HYSTERESIS` *past* the edge of its sector. A vector that wobbles around a
 * boundary therefore holds one sprite, while a genuine turn still switches
 * immediately and settles on the new sector.
 *
 * A stationary unit keeps facing where it was facing. Snapping it back to a
 * default would spin every unit round the instant it stopped walking.
 */
export function stableFacing(current: Facing, dx: number, dz: number): Facing {
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return current
  if (dx === 0 && dz === 0) return current

  const index = FACINGS.indexOf(current)
  // An unknown incoming facing has no sector to be sticky about; fall through
  // to the raw mapping rather than trusting a value we cannot place.
  if (index < 0) return facingFromVector(dx, dz)

  const drift = Math.abs(angleDelta(bearing(dx, dz), index * SECTOR))
  if (drift <= SECTOR / 2 + HYSTERESIS) return current
  return facingFromVector(dx, dz)
}
