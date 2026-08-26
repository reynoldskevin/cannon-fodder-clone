/**
 * The debug overlay's wiring (ticket 014) — and the reason it is its own file.
 *
 * THIS MODULE IS THE CODE-SPLIT BOUNDARY. `main.ts` reaches it through a
 * dynamic `import()` behind `?debug=1`, so Rollup puts everything only this file
 * reaches — `core/debug`, `render/debug-overlay`, `ui/debug-panel` — into a
 * chunk of its own that a normal build never downloads and never evaluates. A
 * runtime `if` around a statically imported overlay would ship every byte of it
 * to every player and merely decline to run it; the acceptance criterion for
 * this ticket is a MEASURED bundle size, which only a real split can satisfy.
 *
 * It follows that nothing in `main.ts` may import this file's names for types
 * either: a `import type` is erased, but a value import is not, and one
 * accidental `import { attachDebugMode }` at the top of `main.ts` would quietly
 * pull the whole chunk back into the main bundle with nothing failing.
 *
 * TOGGLING MUST NOT LEAK. One `keydown` listener for the whole session, one
 * overlay whose buffers are reused, one panel whose frame graph is a fixed-size
 * ring. Switching a layer on and off is a set membership change and nothing
 * else — no listener is added, no object is built, and no array grows.
 */

import { DEBUG_LAYERS, debugSnapshot, layerForKeyCode } from '../core/debug'
import { DebugOverlay } from '../render/debug-overlay'
import { createDebugPanel } from '../ui/debug-panel'
import type { DebugLayerId } from '../core/debug'
import type { Session } from '../core/session'
import type { LevelSize } from '../core/level'
import type * as THREE from 'three'

export interface DebugModeOptions {
  /** Where the panel is mounted — the same element the HUD uses. */
  readonly mount: HTMLElement
  /** The scene the overlay's group is added to. */
  readonly scene: THREE.Scene
  /** Read for the draw-call count only; never rendered with. */
  readonly renderer: THREE.WebGLRenderer
  readonly size: LevelSize
  /** The terrain's height sampler, so the overlay lies on the ground. */
  readonly heightAt: (tileX: number, tileY: number) => number
  /** The camera's elevation, so the text labels are not foreshortened. */
  readonly elevationRad: number
  /**
   * The CURRENT session, asked afresh every frame.
   *
   * A function and not the object: `main.ts` replaces the session on restart,
   * and an overlay holding the old one would draw the dead mission's grid over
   * the live one for the rest of the page's life.
   */
  readonly session: () => Session
}

export interface DebugMode {
  /** Rebuild the overlay from this frame's session. Called from the render loop. */
  update(): void
  /** Remove the overlay, the panel and the key listener. Safe to call twice. */
  dispose(): void
}

/**
 * Which layers are on when the overlay opens.
 *
 * AI state alone. Every layer is a per-frame cost and the nav grid is one
 * square per tile, so opening the overlay must not itself be the thing that
 * makes the frame time worth looking at — but opening it and seeing nothing at
 * all reads as broken, and the state machine is the layer the ticket names as
 * the one the overlay exists for. The legend says which key adds the rest.
 */
const INITIAL_LAYERS: readonly DebugLayerId[] = ['ai']

export function attachDebugMode(options: DebugModeOptions): DebugMode {
  const overlay = new DebugOverlay({
    size: options.size,
    heightAt: options.heightAt,
    elevationRad: options.elevationRad,
  })
  options.scene.add(overlay.group)
  const panel = createDebugPanel(options.mount)

  const active = new Set<DebugLayerId>(INITIAL_LAYERS)
  /**
   * `active` in registry order, rebuilt on every toggle and never per frame.
   *
   * `debugSnapshot` takes a list, and building one out of the set inside the
   * render loop would allocate an array 60 times a second to say what changes
   * only when a key is pressed.
   */
  let ordered: readonly DebugLayerId[] = orderedLayers(active)

  const onKeyDown = (event: KeyboardEvent): void => {
    // A modified keypress belongs to the browser or the OS — Cmd-1 switches
    // tabs — and swallowing it would make the overlay a thing the player has to
    // close before they can use their own machine.
    if (event.altKey || event.ctrlKey || event.metaKey) return
    // SHIFT IS REQUIRED AND IS NOT FILTERED OUT HERE. Ticket 016 gave the bare
    // digits to the ordnance selector, so the overlay's keys became
    // `Shift+1`..`Shift+5`; an early return on `shiftKey` alongside the three
    // above would leave the overlay with no working controls at all. Matched on
    // `event.code`, the physical key, because `Shift+1` is `'!'` on one keyboard
    // layout and something else on the next.
    const layer = layerForKeyCode(event.code, event.shiftKey)
    if (layer === undefined) return
    if (active.has(layer.id)) active.delete(layer.id)
    else active.add(layer.id)
    ordered = orderedLayers(active)
  }

  window.addEventListener('keydown', onKeyDown)

  let disposed = false

  return {
    update(): void {
      if (disposed) return
      overlay.update(debugSnapshot(options.session(), ordered))
      // ONE FRAME STALE, AND IT HAS TO BE. `WebGLRenderer.info` is reset at the
      // top of every `render` call, so the only count that exists while this
      // frame is still being prepared is the last one that finished. A number
      // labelled "this frame" that could only ever be zero would be worse.
      panel.update({ drawCalls: options.renderer.info.render.calls, active })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      window.removeEventListener('keydown', onKeyDown)
      panel.dispose()
      overlay.dispose()
    },
  }
}

/** The active ids in `DEBUG_LAYERS` order, so the snapshot is built the same way twice. */
function orderedLayers(active: ReadonlySet<DebugLayerId>): readonly DebugLayerId[] {
  return DEBUG_LAYERS.filter((layer) => active.has(layer.id)).map((layer) => layer.id)
}
