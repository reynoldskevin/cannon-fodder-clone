/**
 * The mission HUD (ticket 013): the squad roster, the objectives, the clock and
 * — since ticket 016 — the weapon selector.
 *
 * DRAWS WHAT THE SESSION ALREADY KNOWS AND DECIDES NOTHING. Every question this
 * file could get wrong — whether an objective is complete, how far through it
 * the player is, how long the mission has run — is answered in
 * `src/core/objectives`, where Vitest can see it under Node. Vitest runs with
 * `environment: 'node'`, so there is no DOM at test time and nothing in this
 * directory is unit-tested at all; anything decided here would be verified by
 * looking at the screen and nowhere else. What is left is layout.
 *
 * Built with DOM APIs and inline styles, matching `control-hint.ts` and
 * `error-overlay.ts`, so the UI layer stays free of a stylesheet the build would
 * have to ship.
 *
 * UPDATED EVERY FRAME, WRITTEN ONLY ON CHANGE. `update` is called from the
 * render loop, so it runs 60+ times a second for a readout that changes once a
 * second at most; assigning `textContent` unconditionally would dirty the same
 * text nodes every frame and invite a layout pass the game does not need.
 */

import { selectorLine } from '../core/armoury'
import { FIXED_TIMESTEP } from '../core/world'
import type { ArmourySlot } from '../core/armoury'
import type { ObjectiveProgress } from '../core/objectives'

/** One man on the roster. `alive` is the only thing that changes about him. */
export interface RosterMember {
  readonly id: number
  readonly alive: boolean
}

/** Everything the HUD draws, as of this frame. */
export interface HudModel {
  /** The squad, in spawn order — the order the player thinks of them in. */
  readonly squad: readonly RosterMember[]
  readonly objectives: readonly ObjectiveProgress[]
  /** The simulation's own clock. Divided by the fixed timestep, never by a wall clock. */
  readonly elapsedTicks: number
  /**
   * The weapon selector, straight from `Armoury.slots()` (ticket 016).
   *
   * EVERY DECISION IN IT WAS ALREADY MADE. Which weapons exist, which is
   * active, how many rounds are left and what each row reads as are all
   * `src/core/armoury`'s, where Vitest can see them under Node; what is left
   * here is which element the text goes into. That split is the only reason
   * "the HUD shows the active type and remaining counts" is a testable claim at
   * all — see the header, and `core/debug/layers.ts` before it.
   */
  readonly selector: readonly ArmourySlot[]
}

export interface Hud {
  /** Redraw from `model`. Cheap to call every frame; see the note above. */
  update(model: HudModel): void
  /** Remove the HUD. Safe to call twice. */
  dispose(): void
}

/** Panel background and text, matched to the error overlay's palette. */
const PANEL_BACKGROUND = 'rgba(13,16,18,0.72)'
const TEXT = '#f2efe6'
const MUTED = '#9fb3bd'
const DONE = '#8fd694'
const LOST = '#ff8f6b'

const PANEL_STYLE = [
  'position:fixed',
  'top:0.75rem',
  'left:0.75rem',
  'z-index:40',
  'display:flex',
  'flex-direction:column',
  'gap:0.5rem',
  'min-width:13rem',
  'max-width:min(22rem, calc(100vw - 1.5rem))',
  'padding:0.6rem 0.85rem',
  'border-radius:8px',
  'background:' + PANEL_BACKGROUND,
  'color:' + TEXT,
  'font:13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
  // The HUD sits over the canvas and must never eat a click meant for the
  // squad: an order given through the panel is an order that never arrives.
  'pointer-events:none',
  'user-select:none',
].join(';')

/**
 * What each objective type is called on screen.
 *
 * An open enum by decision (`core/level/types.ts`), so a type this build does
 * not know is shown by its own name rather than hidden: a mission asking for
 * something the game cannot evaluate must be readable as exactly that.
 */
const OBJECTIVE_LABELS: Readonly<Record<string, string>> = {
  kill_all: 'Eliminate all enemies',
  kill_count: 'Eliminate enemies',
  collect_chests: 'Collect the chests',
  reach_area: 'Reach the objective',
}

