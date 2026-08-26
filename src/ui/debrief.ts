/**
 * THE DEBRIEF (ticket 022b): what the mission cost, by name.
 *
 * IT REPLACES `mission-end.ts`, which ticket 013 wrote and this ticket deletes.
 * The old screen knew the outcome and the clock and nothing about who died —
 * which was everything there was to know before there was a campaign, and is now
 * the smaller half of it. Two end-of-mission screens with two ideas of what
 * happened is one more than the game can have.
 *
 * DRAWS `DebriefModel` AND DECIDES NOTHING. Who is a casualty and who is a
 * survivor, and how many kills the squad is credited with, are folded in
 * `core/flow/screens.ts` from the SAME `MissionReport` that updates the roster —
 * which is what stops this screen listing a man among the survivors while his
 * gravestone is being carved.
 *
 * THE OUTCOME REACHES IT FROM THE LATCHED `session.outcome()`, VIA THE REPORT.
 * `main.ts` watches `outcome()` rather than catching a `MissionComplete` event
 * on the right frame: a frame that ran eight steps drains them all at once and a
 * frame that ran none drains nothing, so an end screen driven by catching the
 * event is one that occasionally never appears. That property is `main.ts`'s to
 * keep; it is stated here because this screen is what it protects.
 *
 * IT DOES NOT COVER THE WHOLE SCREEN CHEAPLY. Like every campaign screen it is a
 * panel over a dimmed canvas, and the sim keeps stepping behind it — the death
 * animation of the man who won the mission is still playing.
 */

import {
  createButton,
  createChrome,
  createHeading,
  createNotice,
  setNotice,
  BAD,
  GOOD,
  LIST_STYLE,
  MUTED,
} from './screen-chrome'
import type { DebriefModel, FlowSoldier } from '../core/flow'
import type { MissionOutcome } from '../core/campaign'

export interface DebriefOptions {
  readonly model: DebriefModel
  /**
   * Why the mission was lost, from `MissionFailed.reason`.
   *
   * Optional because a won mission has none. It is the sim's own sentence and is
   * printed verbatim: the alternative is the player being told he failed with no
   * word on what he failed at.
   */
  readonly reason?: string
  /** On to Boot Hill. The chart decides where that goes. */
  readonly onContinue: () => void
}

export interface DebriefScreen {
  /** Take the screen down and stop the Continue button firing. Safe to call twice. */
  dispose(): void
}

/** Which of the two endings this was, in words. Mirrors `MissionOutcome` exactly. */
export function outcomeTitle(outcome: MissionOutcome): string {
  return outcome === 'complete' ? 'Mission complete' : 'Mission failed'
}

/** The squad's total, as a line. A pure string function, like `graveLine`. */
export function killsLine(kills: number): string {
  return kills === 1 ? '1 enemy killed.' : `${String(kills)} enemies killed.`
}

/** One man, named and ranked. The rank is the one he held when he deployed. */
export function soldierLine(man: FlowSoldier): string {
  return `${man.rank} ${man.name}`
}

export function createDebrief(mount: HTMLElement, options: DebriefOptions): DebriefScreen {
  const { model } = options
  const won = model.outcome === 'complete'
  const accent = won ? GOOD : BAD
  const { backdrop, panel } = createChrome('Mission debrief')

  const heading = createHeading(outcomeTitle(model.outcome))
  heading.style.color = accent

  // Printed whether or not the mission was won: a squad that lost still shot
  // back, and those kills are on the roster either way.
  const kills = document.createElement('p')
  kills.textContent = killsLine(model.kills)
  kills.style.cssText = `margin:0;color:${MUTED}`

  // Warm, and hidden when there is nothing to say — see `createNotice`. A won
  // mission carries no reason, and a blank line where the loss is explained
  // would invite the player to wonder what it said.
  const reason = createNotice(BAD)
  setNotice(reason, options.reason ?? null)

  const casualtiesHeading = document.createElement('h2')
  casualtiesHeading.textContent = 'Casualties'
  casualtiesHeading.style.cssText =
    `margin:0;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`

  const casualties = document.createElement('ul')
  casualties.style.cssText = LIST_STYLE
  if (model.casualties.length === 0) {
    const row = document.createElement('li')
    // SAID RATHER THAN LEFT BLANK. An empty list under a heading reads as a
    // screen that failed to load its own content, and "nobody died" is the best
    // news this screen can carry.
    row.textContent = 'Every man came back.'
    row.style.color = MUTED
    casualties.append(row)
  }
  for (const man of model.casualties) {
    const row = document.createElement('li')
    // The same cross Boot Hill carves, so the man the Debrief names is
    // recognisable as the man on the next screen's stone.
    row.textContent = `✚ ${soldierLine(man)}`
    row.style.color = BAD
    row.style.fontWeight = '600'
    casualties.append(row)
  }

  const survivorsHeading = document.createElement('h2')
  survivorsHeading.textContent = 'Returned'
  survivorsHeading.style.cssText =
    `margin:0;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`

  const survivors = document.createElement('ul')
  survivors.style.cssText = `${LIST_STYLE};overflow-y:auto;min-height:0`
  for (const man of model.survivors) {
    const row = document.createElement('li')
    row.textContent = `· ${soldierLine(man)}`
    survivors.append(row)
  }
  if (model.survivors.length === 0) {
    const row = document.createElement('li')
    row.textContent = 'The squad was wiped out.'
    row.style.color = MUTED
    survivors.append(row)
  }

  const carryOn = createButton('Continue')

  panel.append(
    heading,
    kills,
    reason,
    casualtiesHeading,
    casualties,
    survivorsHeading,
    survivors,
    carryOn,
  )
  mount.append(backdrop)
  // Focused, so the keyboard alone can leave the Debrief — and so the player's
  // next click does not go to the canvas underneath by accident.
  carryOn.focus()

  let done = false
  const dispose = (): void => {
    if (done) return
    done = true
    backdrop.remove()
  }

  carryOn.addEventListener('click', () => {
    // The same flag as the removal: a detached button can still be clicked by
    // anything holding a reference to it, and a second `casualtiesRecorded`
    // would walk the flow past Boot Hill without the player seeing it.
    if (done) return
    // The screen is NOT torn down here; the router reconciles from
    // `runner.screen()` after the command. See `menu.ts`.
    options.onContinue()
  })

  return { dispose }
}
