/**
 * "Is this key event the game's to consume?"
 *
 * Both controllers listen on the WINDOW and call `preventDefault`, which is
 * correct while the canvas is the only thing on the page but hostile the moment
 * a DOM HUD exists (ticket 013): WASD would pan the camera instead of typing,
 * and `F` would fit the level instead of writing an f. A key pressed inside a
 * text field belongs to the field, never to the camera.
 */

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isEditableTarget(target: EventTarget | null): boolean {
  /**
   * `HTMLElement` IS NOT A GLOBAL EVERYWHERE THIS RUNS. Vitest runs
   * `environment: 'node'`, where the bare `instanceof` below is a ReferenceError
   * rather than a `false` — which made every keyboard path in `src/input`
   * untestable, and cost this exact thirty seconds to rediscover. Under a DOM
   * the guard is free and the answer is unchanged.
   */
  if (target === null || typeof HTMLElement === 'undefined') return false
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || EDITABLE_TAGS.has(target.tagName)
}
