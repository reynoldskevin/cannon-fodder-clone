/**
 * THE BRIEFING (ticket 022b): the level, the objectives, and who is going.
 *
 * DRAWS `BriefingModel` AND DECIDES NOTHING. The level's name, its objectives in
 * the author's own order, and the squad are all settled in
 * `core/flow/screens.ts`; this file is a loop over three lists.
 *
 * THE SQUAD IS PRINTED IN ASSIGNMENT ORDER AND IS NEVER SORTED. The nth man
 * stands on the nth avatar spawn (ticket 021), so the order on this screen is
 * the only place the player is ever told which of his men is on which flank.
 * Sorting it by rank or by name would make the briefing disagree with the map
 * the moment the mission started, and nothing anywhere would report it.
 *
 * THERE IS NO WAY BACK, AND THAT IS THE CHART'S DOING RATHER THAN THIS FILE'S.
 * `ARCHITECTURE_DIAGRAM.md` has no `Briefing -> Recruitment` row, so a player who
 * opens the Briefing cannot change his squad. A back button here would need a
 * transition that does not exist; adding one is a change to the chart and to the
 * document it is checked against, not to a screen.
 */

import {
  createButton,
  createChrome,
  createHeading,
  LIST_STYLE,
  MUTED,
} from './screen-chrome'
import { objectiveLabel } from './hud'
import type { BriefingModel, FlowSoldier } from '../core/flow'

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
 * One man on the manifest, numbered by his landing position.
 *
 * THE NUMBER IS THE SPAWN INDEX, 1-based for reading. A pure string function for
 * the reason `graveLine` is one: the wording is the only part of a screen that
 * can be checked by anything but an eye.
 */
export function manifestLine(position: number, man: FlowSoldier): string {
  return `${String(position)}. ${man.rank} ${man.name}`
}

export function createBriefing(mount: HTMLElement, options: BriefingOptions): BriefingScreen {
  const { model } = options
  const { backdrop, panel } = createChrome('Mission briefing')

  const heading = createHeading('Briefing')

  const levelName = document.createElement('p')
  levelName.textContent = model.levelName
  levelName.style.cssText = 'margin:0;font-size:1.1rem'

  const objectivesHeading = document.createElement('h2')
  objectivesHeading.textContent = 'Objectives'
  objectivesHeading.style.cssText =
    `margin:0;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`

  const objectives = document.createElement('ul')
  objectives.style.cssText = LIST_STYLE
  for (const type of model.objectives) {
    const row = document.createElement('li')
    // THE HUD'S OWN WORDING, so the list the player reads here is the list he
    // reads in the corner of the screen thirty seconds later. See `objectiveLabel`.
    row.textContent = `○ ${objectiveLabel(type)}`
    objectives.append(row)
  }

  const squadHeading = document.createElement('h2')
  squadHeading.textContent = 'Landing party'
  squadHeading.style.cssText =
    `margin:0;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`

  const squad = document.createElement('ul')
  squad.style.cssText = `${LIST_STYLE};overflow-y:auto;min-height:0`
  model.squad.forEach((man, index) => {
    const row = document.createElement('li')
    row.textContent = manifestLine(index + 1, man)
    squad.append(row)
  })

  const deploy = createButton('Deploy')

  panel.append(heading, levelName, objectivesHeading, objectives, squadHeading, squad, deploy)
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
    // `runner.screen()` after the command, so a refused Deploy leaves the
    // Briefing up rather than leaving the player with no screen at all.
    options.onDeploy()
  })

  return { dispose }
}
