/**
 * CameraRig — orthographic camera locked to a fixed square, high-angle view.
 *
 * Every decision it makes (which way is screen-right, how much ground it can
 * see, where it may look, how it eases there, how shake decays) is delegated to
 * the engine-free helpers in `src/core/view`; this file is only the Three.js
 * plumbing around them.
 *
 * ANGLE (ticket 009a, changing the brief's decision). Yaw is 0 — the tile grid
 * is axis-aligned with the screen, matching the source art, which is drawn
 * square rather than at 45 degrees. Elevation is high and near top-down for the
 * same reason, defaulting to `ELEVATION` (75 degrees) and tunable at runtime
 * with `?elev=` so it can be dialled in by eye. The rig never rotates, so the
 * player's mental map of the level holds.
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
import { FLAT_RELIEF, type ReliefRange } from '../core/view/relief'
import { clampViewHeight, fitViewHeight } from '../core/view/zoom'
import type { WorldBounds } from '../core/view/projection'

/** How far back the camera sits. Irrelevant to framing (ortho) — it only has to clear the map. */
const CAMERA_DISTANCE = 120

/** World-space height of the viewport: roughly how many tiles are visible top to bottom. */
const DEFAULT_VIEW_HEIGHT = 16

/**
 * Closest the player may zoom in, in world units of viewport height.
 *
 * Roughly ten tiles top to bottom: close enough to read an individual soldier,
 * still far enough that the camera never ends up inside a canopy block.
 */
const MIN_VIEW_HEIGHT = 10

/**
 * How much slack fit-to-level leaves around the map — 6%, enough that the level
 * edge is visibly an edge rather than flush against the window.
 */
const FIT_MARGIN = 1.06

/** Follow stiffness for the exponential ease, in units of 1/second. */
const FOLLOW_STIFFNESS = 6

/** Maximum world-space displacement at shake amount 1. */
const SHAKE_WORLD_SCALE = 0.6

export class CameraRig {
  readonly camera: THREE.OrthographicCamera

  private readonly bounds: WorldBounds
  /**
   * How far the terrain rises above and falls below the ground plane.
   *
   * Fit-to-level needs it because the level's on-screen silhouette is its
   * extruded geometry, not its footprint — see `fitViewHeight`. Held rather than
   * folded into a number at construction because the fit is recomputed on every
   * resize and every elevation change, and the allowance depends on both.
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
   * Furthest the player may zoom out: exactly the whole-level view.
   *
   * Depends on the window aspect and the elevation, so it is recomputed on every
   * `resize` and every elevation change rather than being a constant — a capped
   * zoom-out is what stops the level shrinking to a speck in a void.
   *
   * Starts at Infinity, not at the default height: the constructor's own
   * `resize` would otherwise see "already at the limit" and boot the game fully
   * zoomed out instead of at DEFAULT_VIEW_HEIGHT.
   */
  private maxViewHeight = Number.POSITIVE_INFINITY
  /**
   * Viewport height at which the level exactly fills the screen — the same
   * calculation as `maxViewHeight` but with no margin. Only used to answer "is
   * the whole level on screen?", which is a question about the level's extruded
   * silhouette, terrain relief included, not about its flat footprint.
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

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 3)
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

  /** Ask the rig to look at a point; it eases there over the next frames. */
  setTarget(point: GroundPoint): void {
    this.desired = clampCameraTarget(point, this.bounds, this.view)
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
    this.viewHeight = clampViewHeight(worldUnits, MIN_VIEW_HEIGHT, this.maxViewHeight)
    this.applyFrustum()
    this.setTarget(this.desired)
  }

  /** Multiply the current zoom. `factor` > 1 zooms out, < 1 zooms in. */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    this.setViewHeight(this.viewHeight * factor)
  }

  /**
   * Frame the entire level, centred.
   *
   * No special-cased camera position: at the fit height the visible footprint is
   * larger than the level on both axes, which is `clampCameraTarget`'s
   * documented "no valid pan range" branch — it centres the level for us. Fit is
   * just the zoom-out limit plus the clamp already in place.
   *
   * What "the entire level" means is the extruded silhouette, not the ground
   * rectangle: `maxViewHeight` is computed with this level's terrain relief, so
   * the raised far edge is framed rather than clipped off the top. See
   * `fitViewHeight` and `src/core/view/relief.ts`.
   */
  fitToLevel(): void {
    this.setViewHeight(this.maxViewHeight)
  }

  /** Current viewport height in world units, and the range it may take. */
  get zoom(): { viewHeight: number; min: number; max: number } {
    return { viewHeight: this.viewHeight, min: MIN_VIEW_HEIGHT, max: this.maxViewHeight }
  }

  /** Recompute the ortho frustum and the half-extents fed to `clampCameraTarget`. */
  resize(widthPx: number, heightPx: number): void {
    this.viewportWidthPx = widthPx
    this.viewportHeightPx = heightPx
    this.aspect = heightPx > 0 ? widthPx / heightPx : 1

    // Fit-to-level depends on the aspect, so the zoom-out limit moves with the
    // window. If the player was fitted, stay fitted — otherwise a resize would
    // silently un-frame the level and leave "fit" meaning something else than it
    // did a moment ago. Any other zoom is simply re-clamped to the new limit.
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
    this.maxViewHeight = this.coverViewHeight * FIT_MARGIN
    // Both branches go through the same clamp: on a small enough window the fit
    // height can fall BELOW MIN_VIEW_HEIGHT, and "stay fitted" must not be a
    // back door that zooms closer than any other path is allowed to.
    this.viewHeight = clampViewHeight(
      wasFitted ? this.maxViewHeight : this.viewHeight,
      MIN_VIEW_HEIGHT,
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
