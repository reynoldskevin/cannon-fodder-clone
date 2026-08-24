/**
 * Camera orientation (ticket 009a).
 *
 * THE DECISION, and why it differs from the brief. PROJECT_BRIEF.md asked for a
 * 45-degree isometric view and ticket 009 shipped one. Seen against the source
 * art it was wrong: `assets/source/levels/level1/map.png` is drawn AXIS-ALIGNED
 * — the tile grid faces the screen squarely, with no 45-degree rotation — and
 * from a very high angle: canopies read as rounded blobs seen from above, only
 * the taller left-edge trees show any side at all, and shadows are short. So the
 * shipped orientation is square (yaw 0) and near top-down.
 *
 * Engine-free, like the rest of `src/core/view`: the rig is Three.js plumbing,
 * but the angles and the extents that follow from them are decisions and belong
 * on this side of the boundary, where they are unit tested.
 *
 * Conventions match `projection.ts`: world is y-up, ground is the XZ plane, yaw
 * is measured about +Y and elevation up from the ground plane.
 */

import type { GroundAxis } from './zoom'

const DEG = Math.PI / 180

/**
 * Yaw about Y, in radians. Exactly zero: the tile grid is axis-aligned with the
 * screen, so world +X is screen-right and world -Z is screen-up.
 *
 * Beyond matching the art, zero yaw is what makes edge-tight camera clamping
 * possible again — see `viewGroundExtents`.
 */
export const YAW = 0

/**
 * Default elevation above the ground plane, in radians. 55 degrees.
 *
 * Why not 90: a true top-down would flatten the raised canopy and blocked-tile
 * geometry into their own footprints, and the 3D read that makes the jungle
 * legible — which tiles you cannot walk through — would go with it.
 *
 * 75 shipped in ticket 009a and was dialled down to 55 in 009b after seeing it
 * live: at 75 a block of height h shows only h*cos(75) = 0.26h of side face on
 * screen, so raised terrain read as flat colour rather than as geometry. At 55
 * that side face is 0.57h — a block reads unmistakably as a block — while the
 * occlusion it costs, h/tan(55) = 0.70h of ground hidden behind it, is still far
 * short of the 1.19h that made ticket 009's 40 degrees unplayable.
 *
 * The same `cos(elevation)` that buys the side face is what makes terrain
 * project up the screen, so this number is also the reason `cover.ts` has to
 * charge the relief allowance against the zoom cap: at 55 that effect is more
 * than twice what it was at 75. It remains a tune-by-eye number, which is
 * exactly why `?elev=` exists: see `parseElevation`.
 */
export const ELEVATION = 55 * DEG

/**
 * Runtime-tunable range for `?elev=`, in degrees.
 *
 * The floor was 55 while 55 was the extreme; since 009b made it the default the
 * band has to open well BELOW it, or the knob can only be turned one way and the
 * next look decision cannot be tested without a rebuild. 25 is the point past
 * which the canopy hides more ground than it reveals; 89 rather than 90 because
 * a camera looking exactly down the Y axis is degenerate for a Y-up `lookAt`.
 */
const MIN_ELEVATION_DEG = 25
const MAX_ELEVATION_DEG = 89

/**
 * Hard guard for the maths below, in radians.
 *
 * Wider than the tunable range on purpose: `parseElevation` decides what a
 * *player* may ask for, while these keep the geometry finite for any caller,
 * including a future cinematic that swings the camera outside the normal band.
 * The floor is what stops `1 / sin(elevation)` running away to Infinity at the
 * horizon; 90 degrees is allowed through untouched because `sin` is perfectly
 * well behaved there.
 */
const SAFE_MIN_ELEVATION = 5 * DEG
const SAFE_MAX_ELEVATION = 90 * DEG

/** Ground-plane axes of the screen: unit vectors, orthogonal, elevation-independent. */
export interface ScreenBasis {
  /** Direction on the ground that moves the view right on screen. */
  readonly right: GroundAxis
  /** Direction on the ground that moves the view up the screen (away from the viewer). */
  readonly up: GroundAxis
}

/** Axis-aligned half-extents of the ground rectangle the viewport can see. */
export interface GroundExtents {
  readonly halfX: number
  readonly halfZ: number
}

