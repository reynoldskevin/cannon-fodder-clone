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
 * THE WHOLE CARD IS NOW QUIET (ticket 072). It began as the two blocks the left
 * rail says better — the rail names every living man and paints both weapons
 * with their remaining rounds, so the roster pips and the monospace selector had
 * become a second telling of facts the player was already reading elsewhere on
 * the same screen — and it ended, on the user's call, as the card entire: "squad
 * 3/3, the timer and the objective also — that whole box can go."
 *
 * SO THE MISSION CLOCK AND THE OBJECTIVE PROGRESS ARE NOW SHOWN NOWHERE IN THE
 * GAME. Nothing else states them; that is not an oversight this file should
 * quietly repair, it is the decision, and `HUD_PANEL_SHOWN` is where it lives so
 * that whoever wants it back has one constant to flip rather than a commit to
 * reconstruct.
 *
 * HIDDEN, NOT REMOVED, at both levels: everything that builds and pools every
 * block is still here, `RAIL_SUPERSEDED` still names only what the rail really
 * duplicates, and the panel switch sits ABOVE it rather than swallowing it.
 *
 * UPDATED EVERY FRAME, WRITTEN ONLY ON CHANGE. `update` is called from the
 * render loop, so it runs 60+ times a second for a readout that changes once a
 * second at most; assigning `textContent` unconditionally would dirty the same
 * text nodes every frame and invite a layout pass the game does not need.
 */

import { selectorLine } from '../core/armoury'
import { ROSTER_COLUMN_WIDTH } from './roster-column'
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
  /**
   * Show or hide the panel, WITHOUT tearing it down (ticket 022b).
   *
   * HOW TO HIDE, NOT WHEN. The HUD has no idea which screen the game is on and
   * is not given one; the router in `app/main.ts` owns that question and answers
   * it from `viewFor`. This is the mechanism it drives.
   *
   * A TOGGLE RATHER THAN A DISPOSE-AND-REBUILD, because the pips, objective
   * lines and selector rows above are pooled precisely so a mission does not
   * reallocate them — see the note on `pips`. Rebuilding the HUD on every screen
   * transition would throw that pool away for nothing.
   */
  setVisible(visible: boolean): void
  /** Whether the panel is currently shown. See `setVisible`. */
  isVisible(): boolean
  /** Remove the HUD. Safe to call twice. */
  dispose(): void
}

/**
 * One block of the panel, from the top down.
 *
 * NAMED SO THAT HIDING ONE IS A DECISION AND NOT AN EDIT. Before this list the
 * only way to take a block off the screen was to reach into `createHud` and
 * delete the append, which also deleted the pooling underneath it and made
 * bringing it back a revert rather than a choice.
 */
export type HudSection = 'header' | 'roster' | 'objectives' | 'selector'

/**
 * Every section the panel has.
 *
 * EXHAUSTIVE ON PURPOSE. `RAIL_SUPERSEDED` is checked against this, so a
 * misspelt entry there is caught instead of quietly hiding nothing — a typo in a
 * hide-list has no symptom except the readout the ticket meant to remove still
 * being on screen, which is exactly what nobody looks for twice.
 */
export const HUD_SECTIONS: readonly HudSection[] = ['header', 'roster', 'objectives', 'selector']

/**
 * The sections the left rail (`squad-panel.ts`) now says better (ticket 072).
 *
 * The rail names every living man and paints both weapons with their remaining
 * rounds, which is what the roster pips and the monospace selector were for. Two
 * readouts of the same fact in two vocabularies is not redundancy the player
 * benefits from; it is two things he must reconcile mid-firefight.
 *
 * HIDDEN, NOT DELETED. The elements below are still built and still pooled, so
 * emptying this list is the whole of bringing either block back.
 *
 * THE HEADER AND THE OBJECTIVES ARE NOT IN HERE, and must not drift into it,
 * even though `HUD_PANEL_SHOWN` now hides them too. This list means one specific
 * thing — "the rail already says this" — and the rail says neither: it shows the
 * LIVING only, so `Squad 3/5` was the one statement of a loss, and it shows no
 * clock and no objective at all. They are off because the CARD is off, which is
 * a different decision recorded in a different constant. Folding them in here
 * would mean anybody who ever switched the card back on got two roster readouts
 * with it and would have to rediscover this whole ticket to find out why.
 */
export const RAIL_SUPERSEDED: readonly HudSection[] = ['roster', 'selector']

