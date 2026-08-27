/**
 * THE MISSION CARD (ticket 040, redrawn to the original's own layout in 053).
 *
 * `assets/mockups/mission-briefing.png` is the screen this is now built to:
 * MISSION n underlined at the top, a hairline box below it, and inside the box
 * BRIEFING / "WITH n SOLDIERS YOU MUST" / the objectives / a gap / "n RECRUITS
 * REMAINING" / GO FOR IT. Everything centred, everything upper case, on black.
 *
 * IT IS A LAYOUT CHANGE AND NOT A FLOW CHANGE. The card says exactly what ticket
 * 040's sentence said — mission number, how many men, what they must do — plus
 * the one number the mockup has that the sentence never did. There is still one
 * way out of this screen and it is still `onDeploy`; `ARCHITECTURE_DIAGRAM.md`
 * has no row out of `Briefing` except `deploy`, so a back button here would be a
 * change to the chart rather than to a screen.
 *
 * DRAWS `BriefingModel` AND DECIDES NOTHING. The mission number, the soldier
 * count, the objectives in the author's own order and the size of the reserve
 * are all settled in `core/flow/screens.ts`. In particular BOTH COUNTS ARE THE
 * MODEL'S: `soldierCount` is built from the very list the model returns and
 * `recruitsRemaining` is computed against the campaign's living roster, so a
 * screen that derived either would be a second answer to a number the player is
 * about to risk men on.
 *
 * THE COPY IS THE ORIGINAL'S, INCLUDING "GO FOR IT". It is the button, it is
 * what the game has always called this, and a card that reads BRIEFING … GO FOR
 * IT and then hands you a button marked "Start" is a card that has been
 * translated by somebody who did not play it.
 *
 * UPPER CASE IN THE MARKUP, NOT IN CSS. `text-transform` leaves the accessible
 * name lower case and hands a screen reader "Go for it" while the button says
 * GO FOR IT — a difference nobody sees until it matters. These strings are
 * written the way they are read.
 */

import { createButton, createChrome, MUTED, TEXT } from './screen-chrome'
import { DISPLAY_FONT, loadDisplayFont } from './display-font'
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

/** The hairline the box and the underline are both drawn in. */
const RULE = MUTED

/**
 * The card's sentence, minus its list of objectives.
 *
 * A PURE STRING FUNCTION FOR THE REASON `graveLine` IS ONE: the wording is the
 * only part of a screen that can be checked by anything but an eye, and `src/ui`
 * has no tests because Vitest runs `environment: 'node'`. Pulling it out at
 * least makes it readable in one place rather than assembled out of four
 * `textContent` assignments.
 *
 * "1 SOLDIERS" IS THE ONE THING WORTH THE BRANCH. A level with a single landing
 * position is a real level to author, and a card that opened the last mission of
 * a wiped campaign with "WITH 1 SOLDIERS YOU MUST" would be the game's own copy
 * reading like a placeholder.
 */
export function missionLine(soldierCount: number): string {
  const men = soldierCount === 1 ? '1 SOLDIER' : `${String(soldierCount)} SOLDIERS`
  return `WITH ${men} YOU MUST`
}

/**
 * The reserve, in the original's words.
 *
 * SINGULAR MATTERS MORE HERE THAN ANYWHERE ELSE ON THE SCREEN, because "1
 * RECRUITS REMAINING" is the line a player reads at the exact moment the
 * campaign has come down to one man.
 */
export function reserveLine(recruitsRemaining: number): string {
  const men = recruitsRemaining === 1 ? '1 RECRUIT' : `${String(recruitsRemaining)} RECRUITS`
  return `${men} REMAINING`
}

/** A centred line of the card's body copy. */
function bodyLine(text: string, colour: string): HTMLElement {
  const row = document.createElement('p')
  row.textContent = text
  row.style.cssText = [
    'margin:0',
    `color:${colour}`,
    `font-family:${DISPLAY_FONT}`,
    'font-size:clamp(0.95rem, 2.4vw, 1.35rem)',
    'letter-spacing:0.08em',
  ].join(';')
  return row
}

