/**
 * THE MENU (ticket 022b): the title, one button, and the only place a damaged
 * save is ever mentioned.
 *
 * SINCE TICKET 024 IT IS ALSO THE END OF THE CAMPAIGN. `BootHill -> Menu` on
 * `campaignComplete` is a row the chart has always had, so a finished campaign
 * has always landed here — it just arrived with nothing to say. Now it arrives
 * with the totals, and with the only button in the game that can throw a
 * campaign away. NO NEW SCREEN AND NO NEW ROW: a seventh screen for a state the
 * chart can already express would mean a row in `TRANSITIONS` that
 * `diagram.test.ts` checks against `ARCHITECTURE_DIAGRAM.md` in both directions.
 *
 * DECIDES NOTHING. Where Start leads is `core/flow`'s answer (`Menu ->
 * Recruitment`), whether there is anything to warn about is `loadCampaign`'s,
 * whether the campaign is over is `campaignComplete`'s, and the totals are
 * `campaignSummary`'s — this file draws values it is handed and calls back.
 * Vitest runs `environment: 'node'`, so nothing in `src/ui` is unit-tested at
 * all; anything decided here would be verified by looking at the screen and
 * nowhere else.
 *
 * THE NOTICE IS THE POINT OF THIS SCREEN AS MUCH AS THE BUTTON IS.
 * `runner.notice()` has existed since ticket 019 and has never been rendered: a
 * player whose save was damaged or could not be written is otherwise told by a
 * `console.warn` he will never open.
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
} from './screen-chrome'
import type { CampaignSummary } from '../core/campaign'

/** Everything the Menu draws. All of it comes from `core`. */
export interface MenuModel {
  /**
   * The persistence notice, or `null` when the store is behaving.
   *
   * NOT OPTIONAL. `null` is a real answer the caller has to have looked up, and
   * an omittable field would let a caller that simply forgot to ask look
   * identical to a clean load.
   */
  readonly notice: string | null
  /** The campaign's totals. Always supplied — a campaign in progress has them too. */
  readonly summary: CampaignSummary
  /**
   * Has every published level been beaten?
   *
   * HANDED IN, NOT INFERRED FROM `summary`. "Levels completed equals the number
   * of levels" would be a second spelling of `campaignComplete`, in the one
   * layer that cannot be tested, and `>` versus `>=` there is exactly the
   * off-by-one ticket 020 measured.
   */
  readonly campaignOver: boolean
}

export interface MenuOptions extends MenuModel {
  /** Begin the campaign. The chart decides where that goes. */
  readonly onStart: () => void
  /**
   * Throw the campaign away and start a new one.
   *
   * ONLY EVER CALLED ON THE SECOND PRESS. See `armRestart`.
   */
  readonly onRestart: () => void
}

export interface MenuScreen {
  /**
   * Redraw from a new model.
   *
   * NEEDED BECAUSE A RESTART DOES NOT CHANGE THE SCREEN. The router only
   * rebuilds a panel when `viewFor(runner.screen())` changes, and a wipe leaves
   * the player on the Menu — so without this the screen would go on showing the
   * totals and the graves of the campaign it has just erased.
   */
  update(model: MenuModel): void
  /**
   * Take the screen down and stop the buttons firing. Safe to call twice, and
   * safe to call while a click is still reachable — the removal and both
   * callbacks are behind one flag, so nothing runs a second time.
   */
  dispose(): void
}

/**
 * How long the restart button stays armed, in milliseconds.
 *
 * IT DISARMS ITSELF because the second press is a confirmation, and a
 * confirmation that waits indefinitely is not one: a button left armed while the
 * player went to make tea is a single click away from deleting his campaign, and
 * he will not remember that he half-pressed it.
 */
const RESTART_ARMED_MS = 6000

