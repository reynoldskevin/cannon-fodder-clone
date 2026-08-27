/**
 * THE MISSION CARD (ticket 040): one sentence, on black, and a way in.
 *
 * `Mission <n>. With <N> soldiers you must: <objectives>` — the copy the player
 * asked for, and the whole screen. It replaced a three-list briefing (level
 * name, objectives, landing party) because the flow around it changed: the
 * player no longer picks his squad, so a manifest naming each man in spawn order
 * was telling him about a decision he was never given.
 *
 * DRAWS `BriefingModel` AND DECIDES NOTHING. The mission number, the soldier
 * count and the objectives in the author's own order are all settled in
 * `core/flow/screens.ts`; this file is a template and a loop. In particular the
 * COUNT IS THE MODEL'S, not `model.squad.length` read here: `soldierCount` is
 * built from the very list the model returns, and a screen that derived its own
 * would be a second answer to the only number on the card.
 *
 * IT IS BLACK, NOT THE SHARED CHROME. Every other campaign screen is a panel
 * floating on a dimmed canvas — see `screen-chrome.ts` — and this one is
 * deliberately not: the card is a beat between the memorial and the beach, and a
 * translucent panel with the last mission's terrain showing through it is not a
 * beat, it is a dialog. So it builds its own full-bleed backdrop, and that is
 * the one thing this screen does differently from its siblings.
 *
 * THERE IS NO WAY BACK, AND THAT IS THE CHART'S DOING RATHER THAN THIS FILE'S.
 * `ARCHITECTURE_DIAGRAM.md` has no row out of `Briefing` except `deploy`, so a
 * back button here would need a transition that does not exist; adding one is a
 * change to the chart and to the document it is checked against, not to a
 * screen.
 */

import { createButton, TEXT } from './screen-chrome'
import { objectiveLabel } from './hud'
import type { BriefingModel } from '../core/flow'

export interface BriefingOptions {
  readonly model: BriefingModel
  /** Send them in. The chart decides where that goes. */
  readonly onDeploy: () => void
}

export interface BriefingScreen {
  /** Take the screen down and stop the Deploy button firing. Safe to call twice. */
  dispose(): void
}

/**
 * The card's sentence, minus its list of objectives.
 *
 * A PURE STRING FUNCTION FOR THE REASON `graveLine` IS ONE: the wording is the
 * only part of a screen that can be checked by anything but an eye, and `src/ui`
 * has no tests because Vitest runs `environment: 'node'`. Pulling it out at
 * least makes it readable in one place rather than assembled out of four
 * `textContent` assignments.
 *
 * "1 soldiers" IS THE ONE THING WORTH THE BRANCH. A level with a single landing
 * position is a real level to author, and a card that opened the last mission of
 * a wiped campaign with "With 1 soldiers you must" would be the game's own copy
 * reading like a placeholder.
 */
export function missionLine(levelNumber: number, soldierCount: number): string {
  const men = soldierCount === 1 ? '1 soldier' : `${String(soldierCount)} soldiers`
  return `Mission ${String(levelNumber)}. With ${men} you must:`
}

/** The full-bleed black the card sits on. Not `screen-chrome`'s dimmed panel. */
const CARD_STYLE = [
  'position:fixed',
  'inset:0',
  'z-index:60',
  'display:flex',
  'flex-direction:column',
  'align-items:flex-start',
  'justify-content:center',
  'gap:1.25rem',
  'padding:2rem clamp(2rem, 12vw, 10rem)',
  // Opaque, and the point of the screen. See the header.
  'background:#000',
  'font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
  `color:${TEXT}`,
].join(';')

export function createBriefing(mount: HTMLElement, options: BriefingOptions): BriefingScreen {
  const { model } = options

  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  // `aria-modal="false"` deliberately, as Boot Hill and the Menu have it: the
  // canvas is still on the page underneath, and claiming a modal would tell a
  // screen reader the rest of it had gone away when it has not.
  backdrop.setAttribute('aria-modal', 'false')
  backdrop.setAttribute('aria-label', 'Mission briefing')
  backdrop.style.cssText = CARD_STYLE

  const line = document.createElement('h1')
  line.textContent = missionLine(model.levelNumber, model.soldierCount)
  line.style.cssText = 'margin:0;font-size:clamp(1.1rem, 3.2vw, 1.9rem);font-weight:600'

  const objectives = document.createElement('ul')
  objectives.style.cssText =
    'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.5rem;font-size:clamp(1rem, 2.6vw, 1.5rem)'
  for (const type of model.objectives) {
    const row = document.createElement('li')
    // THE HUD'S OWN WORDING, so the list the player reads here is the list he
    // reads in the corner of the screen thirty seconds later. See `objectiveLabel`.
    row.textContent = `— ${objectiveLabel(type)}`
    objectives.append(row)
  }

  const deploy = createButton('Start')

  backdrop.append(line, objectives, deploy)
  mount.append(backdrop)
  // Focused, so the keyboard alone can start the mission — and so the player's
  // next click does not go to the canvas underneath by accident.
  deploy.focus()

  let done = false
  const dispose = (): void => {
    if (done) return
    done = true
    backdrop.remove()
  }

  deploy.addEventListener('click', () => {
    // The same flag as the removal: `dispose` detaches the backdrop but does not
    // drop this listener, and a second deploy costs an entire Three.js scene —
    // which is exactly what the runner refuses, but a screen that fired twice
    // would be relying on it to.
    if (done) return
    // The screen is NOT torn down here. The router reconciles from
    // `runner.screen()` after the command, so a refused Start leaves the card up
    // rather than leaving the player with no screen at all.
    options.onDeploy()
  })

  return { dispose }
}
