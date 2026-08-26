/**
 * BOOT HILL (ticket 022): the gravestones, and the promotions.
 *
 * DRAWS `BootHillModel` AND DECIDES NOTHING. Which men are on the hill, in what
 * order, what each stone says, which stones are new and who was promoted are all
 * answered in `src/core/campaign/boothill.ts`, where Vitest can see them under
 * Node. Vitest runs with `environment: 'node'`, so there is no DOM at test time
 * and nothing in this directory is unit-tested at all — anything decided here
 * would be verified by looking at the screen and nowhere else. What is left is
 * layout, and that is the whole reason the model exists.
 *
 * DOM APIs and inline styles, matching `hud.ts` and the campaign screens, so the
 * UI layer ships no stylesheet. Ticket 022b factored this file's backdrop, panel
 * and button into `screen-chrome.ts` for the four screens it added; this one
 * keeps its own copy rather than being rewritten to use them, because it is
 * shipped code the ticket had no reason to touch. The values are the same.
 *
 * ELEMENTS ARE REUSED AND TEXT IS WRITTEN ONLY ON CHANGE, the same bargain the
 * HUD makes. The hill is redrawn whenever the screen is shown and grows by a
 * stone or two a mission; rebuilding every row would throw away and reallocate
 * the entire memorial to add one name to the end of it.
 */

import type { BootHillModel, Grave, Promotion } from '../core/campaign'

export interface BootHillOptions {
  /**
   * Leave the memorial and go on to the next thing.
   *
   * Where that goes is `core/flow`'s answer, not this file's: Boot Hill leads to
   * Recruitment mid-campaign and to the Menu when the campaign is over, and a
   * screen that chose between them would be a second copy of the flow graph.
   */
  readonly onContinue: () => void
  /** What the button says. The flow knows where it leads; this file does not. */
  readonly continueLabel?: string
}

export interface BootHillScreen {
  /** Redraw from `model`. Safe to call repeatedly; rows are reused. */
  update(model: BootHillModel): void
  /**
   * Take the screen down and stop the Continue button firing. Safe to call
   * twice, and safe to call while a click is still reachable — both the removal
   * and `onContinue` are behind one flag, so nothing runs a second time.
   */
  dispose(): void
}

/** Matched to the HUD and `screen-chrome.ts`, so the game has one palette. */
const TEXT = '#f2efe6'
const MUTED = '#9fb3bd'
const PROMOTED = '#8fd694'
/** The colour of a fresh stone. The same warm one the lose screen uses. */
const FRESH = '#ff8f6b'

/**
 * The two stone markers: this mission's dead, and every mission before it.
 *
 * PRINTED CHARACTERS, NOT STYLING. Distinguishing the men who just died from
 * four levels of older stones is this screen's whole job, and colour plus font
 * weight would leave a colour-blind player weighing one line against another on
 * boldness alone — on a list that is already all one typeface. A cross the
 * reader can see is the signal; the colour is the reinforcement.
 *
 * BOTH ROWS CARRY ONE, so every line starts at the same column. Marking only
 * the fresh stones would indent them relative to the rest and make the hill
 * ragged exactly where it is meant to be legible.
 */
const MARK_FRESH = '✚'
const MARK_OLD = '·'

const BACKDROP_STYLE = [
  'position:fixed',
  'inset:0',
  'z-index:60',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'padding:2rem',
  'background:rgba(9,11,13,0.82)',
  'font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
  'color:' + TEXT,
  // The screen sits over the canvas, and a click that lands on the backdrop is
  // a click the player meant for nothing. Only the panel takes input — see
  // below — so a stray press cannot be swallowed by an invisible full-bleed
  // div, which is the failure `hud.ts` guards against for the same reason.
  'pointer-events:none',
].join(';')

const PANEL_STYLE = [
  'display:flex',
  'flex-direction:column',
  'gap:1rem',
  'width:min(34rem, 100%)',
  'max-height:100%',
  'padding:1.75rem 2rem',
  'border-radius:10px',
  'border:1px solid rgba(159,179,189,0.35)',
  'background:rgba(13,16,18,0.94)',
  // Re-enabled for the panel alone: the button inside it has to be clickable.
  'pointer-events:auto',
].join(';')

