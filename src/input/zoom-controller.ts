/**
 * ZoomController — mouse wheel and keyboard zoom, plus zoom-all-the-way-out.
 *
 * `F` / `Home` used to mean "fit the whole level"; since ticket 009b the rig's
 * zoom-out limit stops at the widest view that shows no background, so they mean
 * "zoom out as far as is allowed". Same call, same key, narrower promise.
 *
 * Like `PanController`, every route funnels into a single `CameraRig` method
 * (`zoomBy` / `fitToLevel`) so the wheel and the keyboard cannot disagree about
 * the limits, and so the re-clamp that zooming requires happens in exactly one
 * place.
 */

import type { CameraRig } from '../render/camera-rig'
import { isEditableTarget } from './editable-target'

/** Zoom factor per keyboard press. 1.15 ≈ eight presses across the full range. */
const KEY_STEP = 1.15

/**
 * Wheel sensitivity, as a zoom exponent per pixel of `deltaY`.
 *
 * Exponential rather than additive so a notch feels the same at every zoom
 * level, and so the height can never be driven to zero or negative.
 */
const WHEEL_EXPONENT_PER_PIXEL = 0.0015

/** A line of wheel delta (`deltaMode 1`) in pixels; a page (`deltaMode 2`) is ten lines. */
const PIXELS_PER_LINE = 16

/** Largest single wheel event we honour, so a trackpad fling can't teleport the zoom. */
const MAX_WHEEL_PIXELS = 240

/** `Equal` is the physical `+` key; accepting the code covers both `=` and shifted `+`. */
const ZOOM_IN_KEYS = new Set(['Equal', 'NumpadAdd'])
const ZOOM_OUT_KEYS = new Set(['Minus', 'NumpadSubtract'])
const FIT_KEYS = new Set(['KeyF', 'Home'])

/**
 * Zooming IN means seeing LESS world, so it *divides* the viewport height. The
 * rig's one zoom parameter is a height in world units, not a magnification, and
 * these two constants are the only place that inversion is spelled out.
 */
const ZOOM_IN_FACTOR = 1 / KEY_STEP
const ZOOM_OUT_FACTOR = KEY_STEP

export class ZoomController {
  private readonly onWheel = (event: WheelEvent): void => {
    // Without this the page itself scrolls, and ctrl+wheel triggers browser zoom.
    event.preventDefault()

    const scale =
      event.deltaMode === 1 ? PIXELS_PER_LINE : event.deltaMode === 2 ? PIXELS_PER_LINE * 10 : 1
    const pixels = event.deltaY * scale
    if (!Number.isFinite(pixels) || pixels === 0) return

    const limited = Math.max(-MAX_WHEEL_PIXELS, Math.min(MAX_WHEEL_PIXELS, pixels))
    // Wheel down (positive deltaY) is the conventional "zoom out" = larger view height.
    this.rig.zoomBy(Math.exp(limited * WHEEL_EXPONENT_PER_PIXEL))
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    // `F` typed into a HUD text field must stay an `f`, not fit the level.
    if (isEditableTarget(event.target)) return

    if (FIT_KEYS.has(event.code)) {
      this.rig.fitToLevel()
      event.preventDefault()
      return
    }
    if (ZOOM_IN_KEYS.has(event.code)) {
      this.rig.zoomBy(ZOOM_IN_FACTOR)
      event.preventDefault()
      return
    }
    if (ZOOM_OUT_KEYS.has(event.code)) {
      this.rig.zoomBy(ZOOM_OUT_FACTOR)
      event.preventDefault()
    }
  }

  constructor(
    private readonly rig: CameraRig,
    private readonly target: Window = window,
    private readonly wheelTarget: EventTarget = window,
  ) {
    this.target.addEventListener('keydown', this.onKeyDown as EventListener)
    this.wheelTarget.addEventListener('wheel', this.onWheel as EventListener, { passive: false })
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.wheelTarget.removeEventListener('wheel', this.onWheel as EventListener)
  }
}
