/**
 * CameraRig — orthographic camera locked to a fixed square, high-angle view.
 *
 * Every decision it makes (which way is screen-right, how much ground it can
 * see, where it may look, how it eases there, how shake decays) is delegated to
 * the engine-free helpers in `src/core/view`; this file is only the Three.js
 * plumbing around them.
 *
 * ANGLE (ticket 009a, changing the brief's decision; retuned in 009b). Yaw is
 * 0 — the tile grid is axis-aligned with the screen, matching the source art,
 * which is drawn square rather than at 45 degrees. Elevation defaults to
 * `ELEVATION` (55 degrees since 009b) and is tunable at runtime with `?elev=` so
 * it can be dialled in by eye. The rig never rotates, so the player's mental map
 * of the level holds.
 *
 * ZOOM-OUT (ticket 009b). The limit is no longer the fit height. It is
 * `maxSkyFreeViewHeight`: the largest viewport whose ground footprint still lies
 * entirely inside the level, relief included. The background is therefore never
 * visible at any zoom or pan position — at the cost, accepted explicitly by the
 * owner, of the whole level no longer fitting on screen at once.
 */

import * as THREE from 'three'
import {
  clampCameraTarget,
  followStep,
  shakeStep,
  type GroundPoint,
  type ViewportExtent,
} from '../core/view/camera'
import { ELEVATION, YAW, screenBasis, viewGroundExtents } from '../core/view/orientation'
import { maxSkyFreeViewHeight, skyFreePanBounds } from '../core/view/cover'
import { FLAT_RELIEF, type ReliefRange } from '../core/view/relief'
import { clampViewHeight, fitViewHeight } from '../core/view/zoom'
import type { WorldBounds } from '../core/view/projection'

/** How far back the camera sits. Irrelevant to framing (ortho) — it only has to clear the map. */
const CAMERA_DISTANCE = 120

/**
 * Half-depth of the orthographic clip box, in world units — near = -this,
 * far = +this.
 *
 * A NEGATIVE NEAR PLANE IS DELIBERATE. `EntityRenderer` draws sprites on upright
 * quads pre-stretched by `1 / cos(elevation)` (see its header), so a sprite's
 * head stands `height * tan(elevation)` closer to the camera than its feet. At
 * the top of the `?elev=` band that is 238 world units for a tree — well past
 * `CAMERA_DISTANCE`, i.e. behind the camera's own position — and a near plane at
 * 0.1 would clip the tops off every prop. An orthographic projection has no
 * perspective divide and no near-plane precision cliff: its depth is linear, so
 * a symmetric 720-unit box costs 3e-5 world units of depth resolution at 24
 * bits, three orders of magnitude finer than the 0.02 the sprite lift uses.
 */
const CAMERA_DEPTH_HALF = CAMERA_DISTANCE * 3

/** World-space height of the viewport: roughly how many tiles are visible top to bottom. */
const DEFAULT_VIEW_HEIGHT = 16

/**
 * Closest the player may zoom in, in world units of viewport height.
 *
 * Roughly ten tiles top to bottom: close enough to read an individual soldier,
 * still far enough that the camera never ends up inside a canopy block.
 *
 * A preference, not an invariant — see `minViewHeight`. The no-sky rule outranks
 * it.
 */
const MIN_VIEW_HEIGHT = 10

/** Follow stiffness for the exponential ease, in units of 1/second. */
const FOLLOW_STIFFNESS = 6

/** Maximum world-space displacement at shake amount 1. */
const SHAKE_WORLD_SCALE = 0.6

export class CameraRig {
  readonly camera: THREE.OrthographicCamera

