/**
 * The sky-free zoom cap (ticket 009b).
 *
 * THE DECISION THIS ENCODES, and what it costs. Ticket 009a capped zoom-out at
 * the *fit* height: the viewport that frames the whole level. That framing is,
 * by construction, larger than the level on at least one axis, so the whole-map
 * view always showed background around the map. The owner's rule after seeing it
 * live is absolute — the background must NEVER be visible — so zoom-out now stops
 * at the largest viewport whose visible ground footprint still lies entirely
 * INSIDE the level.
 *
 * The consequence is deliberate and accepted: the whole map can no longer be
 * seen at once. On level 1 (57x45) at 16:9 and 55 degrees the widest sky-free
 * view spans the full 57-tile width but only about 39 of the 45 tiles of depth.
 * `F` / `Home` therefore mean "zoom out as far as is allowed", not "fit".
 *
 * Engine-free like the rest of `src/core/view`: `CameraRig` is Three.js plumbing,
 * but the limit is a decision, so it lives here and is unit tested.
 *
 * THE GEOMETRY. At yaw 0 (see `orientation.ts`) the visible ground rectangle is
 * axis-aligned, so containment is two independent one-dimensional questions:
 *
 *   across the screen: `viewHeight * aspect / 2 <= half the level width`
 *   into the screen:   `viewHeight / 2 / sin(elevation) <= half the level depth`
 *
 * ...and the tighter of the two binds. The second one is not the whole story,
 * which is the part a flat-footprint cap gets wrong: the terrain is extruded, and
 * a surface `h` above the ground plane projects `h * cos(elevation)` FURTHER UP
 * the screen than the ground beneath it. The far edge of the map (screen top, at
 * `minZ`) can be as low as `relief.min` — water, or the skirt — so the top of the
 * geometry that is guaranteed to be there sits up to `reliefAllowance * cos(e)`
 * BELOW the far edge's ground line. Anything above that on screen is background.
 * At 75 degrees `cos` is 0.259 and the effect is small; at 55 it is 0.574, more
 * than twice as expensive, which is exactly why this ticket had to add it.
 *
 * The allowance is symmetric and comes from `relief.ts`, the same source
 * fit-to-level uses, so the cap and the mesh cannot disagree about how tall the
 * level is.
 *
 * The near edge (screen bottom) needs no such allowance: the map's outer edge
 * drops to the skirt floor, so the near-edge geometry extends BELOW its ground
 * line, past the bottom of the viewport rather than short of it.
 */

import type { WorldBounds } from './projection'
import { safeElevation } from './orientation'
import { reliefAllowance, type ReliefRange } from './relief'

/**
 * Smallest cap this will ever return, in world units.
 *
 * Only reachable through nonsense — relief taller than the level, a level one
 * tile across — where there is no honest sky-free viewport at all. A positive
 * number keeps the zoom range orientable; `clampViewHeight` then floors the
 * range at the rig's minimum, so the practical outcome is "as close as allowed".
 * Returning 0 or a negative here would invert the range and hand NaN to the
 * frustum, which blanks the screen.
 */
const MIN_CAP_VIEW_HEIGHT = 1e-3

/**
 * Ground depth, in world units, that must be left between the far edge of the
 * level and the top of the viewport so that raised — or sunken — terrain at that
 * edge cannot leave background above it.
 *
 * `reliefAllowance * cos(e)` of screen height converts to
 * `reliefAllowance * cos(e) / sin(e)` of ground depth, i.e. the allowance times
 * `cot(elevation)`: shallower cameras pay more, a straight-down camera pays
 * nothing. Exported because the pan clamp needs the same number — the cap alone
 * only guarantees the footprint FITS, and it is the clamp that decides where the
 * footprint may sit.
 */
export function farEdgeReliefInset(relief: ReliefRange, elevationRad: number): number {
  const elevation = safeElevation(elevationRad)
  const allowance = reliefAllowance(relief)
  return (allowance * Math.cos(elevation)) / Math.sin(elevation)
}

/**
 * The level bounds the camera target may be clamped against, given the relief.
 *
 * The level rectangle with its FAR edge (`minZ`, the top of the screen) pushed in
 * by `farEdgeReliefInset`, and nothing else moved. The inset is asymmetric
 * because the problem is: the near edge needs none (the map's skirt drops BELOW
 * its ground line, past the bottom of the viewport), and the left and right
 * edges need none (at yaw 0 height projects straight up the screen). Feeding
 * these to `clampCameraTarget` alongside the real visible footprint is what turns
 * the cap below into the actual no-sky guarantee at every pan position, not
 * merely at the centre.
 *
 * The pairing with `maxSkyFreeViewHeight` is exact on Z: at the cap the legal
 * range on that axis has collapsed to a single point, so the axis is genuinely
 * fully covered rather than silently pinned. On X the cap is the conservative
 * one and these bounds are the honest ones, which leaves a sliver of real
 * horizontal pan even when fully zoomed out.
 */
export function skyFreePanBounds(
  bounds: WorldBounds,
  relief: ReliefRange,
  elevationRad: number,
): WorldBounds {
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minZ: bounds.minZ + farEdgeReliefInset(relief, elevationRad),
    maxZ: bounds.maxZ,
  }
}

/**
 * The largest viewport height, in world units, that can never show background.
 *
 * The minimum of the two constraints in the module note, with the relief
 * allowance charged to the depth one. It is always at or below the fit height —
 * it is the same geometry read the other way round, "inside" instead of
 * "around" — so adopting it can only ever be more conservative than what shipped
 * in 009a.
 *
 * Degenerate inputs are clamped rather than propagated, for the same reason
 * `viewGroundExtents` clamps them: a NaN or negative zoom limit poisons the
 * frustum and blanks the screen, which is never the right answer to a bad
 * `?elev=`, a zero-height window, or a level whose terrain is taller than it is
 * wide.
 */
export function maxSkyFreeViewHeight(
  bounds: WorldBounds,
  aspect: number,
  elevationRad: number,
  relief: ReliefRange,
): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const elevation = safeElevation(elevationRad)

  const width = Math.abs(bounds.maxX - bounds.minX)
  const depth = Math.abs(bounds.maxZ - bounds.minZ)
  // The relief allowance, in SCREEN units: how much of the viewport the extruded
  // terrain can fail to fill at the edge it is measured against.
  const reliefScreen = reliefAllowance(relief) * Math.cos(elevation)

  // Into the screen: the level's depth is worth `depth * sin(e)` of screen
  // height, less the band at the top the far edge's relief cannot be trusted to
  // cover. This is the exact constraint.
  const depthLimit = depth * Math.sin(elevation) - reliefScreen
  // Across the screen: the viewport is `viewHeight * aspect` wide on the ground,
  // and the level is `width` wide. Charging the relief allowance here too is
  // deliberately conservative rather than exact — at yaw 0 height projects
  // straight up the screen and costs nothing horizontally. It is charged anyway
  // for two reasons: the cap must not depend on which axis happens to bind, so a
  // taller level's terrain cannot stop mattering the moment the window gets
  // wide; and the moment yaw is anything but 0 the vertical projection does bleed
  // sideways, because the ground direction it runs along stops being pure -Z.
  // The cost is a fraction of a tile of zoom-out, and it buys back real pan range
  // at the cap — see `skyFreePanBounds`, which does NOT inset X.
  const acrossLimit = (width - reliefScreen) / safeAspect

  const cap = Math.min(acrossLimit, depthLimit)
  return Number.isFinite(cap) && cap > MIN_CAP_VIEW_HEIGHT ? cap : MIN_CAP_VIEW_HEIGHT
}