/**
 * Whether the mission card is drawn at all (ticket 072, widened).
 *
 * THE USER'S CALL, IN ONE PLACE. The argument for keeping the header was that
 * the rail lists the LIVING only, so `Squad 3/5` was the mission screen's single
 * statement of a loss, and the clock had nowhere else to go; the answer was that
 * the whole box can go. It does. The mission clock and the objective progress
 * are, from here, shown NOWHERE in the game — deliberately, and reversibly.
 *
 * ONE LOUD CONSTANT RATHER THAN FOUR QUIET DELETIONS, because a decision this
 * broad has to be findable by somebody who was not in the room for it. Nothing
 * below is removed: the elements are built, the pools are wired, `createHud`
 * still runs and `app/main.ts` still builds, feeds and disposes the HUD in
 * ignorance of any of this. Flipping this to `true` restores the card — minus
 * the two blocks the rail genuinely duplicates, which stay hidden by
 * `RAIL_SUPERSEDED` on their own separate merits.
 *
 * TYPED `boolean` AND NOT THE LITERAL `false`, so that the type of a switch does
 * not depend on which position it is currently in. Checked rather than assumed:
 * the literal compiles clean today, `&&` narrows without complaint and neither
 * `tsc` nor eslint objects to the branch it makes unreachable. What the literal
 * WOULD do is make flipping this to `true` a change of type as well as of value
 * — and any `HUD_PANEL_SHOWN === true` written against it in the meantime a hard
 * "no overlap" error rather than a comparison. The annotation keeps the flip a
 * one-character edit.
 */
export const HUD_PANEL_SHOWN: boolean = false

/**
 * Whether the rail already says this section's piece.
 *
 * A FUNCTION OF ITS OWN SO THAT IT CAN BE ASKED WHILE THE CARD IS OFF. Folded
 * into `hudSectionShown`, this rule would be unobservable: with the panel switch
 * `false` that predicate answers `false` for everything, so a body reduced to
 * `return HUD_PANEL_SHOWN` would pass every test that could be written about it
 * — and would hand a second roster to whoever switched the card back on for the
 * clock's sake, silently, months later. Split out, the rule keeps being true and
 * keeps being checked while its answer is hidden.
 */
export function railSupersedes(section: HudSection): boolean {
  return RAIL_SUPERSEDED.includes(section)
}

/**
 * Whether a section is drawn at all.
 *
 * ASKED IN BOTH PLACES, WHICH IS THE POINT OF IT BEING A FUNCTION. A bare
 * `display:none` beside a loop that still runs writes text into an invisible
 * node sixty times a second; a skipped loop beside a block that is still
 * appended shows an empty box the day somebody re-enables it. One predicate
 * gates the pixels and the per-frame work together, so they can only come back
 * together.
 *
 * THE PANEL SWITCH IS ASKED FIRST, AND SEPARATELY. A section of a card that is
 * not on screen is not on screen, whatever its own merits — so with the panel
 * off this answers `false` for every section, including the header the rail
 * never superseded. Keeping the two questions stacked rather than merged is what
 * stops "I want the clock back" from also handing the player a second roster.
 */
export function hudSectionShown(section: HudSection): boolean {
  if (!HUD_PANEL_SHOWN) return false
  return !railSupersedes(section)
}

/** Panel background and text, matched to the error overlay's palette. */
const PANEL_BACKGROUND = 'rgba(13,16,18,0.72)'
const TEXT = '#f2efe6'
const MUTED = '#9fb3bd'
const DONE = '#8fd694'
const LOST = '#ff8f6b'

/**
 * The panel's `display` when it is shown.
 *
 * A constant because `setVisible` has to put this exact value back after
 * `display:none`; a literal in both places would silently break the layout the
 * day the panel stopped being a column.
 */
const PANEL_DISPLAY = 'flex'