export function createBriefing(mount: HTMLElement, options: BriefingOptions): BriefingScreen {
  const { model } = options

  // `createChrome` sets the role, the `aria-modal="false"` this screen used to
  // set by hand, and the label. It is also what puts the content in a COLUMN
  // rather than straight onto the backdrop — which is not cosmetic: the shared
  // backdrop carries `pointer-events:none` so a stray click is swallowed, and
  // that inherits, so the button appended directly to it could not be clicked at
  // all. This screen's own backdrop never had that rule, so the bug arrived with
  // the convergence and was caught by pressing the button.
  const { backdrop, panel } = createChrome('Mission briefing')

  // The display face, asked for on the way up rather than at boot: this is the
  // first screen that uses it, and nothing waits for it to arrive. See
  // `display-font.ts`.
  loadDisplayFont()

  /**
   * CENTRED, WHICH THE SHARED COLUMN IS NOT. `PANEL_STYLE` is a left-aligned
   * reading column — right for the Menu's notice and for Boot Hill's roll of the
   * dead, wrong for a card whose every line is centred on the mockup. Overridden
   * on the instance, as the Menu overrides it: the shared value stays what the
   * other screens are built from.
   */
  panel.style.alignItems = 'center'
  panel.style.textAlign = 'center'
  panel.style.gap = '2rem'
  // The chrome indents its column against the left edge of the window, which
  // pushes a centred card off centre. This screen owns the whole width.
  backdrop.style.alignItems = 'center'
  backdrop.style.padding = '2rem clamp(1rem, 6vw, 6rem)'

  /**
   * THE WHOLE SCREEN IS THE WAY IN (ticket 053).
   *
   * The shared backdrop carries `pointer-events:none` so that a click landing on
   * the bare black is swallowed rather than acted on — the right rule for the
   * Menu, where a stray press near a destructive button matters. This card has
   * ONE outcome and no way to get anything else: `ARCHITECTURE_DIAGRAM.md` gives
   * `Briefing` a single row out, `deploy`, so there is nothing here a click could
   * mean except "go". Turning input back on for this instance alone is what lets
   * the black around the card be the button too.
   *
   * THE CURSOR SAYS SO. A full-screen click target that still shows an arrow is
   * a screen the player waits on, hunting for the control he is already standing
   * on.
   */
  backdrop.style.pointerEvents = 'auto'
  backdrop.style.cursor = 'pointer'

  /**
   * MISSION n, UNDERLINED AND OUTSIDE THE BOX.
   *
   * The underline is a `border-bottom` on an inline-block rather than
   * `text-decoration`, because the mockup's rule runs the width of the words
   * with a little air under them; an underline sits on the baseline and cuts
   * through the descenders of a stencil face.
   */
  const heading = document.createElement('h1')
  heading.textContent = `MISSION ${String(model.levelNumber)}`
  heading.style.cssText = [
    'margin:0',
    'align-self:center',
    `color:${TEXT}`,
    `font-family:${DISPLAY_FONT}`,
    'font-size:clamp(1.6rem, 5vw, 2.75rem)',
    'letter-spacing:0.06em',
    'line-height:1.1',
    `border-bottom:2px solid ${TEXT}`,
    'padding-bottom:0.15em',
  ].join(';')

  /** The hairline box. Everything the player is being told is inside it. */
  const card = document.createElement('section')
  card.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:0.6rem',
    'width:min(46rem, 100%)',
    `border:1px solid ${RULE}`,
    'padding:clamp(1.25rem, 4vh, 2.25rem) clamp(1rem, 4vw, 3rem)',
  ].join(';')

  const cardHeading = document.createElement('h2')
  cardHeading.textContent = 'BRIEFING'
  cardHeading.style.cssText = [
    'margin:0',
    `color:${TEXT}`,
    `font-family:${DISPLAY_FONT}`,
    'font-size:clamp(1.35rem, 4vw, 2.1rem)',
    'letter-spacing:0.06em',
  ].join(';')

  const orders = document.createElement('div')
  orders.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:0.4rem'
  orders.append(bodyLine(missionLine(model.soldierCount), RULE))
  for (const type of model.objectives) {
    // THE HUD'S OWN WORDING, so the list the player reads here is the list he
    // reads in the corner of the screen thirty seconds later — upper-cased to
    // the card's voice, which is the only thing this screen does to it. See
    // `objectiveLabel`.
    orders.append(bodyLine(objectiveLabel(type).toUpperCase(), RULE))
  }

  /**
   * The gap the mockup leaves between the orders and the reserve.
   *
   * A SPACER AND NOT A MARGIN, because it is the only thing holding the box's
   * height up on a level with one objective: without it the card collapses
   * around three lines and stops reading as the same screen mission to mission.
   */
  const gap = document.createElement('div')
  gap.style.cssText = 'flex:1;min-height:clamp(1.5rem, 6vh, 3.5rem)'

  const reserve = bodyLine(reserveLine(model.recruitsRemaining), RULE)

  /**
   * GO FOR IT — the button, in the card's own voice.
   *
   * IT KEEPS `createButton`'S SHAPE AND LOSES ITS CHROME: the border and the
   * pill would be a second box inside the box the mockup already draws, where
   * the original simply sets the words larger and puts them last. What it must
   * keep is `type="button"` (a submit inside a form reloads the page, which on
   * this screen means losing the mission) and its focus behaviour, which is why
   * it is still built by the shared helper rather than by hand.
   */
  const deploy = createButton('GO FOR IT')
  deploy.style.alignSelf = 'center'
  deploy.style.margin = '0'
  deploy.style.padding = '0.1em 0.4em'
  deploy.style.border = 'none'
  deploy.style.background = 'transparent'
  deploy.style.color = TEXT
  deploy.style.fontFamily = DISPLAY_FONT
  deploy.style.fontSize = 'clamp(1.35rem, 4vw, 2.1rem)'
  deploy.style.letterSpacing = '0.06em'
  deploy.style.lineHeight = '1.1'

  card.append(cardHeading, orders, gap, reserve, deploy)
  panel.append(heading, card)
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

  /**
   * ONE LISTENER, ON THE BACKDROP, FOR EVERY WAY IN.
   *
   * The button's own click bubbles to here, and so does the one the browser
   * synthesises when a focused button is activated by Enter or Space — so the
   * keyboard route needs no listener of its own, and a click on GO FOR IT
   * deploys ONCE rather than being handled by a button listener and then again
   * on the way up. Two handlers with a `stopPropagation` between them would do
   * the same thing and leave the next reader working out which one fired.
   */
  backdrop.addEventListener('click', () => {
    // The same flag as the removal: `dispose` detaches the backdrop but does not
    // drop this listener, and a second deploy costs an entire Three.js scene —
    // which is exactly what the runner refuses, but a screen that fired twice
    // would be relying on it to.
    if (done) return
    // The screen is NOT torn down here. The router reconciles from
    // `runner.screen()` after the command, so a refused deploy leaves the card
    // up rather than leaving the player with no screen at all.
    options.onDeploy()
  })

  return { dispose }
}
