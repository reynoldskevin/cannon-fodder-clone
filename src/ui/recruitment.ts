/**
 * RECRUITMENT (ticket 022b): the roster, and the button that says what it will
 * actually do.
 *
 * DRAWS `RecruitmentModel` AND DECIDES NOTHING. Who may be selected, whether a
 * short selection is completed or refused, and what a refusal says are all
 * answered in `core/campaign/selection.ts`, where Vitest can see them under
 * Node. There is deliberately no `if` in the click handlers below: the screen
 * lets the player pick any men in any number and hands the ids to `selectSquad`,
 * which is the one place that rule is written down.
 *
 * THE ORDER OF SELECTION IS KEPT, and it is not cosmetic: the nth man chosen
 * stands on the nth avatar spawn (ticket 021), so a screen that sorted the
 * selection — or stored it in a `Set` and read it back in roster order — would
 * silently move the player's veteran off the flank he was placed on.
 *
 * THE DEPLOY BUTTON PRINTS `autoFilled`, WHICH IS THE WHOLE REASON THAT FIELD
 * EXISTS. `selectSquad` silently completes a short selection when the living
 * roster is no bigger than the squad, so the same click on the same button means
 * "refused" or "deploys three men you did not pick" depending on a quantity the
 * screen never showed. THE MODEL IS RE-READ ON EVERY TOGGLE for exactly that
 * reason: a label computed once at mount would go stale on the first click and
 * promise something the button no longer does.
 */

import {
  createButton,
  createChrome,
  createHeading,
  createNotice,
  setNotice,
  setText,
  BAD,
  GOOD,
  LIST_STYLE,
  MUTED,
  TEXT,
} from './screen-chrome'
import type { RecruitmentEntry, RecruitmentModel } from '../core/campaign'

export interface RecruitmentOptions {
  /**
   * The model for a given selection, asked afresh on every toggle.
   *
   * A FUNCTION AND NOT A VALUE, because `autoFilled` is a property of the
   * selection rather than of the roster — see the header. The runner answers
   * this straight out of `recruitmentModel`.
   */
  readonly modelFor: (chosen: readonly string[]) => RecruitmentModel
  /**
   * Deploy with these men, in this order.
   *
   * Returns the refusal to put in front of the player, or `null` when the
   * command was accepted. A refusal that came back as `false` or as silence
   * would be the dead button `selectSquad`'s reason strings exist to prevent.
   */
  readonly onDeploy: (chosen: readonly string[]) => string | null
}

export interface RecruitmentScreen {
  /** Take the screen down and stop its buttons firing. Safe to call twice. */
  dispose(): void
}

/** Selected, and not. Printed characters for the reason `boot-hill.ts` gives. */
const MARK_ON = '✔'
const MARK_OFF = '·'

/**
 * One man as the roster lists him: who he is and what he has done.
 *
 * A PURE STRING FUNCTION, like `graveLine`, so the wording is one expression
 * rather than four appends — and so the only thing the row element does is hold
 * it.
 */
export function recruitLine(entry: RecruitmentEntry): string {
  const missions = entry.missionsSurvived === 1 ? '1 mission' : `${String(entry.missionsSurvived)} missions`
  const kills = entry.kills === 1 ? '1 kill' : `${String(entry.kills)} kills`
  return `${entry.rank} ${entry.name} — ${missions}, ${kills}`
}

/**
 * What the Deploy button says.
 *
 * THE COUNT IS PRINTED ONLY WHEN THERE IS ONE. `autoFilled` is 0 both when the
 * player picked a full squad and when a short pick is about to be REFUSED (see
 * `autoFilledFor`), and "Deploy (0 auto-assigned)" would be a reassurance in the
 * second case rather than the refusal that is coming.
 */
export function deployLabel(autoFilled: number): string {
  if (autoFilled <= 0) return 'Deploy'
  return autoFilled === 1 ? 'Deploy (1 auto-assigned)' : `Deploy (${String(autoFilled)} auto-assigned)`
}

/** How much of the squad the player has picked himself. */
export function squadCountLine(chosen: number, maxSquad: number): string {
  return `${String(chosen)} of ${String(maxSquad)} landing positions filled.`
}

