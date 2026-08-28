/**
 * PanController — keyboard and screen-edge camera panning.
 *
 * Both routes produce the same screen-space intent vector and hand it to
 * `CameraRig.panBy`, which is the single place clamping happens. They therefore
 * cannot drift apart: whatever stops the keyboard at the map edge stops the
 * edge-scroll at exactly the same point.
 */

import type { CameraRig } from '../render/camera-rig'
import { isEditableTarget } from './editable-target'

/** Pan speed in world units per second. */
const PAN_SPEED = 22

/** How close to the playfield's edge the pointer must be to start scrolling, in CSS px. */
const EDGE_MARGIN = 28

/**
 * The rectangle whose edges scroll the camera (ticket 074).
 *
 * AN ELEMENT SATISFIES THIS WITHOUT BEING TOLD TO, which is the point: `main.ts`
 * hands over the canvas and a test hands over a plain object, and neither has to
 * know about the other. The same bargain `PointerController` already makes with
 * its host.
 */
export interface PlayfieldBounds {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
}

const LEFT_KEYS = new Set(['ArrowLeft', 'KeyA'])
const RIGHT_KEYS = new Set(['ArrowRight', 'KeyD'])
const UP_KEYS = new Set(['ArrowUp', 'KeyW'])
const DOWN_KEYS = new Set(['ArrowDown', 'KeyS'])

export class PanController {
  private readonly pressed = new Set<string>()
  private pointerX = -1
  private pointerY = -1
  private pointerInside = false

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // A key typed into a text field is the field's, not the camera's.
    if (isEditableTarget(event.target)) return
    if (this.isPanKey(event.code)) {
      this.pressed.add(event.code)
      // Arrow keys otherwise scroll the page behind the canvas.
      event.preventDefault()
    }
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code)
  }

  /** Releasing focus with a key held would otherwise leave the camera panning forever. */
  private readonly onBlur = (): void => {
    this.pressed.clear()
    this.pointerInside = false
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerX = event.clientX
    this.pointerY = event.clientY
    this.pointerInside = true
  }

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false
  }

  constructor(
    private readonly rig: CameraRig,
    private readonly target: Window = window,
    /**
     * WHAT COUNTS AS AN EDGE. Given nothing, the window — which is what this was
     * for as long as the canvas WAS the window. Given the playfield, its own
     * rect: since ticket 074 the canvas starts at the rail's right edge, and a
     * left band measured from `innerWidth` would sit entirely under the roster.
     * Reading a name or reaching for the grenade would then pan the camera west
     * and keep panning until the pointer came back out — a map that drifts
     * whenever the player looks at his squad.
     */
    private readonly playfield: PlayfieldBounds | null = null,
  ) {
    this.target.addEventListener('keydown', this.onKeyDown as EventListener)
    this.target.addEventListener('keyup', this.onKeyUp as EventListener)
    this.target.addEventListener('blur', this.onBlur)
    this.target.addEventListener('pointermove', this.onPointerMove as EventListener)
    this.target.addEventListener('pointerleave', this.onPointerLeave as EventListener)
  }

  /** Advance the camera by one frame of pan intent. Allocation-free. */
  update(dt: number): void {
    let right = 0
    let up = 0

    for (const code of this.pressed) {
      if (LEFT_KEYS.has(code)) right -= 1
      else if (RIGHT_KEYS.has(code)) right += 1
      else if (UP_KEYS.has(code)) up += 1
      else if (DOWN_KEYS.has(code)) up -= 1
    }

    if (this.pointerInside) {
      // READ EVERY FRAME AND NOT CACHED. The rect moves with a resize, and a
      // remembered one would put the bands where the window used to be — which
      // is exactly the class of bug this parameter exists to fix.
      const rect = this.playfield?.getBoundingClientRect()
      const left = rect?.left ?? 0
      const top = rect?.top ?? 0
      const right_ = rect === undefined ? this.target.innerWidth : left + rect.width
      const bottom = rect === undefined ? this.target.innerHeight : top + rect.height
      /**
       * INSIDE THE RECTANGLE BEFORE ANY BAND IS CONSIDERED, and both axes at
       * once. Testing each axis on its own was the first version of this fix and
       * it was half a fix: the rail runs the full height, so its top and bottom
       * 28 pixels sat in the vertical bands whatever x said — the same "the map
       * drifts while I read my squad" bug, rotated ninety degrees, waiting at the
       * corner where the HEROES heading is. Outside the playfield is not further
       * into a band; it is somewhere else, and somewhere else does not drive the
       * camera.
       */
      const insideX = this.pointerX >= left && this.pointerX <= right_
      const insideY = this.pointerY >= top && this.pointerY <= bottom
      if (insideX && insideY) {
        if (this.pointerX < left + EDGE_MARGIN) right -= 1
        else if (this.pointerX > right_ - EDGE_MARGIN) right += 1
        if (this.pointerY < top + EDGE_MARGIN) up += 1
        else if (this.pointerY > bottom - EDGE_MARGIN) up -= 1
      }
    }

    if (right === 0 && up === 0) return

    // Normalise so diagonal panning isn't ~40% faster than axis-aligned.
    const length = Math.hypot(right, up)
    const step = (PAN_SPEED * dt) / length
    this.rig.panBy(right * step, up * step)
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener)
    this.target.removeEventListener('blur', this.onBlur)
    this.target.removeEventListener('pointermove', this.onPointerMove as EventListener)
    this.target.removeEventListener('pointerleave', this.onPointerLeave as EventListener)
    this.pressed.clear()
  }

  private isPanKey(code: string): boolean {
    return LEFT_KEYS.has(code) || RIGHT_KEYS.has(code) || UP_KEYS.has(code) || DOWN_KEYS.has(code)
  }
}
