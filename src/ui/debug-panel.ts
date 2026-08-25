/**
 * The debug panel (ticket 014): draw calls, the frame-time graph, and the layer
 * legend.
 *
 * THIS IS WHERE THE REAL CLOCK IS READ, AND THAT IS CORRECT. `src/core` may not
 * read a wall clock, and `src/core/debug/__tests__/purity.test.ts` asserts it —
 * but what this panel measures is the RENDERER, not the simulation. A frame-time
 * graph fed the fixed timestep would be a flat line at 16.67 ms whatever the
 * machine was doing, which is precisely the instrument lying quietly. Wanting to
 * put this in `core/debug` and finding the rule in the way is the rule working.
 *
 * THE LEGEND IS GENERATED FROM `DEBUG_LAYERS`, never written out here. A list of
 * rows typed into this file would be a second statement of which keys do what,
 * and it would go stale the first time a layer was added — the key would work
 * and the panel would not mention it.
 *
 * DOM APIs and inline styles, matching `hud.ts` and `control-hint.ts`, so the UI
 * layer stays free of a stylesheet the build would have to ship. Nothing in
 * `src/ui` is unit-tested: Vitest runs `environment: 'node'` and there is no DOM
 * at test time, which is exactly why everything this panel could get wrong lives
 * on the other side of `core/debug`.
 */

import { DEBUG_LAYERS } from '../core/debug'
import type { DebugLayerId } from '../core/debug'

/** What the panel is told each frame. The frame delta it measures itself. */
export interface DebugPanelModel {
  /** Draw calls in the last rendered frame, from `WebGLRenderer.info`. */
  readonly drawCalls: number
  /** Which layers are currently on, so the legend can light their rows. */
  readonly active: ReadonlySet<DebugLayerId>
}

export interface DebugPanel {
  /** Redraw. Reads the wall clock to measure the gap since the last call. */
  update(model: DebugPanelModel): void
  /** Remove the panel. Safe to call twice. */
  dispose(): void
}

/** Matched to `hud.ts` so the two panels read as one interface. */
const PANEL_BACKGROUND = 'rgba(13,16,18,0.82)'
const TEXT = '#f2efe6'
const MUTED = '#9fb3bd'
const ON = '#8fd694'
const MONO = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * How many frames the graph shows.
 *
 * A FIXED-SIZE RING BUFFER, and the size is the point. The obvious spelling —
 * `samples.push(dt)` and slice the tail off when drawing — grows an array by 60
 * entries a second for as long as the overlay is open, which on a tuning session
 * measured in tens of minutes is a leak in a tool whose whole job is to make
 * leaks visible. Here nothing is ever allocated after construction.
 */
const SAMPLE_COUNT = 120

/** Graph size in CSS pixels. One column per sample, so width follows the count. */
const GRAPH_WIDTH = SAMPLE_COUNT
const GRAPH_HEIGHT = 40

/** The graph's ceiling in ms: 33.3 is two dropped frames at 60 Hz. */
const GRAPH_MAX_MS = 33.3

/** The 60 Hz budget, drawn as a line so "over budget" is visible, not computed. */
const BUDGET_MS = 1000 / 60

const PANEL_STYLE = [
  'position:fixed',
  'top:0.75rem',
  'right:0.75rem',
  'z-index:45',
  'display:flex',
  'flex-direction:column',
  'gap:0.4rem',
  'padding:0.6rem 0.7rem',
  'border-radius:8px',
  'background:' + PANEL_BACKGROUND,
  'color:' + TEXT,
  'font:' + MONO,
  // The panel sits over the canvas and must never eat a click meant for the
  // squad, exactly as the HUD must not: an order given through it never arrives.
  'pointer-events:none',
  'user-select:none',
].join(';')

/** Write `text` into `node` only when it has actually changed — see `hud.ts`. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function createDebugPanel(mount: HTMLElement): DebugPanel {
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', 'Debug')
  panel.style.cssText = PANEL_STYLE

  const readout = document.createElement('div')
  readout.style.cssText = 'display:flex;justify-content:space-between;gap:1rem'

  const frameText = document.createElement('span')
  const drawText = document.createElement('span')
  drawText.style.color = MUTED
  readout.append(frameText, drawText)

  const canvas = document.createElement('canvas')
  canvas.width = GRAPH_WIDTH
  canvas.height = GRAPH_HEIGHT
  canvas.style.cssText = `width:${String(GRAPH_WIDTH)}px;height:${String(GRAPH_HEIGHT)}px;display:block;border-radius:3px;background:rgba(0,0,0,0.35)`
  const context = canvas.getContext('2d')

  const legend = document.createElement('div')
  legend.style.cssText = 'display:flex;flex-direction:column;gap:0.1rem'

  /**
   * One row per layer, built once from the registry.
   *
   * Built once because the registry is a constant: rebuilding these five
   * elements every frame would throw away and reallocate the whole legend 60
   * times a second to say the same five things.
   */
  const rows = DEBUG_LAYERS.map((layer) => {
    const row = document.createElement('div')
    row.textContent = `${layer.hotkey}  ${layer.label}`
    row.style.color = MUTED
    legend.append(row)
    return { id: layer.id, row }
  })

  panel.append(readout, canvas, legend)
  mount.append(panel)

  /** Frame times in ms, oldest-first once the ring has wrapped. */
  const samples = new Float32Array(SAMPLE_COUNT)
  let write = 0
  let filled = 0
  let previous = performance.now()

  function drawGraph(): void {
    if (context === null) return
    context.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT)
    context.fillStyle = 'rgba(159,179,189,0.35)'
    const budgetY = GRAPH_HEIGHT - (BUDGET_MS / GRAPH_MAX_MS) * GRAPH_HEIGHT
    context.fillRect(0, budgetY, GRAPH_WIDTH, 1)
    for (let i = 0; i < filled; i += 1) {
      // Oldest sample on the left: the ring's write head is the newest, so the
      // column for `i` reads back from it.
      const sample = samples[(write - filled + i + SAMPLE_COUNT) % SAMPLE_COUNT] ?? 0
      const clamped = sample > GRAPH_MAX_MS ? GRAPH_MAX_MS : sample
      const height = (clamped / GRAPH_MAX_MS) * GRAPH_HEIGHT
      context.fillStyle = sample > BUDGET_MS ? '#ff8f6b' : ON
      context.fillRect(i, GRAPH_HEIGHT - height, 1, height)
    }
  }

  function update(model: DebugPanelModel): void {
    // THE REAL CLOCK, read here and nowhere in `src/core`. The gap between two
    // calls of this function is what the player actually experiences, which is
    // the number a tuner is looking for; the simulation's own step is fixed and
    // says nothing about whether the machine is keeping up.
    const now = performance.now()
    const frameMs = now - previous
    previous = now
    samples[write] = frameMs
    write = (write + 1) % SAMPLE_COUNT
    if (filled < SAMPLE_COUNT) filled += 1

    setText(frameText, `${frameMs.toFixed(1)} ms`)
    setText(drawText, `${String(model.drawCalls)} draws`)
    drawGraph()

    for (const { id, row } of rows) {
      const on = model.active.has(id)
      const colour = on ? ON : MUTED
      if (row.style.color !== colour) row.style.color = colour
    }
  }

  return {
    update,
    dispose(): void {
      panel.remove()
    },
  }
}