export function createRecruitment(
  mount: HTMLElement,
  options: RecruitmentOptions,
): RecruitmentScreen {
  const { backdrop, panel } = createChrome('Recruitment')

  const heading = createHeading('Recruitment')

  const summary = document.createElement('p')
  summary.style.cssText = `margin:0;color:${MUTED}`

  /**
   * The roster. Scrolls on its own rather than growing the panel past the
   * viewport: `MAX_ROSTER` is 64 and a long campaign approaches it, and a
   * Recruitment screen whose Deploy button had been pushed off the bottom would
   * strand the player on it — the same failure Boot Hill's list guards against.
   */
  const list = document.createElement('ul')
  list.style.cssText = `${LIST_STYLE};overflow-y:auto;min-height:0`

  const notice = createNotice(BAD)

  const deploy = createButton(deployLabel(0))

  panel.append(heading, summary, list, notice, deploy)
  mount.append(backdrop)

  let done = false
  const dispose = (): void => {
    if (done) return
    done = true
    backdrop.remove()
  }

  /**
   * The player's picks, in the order he made them. See the header: this order is
   * the spawn assignment, so it is an array and never a `Set`.
   */
  const chosen: string[] = []

  /**
   * The rows, built ONCE from the opening model and reused.
   *
   * The living roster cannot change while this screen is up: the only thing that
   * would add a man is auto-fill recruiting, and `recruitmentModel` throws away
   * the state that would do — nothing is issued against the campaign until the
   * player really deploys. So a toggle changes marks and labels, never rows.
   */
  const rows = new Map<string, HTMLElement>()

  function render(model: RecruitmentModel): void {
    setText(summary, squadCountLine(chosen.length, model.maxSquad))
    setText(deploy, deployLabel(model.autoFilled))
    for (const entry of model.available) {
      const row = rows.get(entry.id)
      if (row === undefined) continue
      const on = chosen.includes(entry.id)
      setText(row, `${on ? MARK_ON : MARK_OFF} ${recruitLine(entry)}`)
      const state = on ? 'on' : 'off'
      if (row.dataset.state !== state) {
        row.dataset.state = state
        // A PRINTED MARKER FIRST, colour second: which men are picked must
        // survive a colour-blind player and a washed-out screen, the same
        // bargain Boot Hill's stones and the HUD's roster pips make.
        row.style.color = on ? GOOD : TEXT
        row.style.fontWeight = on ? '600' : '400'
      }
    }
  }

  function toggle(id: string): void {
    if (done) return
    const at = chosen.indexOf(id)
    if (at === -1) chosen.push(id)
    else chosen.splice(at, 1)
    // The selection changed, so the answer to "what would deploying do" changed
    // with it. Asked again rather than adjusted, for the reason in the header.
    render(options.modelFor(chosen))
    // A stale refusal under a selection the player has since changed reads as a
    // button that is still refusing. He gets the next one when he clicks again.
    setNotice(notice, null)
  }

  const opening = options.modelFor(chosen)
  for (const entry of opening.available) {
    const row = document.createElement('li')
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.style.cssText = 'cursor:pointer;padding:0.1rem 0'
    row.addEventListener('click', () => {
      toggle(entry.id)
    })
    // The keyboard half of the same control: a row that only a mouse can reach
    // is a squad only a mouse can pick.
    row.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle(entry.id)
    })
    rows.set(entry.id, row)
    list.append(row)
  }
  render(opening)

  deploy.addEventListener('click', () => {
    if (done) return
    // A COPY: `chosen` keeps mutating under the caller as the player clicks, and
    // the runner holds the squad it is given for the length of the mission.
    const reason = options.onDeploy([...chosen])
    // The command was accepted and the router has already taken this screen
    // down; writing into a detached panel would be harmless but pointless, and
    // the flag is the honest way to say the screen is over.
    if (done) return
    setNotice(notice, reason)
  })

  // Focused, so the keyboard alone can walk the roster — and so the player's
  // next click does not go to the canvas underneath by accident.
  deploy.focus()

  return { dispose }
}