const PANEL_STYLE = [
  'position:fixed',
  'top:0.75rem',
  /**
   * CLEAR OF THE SQUAD RAIL (ticket 065). The rail is a fixed, full-height
   * column flush to the left edge and the HUD is a fixed card that used to sit
   * at `0.75rem` — which is INSIDE it. Both are shown on exactly the same
   * screens, so the overlap would not be an edge case: it would be every
   * mission, with the roster reading through the panel.
   *
   * BUILT FROM THE SHARED WIDTH rather than from a number that happens to clear
   * it today. A second spelling would put the HUD back over the rail the day
   * either column was resized, and nothing would fail.
   */
  `left:calc(${ROSTER_COLUMN_WIDTH} + 0.75rem)`,
  'z-index:40',
  `display:${PANEL_DISPLAY}`,
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

/**
 * What one objective type is called on screen.
 *
 * EXPORTED SO THE BRIEFING SAYS THE SAME WORDS (ticket 022b). The player reads
 * the objective list on the Briefing and then again in the HUD a few seconds
 * later; two tables would let "Eliminate all enemies" and something else name
 * the same `kill_all`, and he would be comparing two lists against each other
 * instead of playing the level.
 */
export function objectiveLabel(type: string): string {
  return OBJECTIVE_LABELS[type] ?? type
}

/** One objective as a line of text: what it is, and how far through it the squad is. */
export function objectiveLine(progress: ObjectiveProgress): string {
  const label = objectiveLabel(progress.type)
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
  // HIDDEN UNTIL THE ROUTER SAYS OTHERWISE. The HUD is built once, at boot,
  // before the first screen is decided; visible-by-default would put a squad
  // count and a mission clock on the page for whatever screen the game opens on.
  panel.style.display = 'none'

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
  /**
   * STILL APPENDED, JUST NOT SHOWN. Hiding by `display` rather than by leaving
   * the block out of the tree keeps the pools below wired to a real parent, so
   * the only difference between hidden and shown is the gate's answer.
   *
   * ONLY EVER HIDES, AND NEVER WRITES A `display` OF ITS OWN. Each block already
   * declared one in its own `cssText`, and a shown branch here would be a second
   * spelling of it — right today, and wrong the first time one of them stops
   * being a flex column. A shown block is simply left as it built itself.
   */
  const gate = (shown: boolean, block: HTMLElement): void => {
    if (!shown) block.style.display = 'none'
  }
  /**
   * ALL FOUR, THOUGH ONLY TWO ARE SUPERSEDED TODAY. `RAIL_SUPERSEDED` is typed
   * to accept any section, so gating only the two that are currently in it would
   * make adding `'header'` to that list a silent no-op — a hide-list entry that
   * hides nothing, which is the one failure mode with no symptom at all.
   */
  gate(hudSectionShown('header'), header)
  gate(hudSectionShown('roster'), roster)
  gate(hudSectionShown('objectives'), objectives)
  gate(hudSectionShown('selector'), selector)
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
    if (hudSectionShown('header')) {
      const alive = model.squad.filter((member) => member.alive).length
      setText(squadCount, `Squad ${String(alive)}/${String(model.squad.length)}`)
      setText(timer, formatMissionTime(model.elapsedTicks))
    }

    // THE SAME ANSWER THAT HID THE BLOCK SKIPS ITS WORK. The model still arrives
    // whole — `app/main.ts` hands over squad and selector regardless, because the
    // model is what the HUD is ENTITLED to draw, not what it currently chooses
    // to — and this is the only place that choosing happens.
    if (hudSectionShown('roster')) {
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
    }

    if (hudSectionShown('objectives')) {
      for (let i = 0; i < model.objectives.length; i += 1) {
        const progress = model.objectives[i]
        if (progress === undefined) continue
        const line = lineAt(i)
        setText(line, objectiveLine(progress))
        const colour = !progress.supported ? LOST : progress.complete ? DONE : MUTED
        if (line.style.color !== colour) line.style.color = colour
      }
    }

    if (hudSectionShown('selector')) {
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
  }

  return {
    update,
    /**
     * HONOURED HERE, NOT BY THE CALLER REMEMBERING. `app/main.ts` calls
     * `setVisible(true)` on every mission and knows nothing about ticket 072 —
     * which is right: the router's job is to say WHICH SCREEN IT IS, and this
     * file's job is to say what the HUD does about that. So the panel switch is
     * enforced at the one place that writes the panel's `display`, and asking to
     * be shown while the card is off is simply a request that cannot be granted.
     */
    setVisible(visible: boolean): void {
      panel.style.display = visible && HUD_PANEL_SHOWN ? PANEL_DISPLAY : 'none'
    },
    /**
     * ANSWERS ABOUT THE PIXELS, WHICH IS WHY IT ANSWERS `false`. `main.ts` gates
     * its entire per-frame `hud.update(...)` — including assembling the model —
     * on this, so reporting "visible" while showing nothing would leave the game
     * formatting a clock and a roster into invisible nodes sixty times a second.
     * The cost has to leave with the pixels, and reading the element's own
     * `display` back is what guarantees the two can never disagree.
     */
    isVisible(): boolean {
      return panel.style.display !== 'none'
    },
    dispose(): void {
      panel.remove()
    },
  }
}
