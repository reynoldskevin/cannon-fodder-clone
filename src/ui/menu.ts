/**
 * THE MENU (ticket 022b): the title, one button, and the only place a damaged
 * save is ever mentioned.
 *
 * DECIDES NOTHING. Where Start leads is `core/flow`'s answer (`Menu ->
 * Recruitment`), and whether there is anything to warn about is
 * `loadCampaign`'s — this file draws a string it is handed and calls back.
 * Vitest runs `environment: 'node'`, so nothing in `src/ui` is unit-tested at
 * all; anything decided here would be verified by looking at the screen and
 * nowhere else.
 *
 * THE NOTICE IS THE POINT OF THIS SCREEN AS MUCH AS THE BUTTON IS.
 * `runner.notice()` has existed since ticket 019 and has never been rendered: a
 * player whose save was damaged or could not be written has, until now, been
 * told by a `console.warn` he will never open. A campaign that silently starts
 * over is the exact failure `PersistencePort`'s `SaveResult` was shaped to
 * report.
 */

import { createButton, createChrome, createHeading, createNotice, setNotice, MUTED, BAD } from './screen-chrome'

export interface MenuOptions {
  /** Begin the campaign. The chart decides where that goes. */
  readonly onStart: () => void
  /**
   * The persistence notice, or `null` when the store is behaving.
   *
   * NOT OPTIONAL. `null` is a real answer the caller has to have looked up, and
   * an omittable field would let a caller that simply forgot to ask look
   * identical to a clean load.
   */
  readonly notice: string | null
}

export interface MenuScreen {
  /**
   * Take the screen down and stop the Start button firing. Safe to call twice,
   * and safe to call while a click is still reachable — both the removal and
   * `onStart` are behind one flag, so nothing runs a second time.
   */
  dispose(): void
}

export function createMenu(mount: HTMLElement, options: MenuOptions): MenuScreen {
  const { backdrop, panel } = createChrome('Main menu')

  const heading = createHeading('Game Week')

  const blurb = document.createElement('p')
  blurb.textContent = 'Pick your men, take the island, and count who comes back.'
  blurb.style.cssText = `margin:0;color:${MUTED}`

  // Warm rather than muted: a save that could not be written is the one line on
  // this screen the player must not skim past.
  const notice = createNotice(BAD)
  setNotice(notice, options.notice)

  const start = createButton('Start campaign')

  panel.append(heading, blurb, notice, start)
  mount.append(backdrop)
  // Focused, so the keyboard alone can start the game — and so the player's next
  // click does not go to the canvas underneath by accident.
  start.focus()

  let done = false
  const dispose = (): void => {
    // Guarded rather than merely idempotent-by-luck: `remove()` on a detached
    // node is harmless, but the flag is what lets a caller that disposes on both
    // "the player clicked" and "the screen changed" do so without thinking.
    if (done) return
    done = true
    backdrop.remove()
  }

  start.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — it does not drop this listener, and a detached button can
    // still be clicked by anything still holding a reference to it. See
    // `boot-hill.ts`, which pays for the same lesson.
    if (done) return
    // The callback goes first and the screen is NOT torn down here: the router
    // reconciles from `runner.screen()` after the command, and a screen that
    // removed itself before the command was accepted would leave a refused
    // Start with no menu and nothing to press.
    options.onStart()
  })

  return { dispose }
}
