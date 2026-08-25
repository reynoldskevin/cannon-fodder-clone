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
   * The `KeyboardEvent.key` that toggles it — the character, not a `KeyDigit`
   * code, so the handler is a lookup in this table rather than a translation.
   */
  readonly hotkey: string
}

/**
 * The registry, in the order the legend lists them.
 *
 * Ordered cheapest-to-read first: the nav grid is the backdrop everything else
 * is judged against, and the per-entity labels are the noisiest. Hotkeys are
 * `1`..`5` in that same order, so the legend's row number IS its key.
 *
 * THE FRAME-TIME GRAPH IS NOT HERE, and its absence is a decision. It measures
 * the RENDERER — a wall clock and a draw-call count — which `src/core` may not
 * read, so it is always-on furniture of `src/ui/debug-panel.ts` rather than a
 * layer of a snapshot computed from the session.
 */
export const DEBUG_LAYERS: readonly DebugLayer[] = Object.freeze([
  { id: 'navGrid', label: 'Nav grid', hotkey: '1' },
  { id: 'flowField', label: 'Flow field', hotkey: '2' },
  { id: 'losRays', label: 'LOS rays', hotkey: '3' },
  { id: 'ai', label: 'AI state', hotkey: '4' },
  { id: 'entityIds', label: 'Entity ids', hotkey: '5' },
] as const satisfies readonly DebugLayer[])

/**
 * The layer a key toggles, or `undefined` for a key that toggles nothing.
 *
 * A linear scan over five entries, called once per keypress: a `Map` built at
 * module load would be faster and would also be a second copy of the table
 * above, which is the drift this file exists to prevent.
 */
export function layerForHotkey(key: string): DebugLayer | undefined {
  for (const layer of DEBUG_LAYERS) {
    if (layer.hotkey === key) return layer
  }
  return undefined
}
