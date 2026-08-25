/**
 * `src/core/debug` — the pure half of the debug overlay (ticket 014).
 *
 * The registry of switchable layers, and the plain data each of them would
 * draw, computed from a `Session`. Engine-free like the rest of `src/core`: no
 * `three`, no DOM, no wall clock, no random draw, and no dynamic `import()` —
 * the gate that keeps this whole directory out of a normal build lives in
 * `src/app/main.ts`, which is the one place allowed to have it.
 */

export { DEBUG_LAYERS, layerForHotkey } from './layers'
export type { DebugLayer, DebugLayerId } from './layers'
export { debugSnapshot, emptySnapshot } from './snapshot'
export type {
  AiMarker,
  DebugSnapshot,
  EntityLabel,
  FlowArrow,
  LosRay,
  NavGridCell,
} from './snapshot'
