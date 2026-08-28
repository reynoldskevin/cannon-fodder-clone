import type { Difficulty } from '../core/combat'
import type { MenuButton } from './menu-buttons'

/**
 * THE WAY INTO HARD MODE, AND BACK OUT (ticket 095).
 *
 * Ticket 093 put hard mode behind `?hard=1` and nothing in the game mentions it,
 * so the only way to find it is to be told. This is the telling: a text link
 * under the menu's button.
 *
 * A FUNCTION AND NOT A DECISION INSIDE `menu.ts`, for the reason
 * `menu-buttons.ts` records at length — the menu's rules "have now been wrong
 * twice in a file nothing can import", because `menu.ts` builds `div`s and the
 * test runner has no DOM. A label and a target chosen inline would be verified by
 * opening the screen and reading it, which is how both of those got in.
 */

/** What the menu draws, or `null` when it draws nothing. */
export interface DifficultyLink {
  /** The words. */
  readonly label: string
  /** Where it points. Consumed as an `href`, so it is a URL and not a command. */
  readonly href: string
}

/**
 * The link to offer beneath `buttons`, or `null`.
 *
 * ASKED OF THE BUTTONS RATHER THAN OF THE CAMPAIGN, and that is the whole shape
 * of this function. `menuButtons` offers exactly one button in two cases — a
 * fresh campaign and a finished one — and two while a campaign is underway.
 * Both single-button screens are a player about to BEGIN a run, which is the
 * only coherent moment to change difficulty; the two-button screen is a run
 * already carrying its dead, where flipping it would change the game under a
 * squad half-way through.
 *
 * `!campaignUnderway` PICKS OUT THE SAME SCREENS TODAY and would be the obvious
 * way to write this. It is a second spelling of a decision `menu-buttons.ts`
 * already owns, and the two would part company the first time a button is added
 * to either one-button screen — leaving the link sitting beside two buttons with
 * nothing able to say why.
 */
export function difficultyLink(
  buttons: readonly MenuButton[],
  difficulty: Difficulty,
): DifficultyLink | null {
  if (buttons.length !== 1) return null
  return difficulty === 'hard'
    ? {
        /**
         * "EASY", NOT "NORMAL", AND THIS IS THE ONE PLACE THE TWO VOCABULARIES
         * MEET. The engine's default difficulty is `normal` and calling it easy
         * in `weapons.ts` would misdescribe the shipped game — but a player
         * looking for the way OUT of hard mode wants the word he would use, and
         * "Switch to NORMAL mode" reads like a settings screen rather than a
         * relief.
         */
        label: 'Switch to EASY mode',
        /**
         * HOME, WHICH DROPS EVERY OTHER PARAMETER. A player who arrived on
         * `?hard=1&debug=1` loses the debug overlay too. That is the right
         * default — a "leave hard mode" link that silently preserved half the
         * address bar would be harder to reason about than one that goes home —
         * but it is a real consequence rather than an oversight.
         */
        href: '/',
      }
    : {
        label: 'Switch to HARD mode',
        /**
         * EXACTLY WHAT `difficultyFromSearch` ACCEPTS, which is strict: it tests
         * `=== '1'`, so `?hard=true` and a bare `?hard` both mean normal. A link
         * pointing at either would look right, navigate, and leave the player on
         * the easy game with nothing anywhere reporting a fault.
         */
        href: '?hard=1',
      }
}
