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

/** How close to the window edge the pointer must be to start scrolling, in CSS px. */
const EDGE_MARGIN = 28

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
      const w = this.target.innerWidth
      const h = this.target.innerHeight
      if (this.pointerX >= 0 && this.pointerX < EDGE_MARGIN) right -= 1
      else if (this.pointerX > w - EDGE_MARGIN && this.pointerX <= w) right += 1
      if (this.pointerY >= 0 && this.pointerY < EDGE_MARGIN) up += 1
      else if (this.pointerY > h - EDGE_MARGIN && this.pointerY <= h) up -= 1
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