  private readonly bounds: WorldBounds
  /**
   * The bounds the look-at point is actually clamped against: `bounds` with the
   * far edge pushed in far enough that terrain relief at that edge cannot leave
   * background above it. Depends on the elevation, so it is recomputed by
   * `applyOrientation` rather than frozen at construction.
   */
  private panBounds: WorldBounds
  /**
   * How far the terrain rises above and falls below the ground plane.
   *
   * Both the zoom cap and the pan clamp need it, because the level's on-screen
   * silhouette is its extruded geometry, not its footprint — see `cover.ts`.
   * Held rather than folded into a number at construction because both are
   * recomputed on every resize and every elevation change, and the allowance
   * depends on both.
   */
  private readonly relief: ReliefRange
  private viewHeight = DEFAULT_VIEW_HEIGHT
  private aspect = 1
  /** Last viewport in CSS pixels, kept so `setElevation` can redo the fit maths. */
  private viewportWidthPx = 1
  private viewportHeightPx = 1
  /**
   * Elevation above the ground plane, in radians.
   *
   * Mutable, and read on every recompute rather than baked into anything at
   * construction: it is a runtime tuning knob (`?elev=`), and the fit height,
   * the visible ground footprint and therefore the pan clamp all depend on it.
   */
  private elevation = ELEVATION
  /**
   * Furthest the player may zoom out: the widest sky-free view (ticket 009b).
   *
   * NOT the fit height any more. It is the largest viewport whose ground
   * footprint still lies inside the level, so the background can never appear —
   * which also means the whole level cannot be framed at once. Depends on the
   * window aspect, the elevation and the relief, so it is recomputed on every
   * `resize` and every elevation change rather than being a constant.
   *
   * Starts at Infinity, not at the default height: the constructor's own
   * `resize` would otherwise see "already at the limit" and boot the game fully
   * zoomed out instead of at DEFAULT_VIEW_HEIGHT.
   */
  private maxViewHeight = Number.POSITIVE_INFINITY
  /**
   * Viewport height at which the whole level would exactly fill the screen.
   *
   * No longer reachable — `maxViewHeight` stops short of it, deliberately — so
   * this only answers "is the whole level on screen?", which since 009b is
   * normally "no". Kept because it is the honest measure of the level's extruded
   * silhouette, relief included, and the thing the cap is defined against.
   */
  private coverViewHeight = Number.POSITIVE_INFINITY
  private view: ViewportExtent = { halfW: 0, halfZ: 0 }

  /** Where the rig is asked to look (already clamped). */
  private desired: GroundPoint = { x: 0, z: 0 }
  /** Where it is actually looking this frame. */
  private current: GroundPoint = { x: 0, z: 0 }
  private shake = 0

  /**
   * Camera offset from the look-at point. Depends on elevation, so it is
   * recomputed by `applyOrientation`, not frozen in the constructor.
   */
  private readonly offset = new THREE.Vector3()
  /**
   * Screen-right and screen-up as ground directions. Yaw is fixed and elevation
   * does not turn them, so in practice they are constant — but they come from
   * `screenBasis` so there is exactly one definition of which way is right.
   */
  private readonly screenRight = new THREE.Vector3()
  private readonly screenUp = new THREE.Vector3()

  /** Scratch, reused every frame so `update` allocates no vectors. */
  private readonly lookAt = new THREE.Vector3()

  constructor(
    bounds: WorldBounds,
    viewportPx: { width: number; height: number },
    elevationRad: number = ELEVATION,
    relief: ReliefRange = FLAT_RELIEF,
  ) {
    this.bounds = bounds
    this.relief = relief
    this.elevation = Number.isFinite(elevationRad) ? elevationRad : ELEVATION
    this.panBounds = skyFreePanBounds(bounds, relief, this.elevation)

    this.camera = new THREE.OrthographicCamera(
      -1,
      1,
      1,
      -1,
      -CAMERA_DEPTH_HALF,
      CAMERA_DEPTH_HALF,
    )
    this.camera.name = 'camera:square'

    this.applyOrientation()
    this.resize(viewportPx.width, viewportPx.height)
    this.snapTo(this.desired)
  }

  /**
   * The half-extents the look-at point is clamped with this frame: the visible
   * ground footprint, so the clamp is edge-tight. `{0, 0}` never occurs — see
   * `applyFrustum`.
   */
  get panExtent(): ViewportExtent {
    return this.view
  }

  /** True when the current zoom shows the entire level. */
  get levelFullyVisible(): boolean {
    return this.viewHeight >= this.coverViewHeight - 1e-9
  }

  /** Current elevation above the ground plane, in radians. */
  get elevationRad(): number {
    return this.elevation
  }

  /**
   * Retune the elevation at runtime.
   *
   * Everything downstream is recomputed here rather than cached from
   * construction: a steeper camera sees less ground depth, which changes the fit
   * height, the pan clamp and the frustum together. Callers should pass a value
   * already through `parseElevation`.
   */
  setElevation(elevationRad: number): void {
    if (!Number.isFinite(elevationRad)) return
    this.elevation = elevationRad
    this.applyOrientation()
    this.resize(this.viewportWidthPx, this.viewportHeightPx)
  }

  /** The point the camera is looking at right now. */
  get target(): GroundPoint {
    return this.current
  }