export function createMenu(mount: HTMLElement, options: MenuOptions): MenuScreen {
  const { backdrop, panel } = createChrome('Main menu')

  /**
   * THE GAME'S NAME, NOT THE REPOSITORY'S (ticket 040). The start screen is the
   * first thing anybody sees and it read `Game Week` — the name of the build
   * exercise, which means nothing to a player.
   */
  const heading = createHeading('Cannon Fodder')

  const blurb = document.createElement('p')
  blurb.style.cssText = `margin:0;color:${MUTED}`

  // Warm rather than muted: a save that could not be written is the one line on
  // this screen the player must not skim past.
  const notice = createNotice(BAD)

  /**
   * The campaign's totals, shown only when it is over.
   *
   * Its own container so "show the summary" is one `display` change rather than
   * a rebuild — and so a redraw after a restart cannot leave half of the last
   * campaign's numbers on screen beside half of the new one's.
   */
  const summary = document.createElement('section')
  summary.style.cssText = 'display:none;flex-direction:column;gap:0.5rem'

  const summaryHeading = document.createElement('h2')
  summaryHeading.textContent = 'Campaign complete'
  summaryHeading.style.cssText =
    `margin:0;font-size:1rem;letter-spacing:0.06em;text-transform:uppercase;color:${GOOD}`

  const totals = document.createElement('p')
  totals.style.cssText = 'margin:0'

  const rollHeading = document.createElement('p')
  rollHeading.textContent = 'The fallen'
  rollHeading.style.cssText = `margin:0;color:${MUTED}`

  const roll = document.createElement('ul')
  roll.style.cssText = `${LIST_STYLE};overflow:auto`

  summary.append(summaryHeading, totals, rollHeading, roll)

  const start = createButton('Start campaign')

  /**
   * The wipe, behind two presses.
   *
   * TWO PRESSES AND NOT ONE, because this is the only control in the game that
   * destroys anything: `startCampaign` is a replay that keeps every gravestone,
   * and `restartCampaign` deletes Boot Hill — the one screen the campaign exists
   * to fill. A player who meant "play again" must not reach "erase twelve
   * gravestones" by pressing the same button, and the second press is what makes
   * the difference deliberate. It is DOM, so nothing tests it; what IS tested,
   * in `core/flow`, is that no other command the runner has ever clears the save.
   */
  const restart = createButton('')
  restart.style.borderColor = 'rgba(255,143,107,0.55)'
  restart.style.color = BAD

  panel.append(heading, blurb, notice, summary, start, restart)
  mount.append(backdrop)
  // Focused, so the keyboard alone can start the game — and so the player's next
  // click does not go to the canvas underneath by accident. Start, never
  // restart: a focused destructive button is one stray Enter from a wipe.
  start.focus()

  let done = false
  /** Whether the next press of `restart` actually restarts. */
  let armed = false
  let armedTimer: ReturnType<typeof setTimeout> | undefined
  let model: MenuModel = options

  const restartLabel = (): string => {
    const graves = model.summary.casualties
    if (!armed) return graves === 0 ? 'Start over' : `Start over (erases ${String(graves)} graves)`
    return graves === 0
      ? 'Press again to erase this campaign'
      : `Press again to erase ${String(graves)} graves`
  }

  const disarm = (): void => {
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = undefined
    armed = false
    setText(restart, restartLabel())
    restart.style.background = 'transparent'
  }

  const armRestart = (): void => {
    armed = true
    setText(restart, restartLabel())
    // Visibly different as well as differently worded: the label change alone is
    // easy to press through, and this button is not one to press through.
    restart.style.background = 'rgba(255,143,107,0.18)'
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = setTimeout(disarm, RESTART_ARMED_MS)
  }

  const render = (next: MenuModel): void => {
    model = next
    setNotice(notice, next.notice)
    setText(
      blurb,
      next.campaignOver
        ? 'The island is taken. Start over, and none of them come back.'
        : 'Pick your men, take the island, and count who comes back.',
    )
    // The Start button reads differently once the campaign is over: it is the
    // same command and the same replay, but "Start campaign" over a finished one
    // reads like a wipe — which is the very thing it is not.
    setText(start, next.campaignOver ? 'Play again (keeps Boot Hill)' : 'Start campaign')

    summary.style.display = next.campaignOver ? 'flex' : 'none'
    if (next.campaignOver) {
      setText(
        totals,
        `${String(next.summary.levelsCompleted)} levels taken · ` +
          `${String(next.summary.casualties)} killed · ${String(next.summary.kills)} enemy dead`,
      )
      // Rebuilt rather than diffed: the roll changes only when the campaign
      // does, which is once a campaign, and a list this short is not worth a
      // reconciler nothing tests.
      roll.replaceChildren()
      rollHeading.style.display = next.summary.fallen.length === 0 ? 'none' : 'block'
      for (const grave of next.summary.fallen) {
        const row = document.createElement('li')
        row.textContent =
          `${grave.rankAtDeath} ${grave.name} — level ${String(grave.diedOnLevel)}, ` +
          `${String(grave.kills)} killed`
        row.style.cssText = `color:${MUTED}`
        roll.append(row)
      }
    }
    // A model change can only make an armed button MORE dangerous than the
    // player agreed to, so the arming does not survive one.
    disarm()
  }

  render(options)

  const dispose = (): void => {
    // Guarded rather than merely idempotent-by-luck: `remove()` on a detached
    // node is harmless, but the flag is what lets a caller that disposes on both
    // "the player clicked" and "the screen changed" do so without thinking.
    if (done) return
    done = true
    // Before the removal: a timer left running on a detached screen would fire
    // into elements nothing can see, and on a page that may already be gone.
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = undefined
    backdrop.remove()
  }

  start.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — it does not drop this listener, and a detached button can
    // still be clicked by anything still holding a reference to it. See
    // `boot-hill.ts`, which pays for the same lesson.
    if (done) return
    // A stray press on Start must not leave the wipe armed behind it.
    disarm()
    // The callback goes first and the screen is NOT torn down here: the router
    // reconciles from `runner.screen()` after the command, and a screen that
    // removed itself before the command was accepted would leave a refused
    // Start with no menu and nothing to press.
    options.onStart()
  })

  restart.addEventListener('click', () => {
    if (done) return
    if (!armed) {
      armRestart()
      return
    }
    disarm()
    options.onRestart()
  })

  return { update: render, dispose }
}