const LIST_STYLE = 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.35rem'

/** Write `text` into `node` only when it has actually changed. See `hud.ts`. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/**
 * One stone, as a line: who he was, what he was, where he fell and what it cost
 * the other side.
 *
 * A PURE STRING FUNCTION so the wording is one expression rather than four
 * appends — and so the only thing the row element does is hold it.
 */
export function graveLine(grave: Grave): string {
  const kills = grave.kills === 1 ? '1 kill' : `${String(grave.kills)} kills`
  return `${grave.rankAtDeath} ${grave.name} — fell on level ${String(grave.diedOnLevel)}, ${kills}`
}

/** One promotion, with BOTH ranks: the change is the news, not the new title. */
export function promotionLine(promotion: Promotion): string {
  return `${promotion.name}: ${promotion.from} → ${promotion.to}`
}

export function createBootHill(mount: HTMLElement, options: BootHillOptions): BootHillScreen {
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'false')
  backdrop.setAttribute('aria-label', 'Boot Hill')
  backdrop.style.cssText = BACKDROP_STYLE

  const panel = document.createElement('div')
  panel.style.cssText = PANEL_STYLE

  const heading = document.createElement('h1')
  heading.textContent = 'Boot Hill'
  heading.style.cssText = 'margin:0;font-size:1.5rem;letter-spacing:0.06em;text-transform:uppercase'

  /** The count, and the only line an empty hill shows. */
  const summary = document.createElement('p')
  summary.style.cssText = `margin:0;color:${MUTED}`

  /**
   * The stones. Scrolls on its own rather than growing the panel past the
   * viewport: the hill GROWS across a campaign, and by level five it is longer
   * than a screen — a memorial whose Continue button had been pushed off the
   * bottom would strand the player on it.
   */
  const graves = document.createElement('ul')
  graves.style.cssText = `${LIST_STYLE};overflow-y:auto;min-height:0`

  const promotionsHeading = document.createElement('h2')
  promotionsHeading.textContent = 'Promotions'
  promotionsHeading.style.cssText =
    'margin:0;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:' + MUTED

  const promotions = document.createElement('ul')
  promotions.style.cssText = LIST_STYLE

  const carryOn = document.createElement('button')
  carryOn.type = 'button'
  carryOn.textContent = options.continueLabel ?? 'Carry on'
  carryOn.style.cssText = [
    'align-self:flex-start',
    'margin-top:0.25rem',
    'padding:0.55rem 1.5rem',
    'border:1px solid rgba(159,179,189,0.55)',
    'border-radius:6px',
    'background:transparent',
    `color:${TEXT}`,
    'font:inherit',
    'cursor:pointer',
  ].join(';')

  panel.append(heading, summary, graves, promotionsHeading, promotions, carryOn)
  backdrop.append(panel)
  mount.append(backdrop)
  // Focused, so the keyboard alone can leave the memorial — and so the player's
  // next click does not go to the map underneath by accident.
  carryOn.focus()

  let done = false
  const dispose = (): void => {
    // Guarded rather than merely idempotent-by-luck: `remove()` on a detached
    // node is harmless, but the flag is what lets a caller that disposes on both
    // "the player clicked" and "the screen changed" do so without thinking.
    if (done) return
    done = true
    backdrop.remove()
  }

  carryOn.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — it does not drop this listener, and a detached button can
    // still be clicked by anything still holding a reference to it. Without
    // this, a second click fires `onContinue` again; the screen leads to
    // Recruitment, so a double fire advances the flow twice and the player is
    // handed a screen he never asked for. "Safe to call twice" has to cover the
    // callback too, or the docstring is claiming more than the code does.
    if (done) return
    // THE SCREEN IS NOT TORN DOWN HERE (ticket 022b). It used to remove itself
    // first, so that a transition that threw left the error overlay visible
    // rather than buried — which the overlay's own `z-index:100` over this
    // panel's 60 already guarantees. What it cost was a second owner of the
    // removal: the router in `main.ts` mounts exactly one screen for
    // `runner.screen()` and disposes it when that changes, so a memorial that
    // had already removed itself when the command was REFUSED would leave the
    // router agreeing that Boot Hill is still up and nothing at all on the page.
    // No refusal is reachable from Boot Hill today; this is the ordering being
    // made safe rather than a bug being fixed.
    options.onContinue()
  })

  /**
   * The row elements, by position in their list. Kept and reused for the reason
   * given in the header: the hill only ever gains rows at the end.
   */
  const graveRows: HTMLElement[] = []
  const promotionRows: HTMLElement[] = []

  function rowAt(cache: HTMLElement[], list: HTMLElement, index: number): HTMLElement {
    const existing = cache[index]
    if (existing !== undefined) return existing
    const row = document.createElement('li')
    cache[index] = row
    list.append(row)
    return row
  }

  /**
   * Hide the rows past `used` instead of removing them.
   *
   * A screen shown twice with different models must not leave the previous
   * one's tail on display — a promotion from last mission still listed under
   * this one's would be indistinguishable from a bug in `promotionsBetween`.
   */
  function trim(cache: readonly HTMLElement[], used: number): void {
    for (let i = used; i < cache.length; i += 1) {
      const row = cache[i]
      if (row !== undefined && row.style.display !== 'none') row.style.display = 'none'
    }
  }

  function update(model: BootHillModel): void {
    const count = model.graves.length
    setText(
      summary,
      count === 0
        ? 'No one has fallen yet.'
        : `${String(count)} ${count === 1 ? 'man' : 'men'} lie here.`,
    )

    // `fallenThisMission` is a subset of `graves` by position at the END of the
    // list — the dead list is append-only — so the fresh stones are the last
    // `fallenThisMission.length` of them. Matching by name instead would light
    // up the wrong stone the day two men share one.
    const freshFrom = count - model.fallenThisMission.length

    for (let i = 0; i < count; i += 1) {
      const grave = model.graves[i]
      if (grave === undefined) continue
      const row = rowAt(graveRows, graves, i)
      if (row.style.display !== '') row.style.display = ''
      const fresh = i >= freshFrom
      // A PRINTED MARKER FIRST, colour second: "which of these are new" must
      // survive a colour-blind player and a washed-out screen, the same bargain
      // the HUD's roster pips make. The marker is text rather than a `data-`
      // attribute or a font weight, because only text is something a reader can
      // actually see — see `MARK_FRESH`.
      setText(row, `${fresh ? MARK_FRESH : MARK_OLD} ${graveLine(grave)}`)
      const state = fresh ? 'fresh' : 'old'
      if (row.dataset.state !== state) {
        row.dataset.state = state
        row.style.color = fresh ? FRESH : MUTED
        row.style.fontWeight = fresh ? '600' : '400'
      }
    }
    trim(graveRows, count)

    // Hidden outright when nobody was promoted, rather than left as a heading
    // over nothing: an empty section reads as a screen that failed to load its
    // own content.
    const promoted = model.promotions.length
    // Restored to the EXPLICIT display each element was built with, never to
    // `''`: clearing the property drops the inline `display:flex` the list's
    // `cssText` set, and the column silently loses its gap the first time a
    // mission promotes nobody and the next one does.
    if (promotionsHeading.style.display !== (promoted > 0 ? 'block' : 'none')) {
      promotionsHeading.style.display = promoted > 0 ? 'block' : 'none'
      promotions.style.display = promoted > 0 ? 'flex' : 'none'
    }

    for (let i = 0; i < promoted; i += 1) {
      const promotion = model.promotions[i]
      if (promotion === undefined) continue
      const row = rowAt(promotionRows, promotions, i)
      if (row.style.display !== '') row.style.display = ''
      setText(row, promotionLine(promotion))
      if (row.style.color !== PROMOTED) row.style.color = PROMOTED
    }
    trim(promotionRows, promoted)
  }

  return { update, dispose }
}