  /**
   * Ask the rig to look at a point; it eases there over the next frames.
   *
   * Clamped against `panBounds`, not the raw level: the far edge is inset by the
   * relief allowance so that raised or sunken terrain at the top of the screen
   * cannot leave background above it. The zoom cap is derived from exactly the
   * same inset, so at maximum zoom-out this range collapses to a point on Z
   * rather than inverting — the axis is then genuinely fully covered, and the
   * clamp's centring branch says so honestly instead of hiding a lost pan range.
   */
  setTarget(point: GroundPoint): void {
    this.desired = clampCameraTarget(point, this.panBounds, this.view)
  }

  /** Jump straight to a point with no easing — used once at level load. */
  snapTo(point: GroundPoint): void {
    this.setTarget(point)
    this.current = this.desired
    this.applyToCamera(0, 0)
  }

  /**
   * Pan in SCREEN space: `+right` moves the view right on screen, `+up` moves it
   * away from the viewer. Keyboard and edge-scroll both come through here, so
   * they cannot disagree about clamping.
   */
  panBy(right: number, up: number): void {
    this.setTarget({
      x: this.desired.x + this.screenRight.x * right + this.screenUp.x * up,
      z: this.desired.z + this.screenRight.z * right + this.screenUp.z * up,
    })
  }

  /** Kick the screen-shake channel (explosions, ticket 013+). Takes the strongest request. */
  addShake(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return
    this.shake = Math.max(this.shake, Math.min(amount, 1))
  }

  /**
   * Zoom by changing how much world the viewport covers. Re-clamps immediately.
   *
   * `applyFrustum` recomputes `this.view` — the half-extents `clampCameraTarget`
   * works against — and the `setTarget` that follows re-runs the clamp with
   * them. That pairing is the whole contract of zooming: without it, zooming out
   * past the fit height would leave the level off-centre in a frame of sky, and
   * zooming back in would leave the camera pinned to the centre.
   */
  setViewHeight(worldUnits: number): void {
    this.viewHeight = clampViewHeight(worldUnits, this.minViewHeight, this.maxViewHeight)
    this.applyFrustum()
    this.setTarget(this.desired)
  }

