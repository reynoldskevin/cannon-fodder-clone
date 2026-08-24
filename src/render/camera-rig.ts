/**
 * CameraRig — orthographic camera locked to a fixed isometric angle.
 *
 * Every decision it makes (where it may look, how it eases there, how shake
 * decays) is delegated to the engine-free helpers in `src/core/view/camera`;
 * this file is only the Three.js plumbing around them.
 *
 * ANGLE. Yaw is the classic 45 degrees about Y. Elevation is 40 degrees rather
 * than the 35.264 of a true isometric projection: at 35 degrees the tall canopy
 * blocks in this game's terrain hide an unreasonable amount of walkable ground
 * behind them, and a slightly steeper look reads better for a top-down squad
 * shooter while still keeping the diagonal Cannon Fodder silhouette. It is
 * fixed — the rig never rotates, so the player's mental map of the level holds.
 */

import * as THREE from 'three'
import {
  clampCameraTarget,
  followStep,
  panClampExtent,
  shakeStep,
  type GroundPoint,
  type ViewportExtent,
} from '../core/view/camera'
import { clampViewHeight, fitViewHeight } from '../core/view/zoom'
import type { WorldBounds } from '../core/view/projection'

const YAW = Math.PI / 4
const ELEVATION = (40 * Math.PI) / 180

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
  private viewHeight = DEFAULT_VIEW_HEIGHT
  private aspect = 1
  /**
   * Furthest the player may zoom out: exactly the whole-level view.
   *
   * Depends on the window aspect, so it is recomputed on every `resize` rather
   * than being a constant — a capped zoom-out is what stops the level shrinking
   * to a speck in a void.
   *
   * Starts at Infinity, not at the default height: the constructor's own
   * `resize` would otherwise see "already at the limit" and boot the game fully
   * zoomed out instead of at DEFAULT_VIEW_HEIGHT.
   */
  private maxViewHeight = Number.POSITIVE_INFINITY
  /**
   * Viewport height at which the level exactly fills the screen — the same
   * calculation as `maxViewHeight` but with no margin.
   *
   * It is the pan clamp's one input: at or above it the whole level is on
   * screen and the camera is pinned to the level centre; below it the camera is
   * free to look anywhere in the level. See `panClampExtent`.
   */
  private coverViewHeight = Number.POSITIVE_INFINITY
  private view: ViewportExtent = { halfW: 0, halfZ: 0 }

  /** Where the rig is asked to look (already clamped). */
  private desired: GroundPoint = { x: 0, z: 0 }
  /** Where it is actually looking this frame. */
  private current: GroundPoint = { x: 0, z: 0 }
  private shake = 0

  /** Fixed unit vectors, computed once: camera offset, screen-right, screen-up-on-ground. */
  private readonly offset: THREE.Vector3
  private readonly screenRight: THREE.Vector3
  private readonly screenUp: THREE.Vector3

  /** Scratch, reused every frame so `update` allocates no vectors. */
  private readonly lookAt = new THREE.Vector3()

  constructor(bounds: WorldBounds, viewportPx: { width: number; height: number }) {
    this.bounds = bounds

    const dir = new THREE.Vector3(
      Math.sin(YAW) * Math.cos(ELEVATION),
      Math.sin(ELEVATION),
      Math.cos(YAW) * Math.cos(ELEVATION),
    ).normalize()
    this.offset = dir.clone().multiplyScalar(CAMERA_DISTANCE)

    // Screen right = forward x up; screen "up" on the ground is the horizontal
    // component of the view direction, pointing away from the camera.
    this.screenRight = new THREE.Vector3(dir.z, 0, -dir.x).normalize()
    this.screenUp = new THREE.Vector3(-dir.x, 0, -dir.z).normalize()

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 3)
    this.camera.name = 'camera:isometric'

    this.resize(viewportPx.width, viewportPx.height)
    this.snapTo(this.desired)
  }

  /**
   * The half-extents the look-at point is clamped with this frame.
   *
   * `{0, 0}` while the level is larger than the screen (the target may roam the
   * whole level rectangle); the level's half-extents once it all fits, which is
   * what pins the camera to the centre. See `panClampExtent`.
   */
  get panExtent(): ViewportExtent {
    return this.view
  }

  /** True when the current zoom shows the entire level. */
  get levelFullyVisible(): boolean {
    return this.viewHeight >= this.coverViewHeight - 1e-9
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
   * No special-cased camera position: the fit height is above `coverViewHeight`,
   * so `panClampExtent` hands the clamp the level's own half-extents, which is
   * its documented "level narrower than the viewport" branch — it centres the
   * level for us. Fit is just the zoom-out limit plus the clamp already in place.
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
      ELEVATION,
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

  /**
   * Recompute the ortho frustum, then the extents the pan clamp uses.
   *
   * WHY THE CLAMP IS NOT "never show void". The visible ground footprint of an
   * orthographic camera tilted by ELEVATION is a rectangle rotated by YAW, and
   * containment of that rotated rectangle inside the axis-aligned level IS
   * exactly containment of its axis-aligned bound — at YAW 45 degrees that bound
   * is ~sqrt(2) larger per axis than the on-screen rectangle. Requiring it to
   * stay inside the level is therefore not a conservative approximation that
   * could be tightened; it is the honest cost of the rule, and on a 57x45 level
   * it demands 36 units of reach where a 30-unit view has 27. The result was a
   * whole band of zooms (roughly 30 to 49 units of view height) in which the map
   * did not fit on screen AND the pan range was exactly zero: the outer third of
   * the level was unviewable and WASD/edge-scroll were silent no-ops.
   *
   * So the rule is inverted: the LOOK-AT POINT is clamped to the level rectangle
   * (`panClampExtent`). Every tile can be centred at every zoom; panning is a
   * no-op only when the level is genuinely all on screen, in which case it is
   * centred instead. Panning hard into an edge shows sky beyond it, which the
   * scene's sky colour and matching fog render as a deliberate matte.
   */
  private applyFrustum(): void {
    const halfH = this.viewHeight / 2
    const halfW = halfH * this.aspect
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()

    this.view = panClampExtent(this.bounds, this.levelFullyVisible)
  }
}
