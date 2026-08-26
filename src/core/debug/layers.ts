/**
 * The debug overlay's layer registry (ticket 014).
 *
 * THE SET OF LAYERS IS DATA, AND THAT IS THE WHOLE POINT OF THIS FILE. A key
 * handler written as a `switch` and a legend written as a list are two places
 * saying the same thing, and they diverge the first time a layer is added — the
 * hotkey works, the legend never mentions it, and the next person tuning combat
 * does not know the layer exists. One array, read by both, cannot drift.
 *
 * It lives in `src/core` rather than beside the drawing because it is the only
 * half a test can see: Vitest runs `environment: 'node'`, so the legend is
 * asserted here and the DOM that renders it is a loop over these entries.
 */

/**
 * Every layer the overlay can draw.
 *
 * A closed union, deliberately. An id is a key into `DebugSnapshot`, and a
 * layer added as a loose string would compile against a snapshot that has no
 * field to hold it.
 */
export type DebugLayerId = 'navGrid' | 'flowField' | 'losRays' | 'ai' | 'entityIds'

/** One switchable layer: what it is called, and which key toggles it. */
export interface DebugLayer {
  readonly id: DebugLayerId
  /** What the on-screen legend calls it. */
  readonly label: string
  /**
   * The `KeyboardEvent.code` that toggles it, with shift held — the PHYSICAL
   * key, never the character it produces.
   *
   * `Shift+1` delivers `event.key === '!'` on a US layout and `Shift+2` gives
   * `'"'` on a UK one, so a table keyed on the character would make the overlay
   * work or not work depending on whose keyboard it was opened on. `code` is the
   * same everywhere.
   */
  readonly code: string
  /**
   * What the legend PRINTS — `Shift+1`, not `Digit1`. `ui/debug-panel.ts`
   * renders it verbatim, which is what makes the legend and the working keys
   * one table rather than two that can drift.
   */
  readonly hotkey: string
}

/**
 * The registry, in the order the legend lists them.
 *
 * Ordered cheapest-to-read first: the nav grid is the backdrop everything else
 * is judged against, and the per-entity labels are the noisiest. Hotkeys are
 * `Shift+1`..`Shift+5` in that same order, so the legend's row number IS its key.
 *
 * SHIFTED SINCE TICKET 016, AND THE OVERLAY IS WHAT MOVED. `1`/`2`/`3` now
 * select the squad's ordnance, and `?debug=1` is on for a developer while the
 * game is still being PLAYED — so on the bare digits, `2` would both select
 * grenades and toggle the flow field. The selector is what a player uses and
 * this is what a developer uses, so the developer's tool is the one that yields.
 *
 * THE FRAME-TIME GRAPH IS NOT HERE, and its absence is a decision. It measures
 * the RENDERER — a wall clock and a draw-call count — which `src/core` may not
 * read, so it is always-on furniture of `src/ui/debug-panel.ts` rather than a
 * layer of a snapshot computed from the session.
 */
export const DEBUG_LAYERS: readonly DebugLayer[] = Object.freeze([
  { id: 'navGrid', label: 'Nav grid', code: 'Digit1', hotkey: 'Shift+1' },
  { id: 'flowField', label: 'Flow field', code: 'Digit2', hotkey: 'Shift+2' },
  { id: 'losRays', label: 'LOS rays', code: 'Digit3', hotkey: 'Shift+3' },
  { id: 'ai', label: 'AI state', code: 'Digit4', hotkey: 'Shift+4' },
  { id: 'entityIds', label: 'Entity ids', code: 'Digit5', hotkey: 'Shift+5' },
] as const satisfies readonly DebugLayer[])

/**
 * The layer a physical key toggles while shift is held, or `undefined` for a
 * keystroke that toggles nothing.
 *
 * THE "REQUIRES SHIFT" RULE IS HERE AND NOT IN THE DOM HANDLER, which is the
 * point of taking `shiftKey` as an argument rather than letting the caller
 * decide. In `app/debug-mode.ts` it would be a line no test can see; here it is
 * asserted, and the bare digits are provably left free for the ordnance
 * selector.
 *
 * A linear scan over five entries, called once per keypress: a `Map` built at
 * module load would be faster and would also be a second copy of the table
 * above, which is the drift this file exists to prevent.
 */
export function layerForKeyCode(code: string, shiftKey: boolean): DebugLayer | undefined {
  if (!shiftKey) return undefined
  for (const layer of DEBUG_LAYERS) {
    if (layer.code === code) return layer
  }
  return undefined
}