  /** Multiply the current zoom. `factor` > 1 zooms out, < 1 zooms in. */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    this.setViewHeight(this.viewHeight * factor)
  }

  /**
   * Zoom out as far as is allowed — the most map visible without background.
   *
   * This was "frame the entire level" until ticket 009b. It no longer is, and
   * the control hint says so: the cap now stops at the widest view that stays
   * INSIDE the level, so on a 57x45 level at 16:9 the full width is visible but
   * several rows of depth are not. The method keeps its name because it keeps
   * its role — the one place `F` / `Home` and any future "overview" button agree
   * on what maximum zoom-out means.
   *
   * Still no special-cased camera position: `setViewHeight` re-clamps, and at the
   * cap the pan range has collapsed on whichever axis bound, so the view settles
   * itself. See `maxSkyFreeViewHeight` and `src/core/view/relief.ts`.
   */
  fitToLevel(): void {
    this.setViewHeight(this.maxViewHeight)
  }

  /** Current viewport height in world units, and the range it may take. */
  get zoom(): { viewHeight: number; min: number; max: number } {
    return { viewHeight: this.viewHeight, min: this.minViewHeight, max: this.maxViewHeight }
  }

  /**
   * Closest zoom allowed right now: `MIN_VIEW_HEIGHT`, unless the sky-free cap
   * is tighter.
   *
   * On a letterboxed window — wider than about 5.6:1 on level 1 — the widest
   * sky-free view is under ten tiles tall, and the two limits disagree. The
   * no-sky rule wins: `clampViewHeight` would otherwise floor the range at the
   * minimum and hand back a height ABOVE the cap, showing exactly the background
   * this ticket exists to remove. Zooming a little closer than intended in a
   * freak window is the cheaper failure.
   */
  private get minViewHeight(): number {
    return Math.min(MIN_VIEW_HEIGHT, this.maxViewHeight)
  }

  /** Recompute the ortho frustum and the half-extents fed to `clampCameraTarget`. */
  resize(widthPx: number, heightPx: number): void {
    this.viewportWidthPx = widthPx
    this.viewportHeightPx = heightPx
    this.aspect = heightPx > 0 ? widthPx / heightPx : 1

    // The sky-free cap depends on the aspect, so the zoom-out limit moves with
    // the window. If the player was zoomed fully out, stay fully out — otherwise
    // a resize would silently zoom them in. Any other zoom is re-clamped to the
    // new limit.
    const wasFitted = this.viewHeight >= this.maxViewHeight - 1e-6
    this.coverViewHeight = fitViewHeight(
      this.bounds,
      this.screenRight,
      this.screenUp,
      this.aspect,
      this.elevation,
      1,
      this.relief,
    )
    this.maxViewHeight = maxSkyFreeViewHeight(
      this.bounds,
      this.aspect,
      this.elevation,
      this.relief,
    )
    // Both branches go through the same clamp, and it is the clamp that resolves
    // a window so letterboxed that the sky-free cap falls below MIN_VIEW_HEIGHT
    // — see `minViewHeight`. "Stay zoomed out" must not be a back door around
    // either limit.
    this.viewHeight = clampViewHeight(
      wasFitted ? this.maxViewHeight : this.viewHeight,
      this.minViewHeight,
      this.maxViewHeight,
    )
    this.applyFrustum()
    // A resize can make the level narrower than the viewport; re-clamp so the
    // camera recentres rather than sitting on a now-illegal target.
    this.setTarget(this.desired)
  }

  update(dt: number): void {
    this.current = followStep(this.current, this.desired, FOLLOW_STIFFNESS, dt)
    this.shake = shakeStep(this.shake, dt)

    let jitterX = 0
    let jitterZ = 0
    if (this.shake > 0) {
      const magnitude = this.shake * SHAKE_WORLD_SCALE
      const r = (Math.random() * 2 - 1) * magnitude
      const u = (Math.random() * 2 - 1) * magnitude
      jitterX = this.screenRight.x * r + this.screenUp.x * u
      jitterZ = this.screenRight.z * r + this.screenUp.z * u
    }
    this.applyToCamera(jitterX, jitterZ)
  }

  private applyToCamera(jitterX: number, jitterZ: number): void {
    const x = this.current.x + jitterX
    const z = this.current.z + jitterZ
    this.camera.position.set(x + this.offset.x, this.offset.y, z + this.offset.z)
    this.lookAt.set(x, 0, z)
    this.camera.lookAt(this.lookAt)
    this.camera.updateMatrixWorld()
  }

  /** Rebuild the camera offset and the screen axes from the current angles. */
  private applyOrientation(): void {
    const dir = new THREE.Vector3(
      Math.sin(YAW) * Math.cos(this.elevation),
      Math.sin(this.elevation),
      Math.cos(YAW) * Math.cos(this.elevation),
    ).normalize()
    this.offset.copy(dir).multiplyScalar(CAMERA_DISTANCE)

    const basis = screenBasis(YAW, this.elevation)
    this.screenRight.set(basis.right.x, 0, basis.right.z)
    this.screenUp.set(basis.up.x, 0, basis.up.z)

    // How much ground the far edge's relief hides behind itself is a function of
    // the elevation, so the pan bounds move with it — a shallower camera must
    // keep the look-at point further from the far edge.
    this.panBounds = skyFreePanBounds(this.bounds, this.relief, this.elevation)
  }

  /**
   * Recompute the ortho frustum, then the extents the pan clamp uses.
   *
   * EDGE-TIGHT CLAMPING, restored in ticket 009a. The visible ground footprint
   * is a rectangle rotated by YAW; containment of it inside the axis-aligned
   * level is containment of its axis-aligned bound. At the old YAW of 45 degrees
   * that bound was ~sqrt(2) larger per axis than what the player could actually
   * see, so "never show void" demanded 36 units of reach on a 57x45 level where
   * a 30-unit view has 27 — an entire band of zooms in which the map did not fit
   * on screen AND the pan range was zero. Ticket 009 escaped that by clamping
   * the look-at point instead and letting sky show at the edges.
   *
   * At YAW 0 the footprint IS its own bounding box, so that compromise is gone
   * and the honest rule is affordable again: clamp with the real footprint. No
   * background shows past the level edge at any zoom, and when the footprint
   * outgrows the level on an axis `clampCameraTarget` centres that axis, which
   * is what makes `fitToLevel` need no special case.
   */
  private applyFrustum(): void {
    const halfH = this.viewHeight / 2
    const halfW = halfH * this.aspect
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()

    const ground = viewGroundExtents(this.viewHeight, this.aspect, YAW, this.elevation)
    this.view = { halfW: ground.halfX, halfZ: ground.halfZ }
  }
}