/** `mm:ss`, from the tick count. The sim's clock is the only clock here. */
export function formatMissionTime(ticks: number): string {
  const seconds = Math.max(0, Math.floor(ticks * FIXED_TIMESTEP))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`
}

/** One objective as a line of text: what it is, and how far through it the squad is. */
export function objectiveLine(progress: ObjectiveProgress): string {
  const label = OBJECTIVE_LABELS[progress.type] ?? progress.type
  if (!progress.supported) return `${label} — not available in this build`
  // A count only where counting means something. `reach_area` is 0/1 and 1/1
  // internally, which is the right shape for the model and reads as noise here.
  const counted = progress.total > 1 ? ` ${String(progress.done)}/${String(progress.total)}` : ''
  return `${progress.complete ? '✓' : '○'} ${label}${counted}`
}

/** Write `text` into `node` only when it has actually changed. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function createHud(mount: HTMLElement): Hud {
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', 'Mission status')
  panel.style.cssText = PANEL_STYLE

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:space-between;gap:1rem;align-items:baseline'

  const squadCount = document.createElement('span')
  squadCount.style.cssText = 'font-weight:600;letter-spacing:0.04em;text-transform:uppercase'

  const timer = document.createElement('span')
  timer.style.cssText = `color:${MUTED};font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace`

  header.append(squadCount, timer)

  /** The roster, as one pip per man: alive is lit, dead is struck through. */
  const roster = document.createElement('div')
  roster.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.3rem'

  const objectives = document.createElement('ul')
  objectives.style.cssText = 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.2rem'

  /** The weapon selector: one row per known weapon, its key printed beside it. */
  const selector = document.createElement('div')
  selector.style.cssText =
    'display:flex;flex-direction:column;gap:0.15rem;font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace'

  panel.append(header, roster, objectives, selector)
  mount.append(panel)

  /**
   * The pip and line elements, by position in their list.
   *
   * Kept and reused rather than rebuilt per frame: the roster is fixed for a
   * mission and the objectives are fixed for a level, so the only thing that
   * changes is text and colour. Rebuilding would throw away and reallocate a
   * dozen elements 60 times a second to say the same thing.
   */
  const pips: HTMLElement[] = []
  const lines: HTMLElement[] = []
  /** One selector row: the line of text, and the hotkey pushed to the right of it. */
  const slotRows: { readonly text: HTMLElement; readonly key: HTMLElement }[] = []

  function pipAt(index: number): HTMLElement {
    const existing = pips[index]
    if (existing !== undefined) return existing
    const pip = document.createElement('span')
    pip.style.cssText = [
      'min-width:1.35rem',
      'padding:0.05rem 0.3rem',
      'border-radius:4px',
      'text-align:center',
      'font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    ].join(';')
    pips[index] = pip
    roster.append(pip)
    return pip
  }

  function lineAt(index: number): HTMLElement {
    const existing = lines[index]
    if (existing !== undefined) return existing
    const line = document.createElement('li')
    lines[index] = line
    objectives.append(line)
    return line
  }

  function slotAt(index: number): { readonly text: HTMLElement; readonly key: HTMLElement } {
    const existing = slotRows[index]
    if (existing !== undefined) return existing
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:space-between;gap:0.75rem'
    const text = document.createElement('span')
    const key = document.createElement('span')
    key.style.color = MUTED
    row.append(text, key)
    const made = { text, key }
    slotRows[index] = made
    selector.append(row)
    return made
  }

  function update(model: HudModel): void {
    const alive = model.squad.filter((member) => member.alive).length
    setText(squadCount, `Squad ${String(alive)}/${String(model.squad.length)}`)
    setText(timer, formatMissionTime(model.elapsedTicks))

    for (let i = 0; i < model.squad.length; i += 1) {
      const member = model.squad[i]
      if (member === undefined) continue
      const pip = pipAt(i)
      setText(pip, String(i + 1))
      // Colour AND a strike-through, not colour alone: "which of my men are
      // down" must survive a colour-blind player and a washed-out screen.
      const state = member.alive ? 'alive' : 'dead'
      if (pip.dataset.state !== state) {
        pip.dataset.state = state
        pip.style.background = member.alive ? 'rgba(143,214,148,0.18)' : 'rgba(255,143,107,0.14)'
        pip.style.color = member.alive ? DONE : LOST
        pip.style.textDecoration = member.alive ? 'none' : 'line-through'
      }
    }

    for (let i = 0; i < model.objectives.length; i += 1) {
      const progress = model.objectives[i]
      if (progress === undefined) continue
      const line = lineAt(i)
      setText(line, objectiveLine(progress))
      const colour = !progress.supported ? LOST : progress.complete ? DONE : MUTED
      if (line.style.color !== colour) line.style.color = colour
    }

    for (let i = 0; i < model.selector.length; i += 1) {
      const slot = model.selector[i]
      if (slot === undefined) continue
      const row = slotAt(i)
      // The LINE comes from core and the HOTKEY is placed here: `selectorLine`
      // deliberately leaves the key out so the HUD can put it where it likes.
      setText(row.text, selectorLine(slot))
      setText(row.key, slot.hotkey)
      // Colour on top of the marker `selectorLine` already carries, never
      // instead of it: "which weapon am I holding" must survive a colour-blind
      // player and a washed-out screen, the same bargain the roster pips make.
      const colour = slot.active ? TEXT : MUTED
      if (row.text.style.color !== colour) row.text.style.color = colour
    }
  }

  return {
    update,
    dispose(): void {
      panel.remove()
    },
  }
}