/**
 * The screen's two ground-plane axes for a given yaw.
 *
 * Elevation is accepted but deliberately unused for the *direction*: tilting the
 * camera changes how much ground each axis covers, never which way it points.
 * Taking it as a parameter keeps the call sites honest — every caller already
 * has both angles, and a signature that omitted elevation would invite someone
 * to conclude the footprint is elevation-free too, which it is not.
 *
 * Derivation: the camera sits along `(sin yaw cos e, sin e, cos yaw cos e)` and
 * looks back at the ground, so the horizontal component of the view direction —
 * screen "up" — is `(-sin yaw, -cos yaw)`, and screen right is that turned a
 * quarter turn: `(cos yaw, -sin yaw)`. At yaw 0 those are `+X` and `-Z`, which
 * puts tile row 0 at the top of the screen, as the source art is drawn.
 */
export function screenBasis(yawRad: number, elevationRad: number): ScreenBasis {
  // Accepted and deliberately discarded — see the note above. Named rather than
  // underscore-prefixed so the signature documents itself at the call site.
  void elevationRad
  const yaw = Number.isFinite(yawRad) ? yawRad : 0
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  return {
    right: { x: c, z: -s },
    up: { x: -s, z: -c },
  }
}

/**
 * Axis-aligned bounding half-extents of the ground rectangle currently visible.
 *
 * An orthographic camera of world-space height `viewHeight`, tilted by
 * `elevation`, sees `viewHeight * aspect` of ground across the screen and
 * `viewHeight / sin(elevation)` of ground INTO the screen — the depth stretch of
 * looking at a plane obliquely. That rectangle is then rotated by the yaw, and
 * this returns the AABB of the result.
 *
 * WHY THIS IS THE POINT OF THE WHOLE TICKET. At yaw 45 the AABB is ~sqrt(2)
 * larger per axis than the rectangle it bounds, and since the level is itself
 * axis-aligned, "keep the visible ground inside the level" becomes "keep an
 * inflated box inside the level" — a demand so much stricter than what the
 * player can see that ticket 009 had to abandon it and clamp the look-at point
 * instead, showing sky past the level edges. At yaw 0 the rectangle IS its own
 * bounding box, the inflation is exactly 1, and edge-tight clamping costs
 * nothing. Hence `halfX` reducing to `viewHeight * aspect / 2` here.
 *
 * Degenerate inputs are clamped rather than propagated: a NaN half-extent would
 * poison the camera clamp and blank the screen, which is never the right answer
 * to a bad `?elev=` or a zero-height window.
 */
export function viewGroundExtents(
  viewHeight: number,
  aspect: number,
  yawRad: number,
  elevationRad: number,
): GroundExtents {
  const height = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 1
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const elevation = safeElevation(elevationRad)

  const halfAcross = (height * safeAspect) / 2
  const halfDepth = height / 2 / Math.sin(elevation)

  const { right, up } = screenBasis(yawRad, elevation)
  return {
    halfX: halfAcross * Math.abs(right.x) + halfDepth * Math.abs(up.x),
    halfZ: halfAcross * Math.abs(right.z) + halfDepth * Math.abs(up.z),
  }
}

/**
 * Keep elevation inside the band where the depth stretch stays finite.
 *
 * Exported since ticket 009b so the zoom cap in `cover.ts` divides by exactly
 * the same guarded `sin(elevation)` this file does — two different guards would
 * mean two different ideas of where the ground footprint ends, and the gap
 * between them would be background.
 */
export function safeElevation(elevationRad: number): number {
  if (!Number.isFinite(elevationRad)) return ELEVATION
  if (elevationRad < SAFE_MIN_ELEVATION) return SAFE_MIN_ELEVATION
  if (elevationRad > SAFE_MAX_ELEVATION) return SAFE_MAX_ELEVATION
  return elevationRad
}

/**
 * Elevation, in radians, for a `?elev=` query value in DEGREES.
 *
 * Exists so the angle can be dialled in by eye against the source art without a
 * rebuild — it is a look decision, and looking at it is the only way to settle
 * it. Anything unparseable, out of range, or absent falls back to `ELEVATION`
 * rather than failing: a typo in a URL must not be able to break the camera.
 *
 * The accepted band is 25-89 degrees, deliberately open on both sides of the
 * shipped 55 — see `MIN_ELEVATION_DEG`. Out-of-band values are clamped into it
 * rather than rejected, so `?elev=0` still shows you the shallowest view on
 * offer instead of silently doing nothing.
 */
export function parseElevation(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return ELEVATION
  const degrees = Number(raw)
  if (!Number.isFinite(degrees)) return ELEVATION
  if (degrees < MIN_ELEVATION_DEG) return MIN_ELEVATION_DEG * DEG
  if (degrees > MAX_ELEVATION_DEG) return MAX_ELEVATION_DEG * DEG
  return degrees * DEG
}
