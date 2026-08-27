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
 * IT IS BLACK, AND SINCE TICKET 043 SO IS EVERY OTHER CAMPAIGN SCREEN. This file
 * used to be the exception — the Menu and Boot Hill were panels floating on a
 * dimmed canvas with the level showing through, and this one was not, on the
 * reasoning that the card is a beat between the memorial and the beach and a
 * translucent dialog is not a beat. That reasoning was right and it applied to
 * all three, so the other two moved onto this look rather than this one moving
 * back. The value now lives in `screen-chrome.ts` and this screen reads it.
 *
 * THERE IS NO WAY BACK, AND THAT IS THE CHART'S DOING RATHER THAN THIS FILE'S.
 * `ARCHITECTURE_DIAGRAM.md` has no row out of `Briefing` except `deploy`, so a
 * back button here would need a transition that does not exist; adding one is a
 * change to the chart and to the document it is checked against, not to a
 * screen.
 */

import { createButton, createChrome } from './screen-chrome'
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

export function createBriefing(mount: HTMLElement, options: BriefingOptions): BriefingScreen {
  const { model } = options

  // `createChrome` sets the role, the `aria-modal="false"` this screen used to
  // set by hand, and the label. It is also what puts the content in a COLUMN
  // rather than straight onto the backdrop — which is not cosmetic: the shared
  // backdrop carries `pointer-events:none` so a stray click is swallowed, and
  // that inherits, so the Start button appended directly to it could not be
  // clicked at all. This screen's own backdrop never had that rule, so the bug
  // arrived with the convergence and was caught by pressing the button.
  const { backdrop, panel } = createChrome('Mission briefing')

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

  panel.append(line, objectives, deploy)
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
