/**
 * WHICH BUTTONS THE MENU OFFERS (ticket 077), as a table.
 *
 * THE RULE HAS NOW BEEN WRONG TWICE IN A FILE NOTHING CAN IMPORT. `menu.ts`
 * builds `div`s on its first lines and Vitest runs `environment: 'node'`, so
 * everything it decided inline was verified by opening the screen and pressing
 * things. What it decided, on a finished campaign, was to offer "Play again
 * (keeps Boot Hill)" — which issues `startCampaign` and walks Menu -> Controls
 * -> BootHill, where `advanceFromBootHill` finds the campaign complete, fires
 * `campaignComplete` and returns to the Menu. Three clicks back to the screen it
 * was pressed on, with nothing failing anywhere.
 *
 * SO THE ANSWER IS DATA. `menuButtons` says what is offered, what it says and
 * whether it needs confirming; `menu.ts` draws that and wires each `action` to
 * the command of the same name. A button with no matching arm is a compile
 * error rather than a dead control.
 */

/** What the Menu needs to know to decide. All of it comes from `core`. */
export interface MenuButtonModel {
  /** Has every published level been beaten? */
  readonly campaignOver: boolean
  /** Is the player coming back to a campaign rather than beginning one? */
  readonly campaignUnderway: boolean
  /** How many stones a reset would erase. */
  readonly graves: number
}

/**
 * Which command a button issues.
 *
 * A CLOSED UNION, so `menu.ts`'s switch over it is checked by the compiler. The
 * two are genuinely different commands and not two labels for one: `start`
 * replays a campaign keeping every gravestone, `reset` throws it away — the
 * distinction ticket 024 built two verbs for.
 */
export type MenuAction = 'start' | 'reset'

export interface MenuButton {
  readonly action: MenuAction
  readonly label: string
  /**
   * Must it be pressed twice?
   *
   * ONLY WHERE IT GUARDS SOMETHING. A confirmation on the memorial's single
   * button protects a campaign that is already over from a player who has
   * nothing else to press — friction in front of the only thing to do. On a
   * LIVE campaign the same button destroys a hill full of stones sitting beside
   * the button the player actually wants, which is what ticket 024 built it for.
   */
  readonly confirms: boolean
}

/** How the wipe describes what it would cost. */
const resetLabel = (graves: number): string =>
  graves === 0 ? 'Start over' : `Start over (erases ${String(graves)} graves)`

export function menuButtons(model: MenuButtonModel): readonly MenuButton[] {
  /**
   * FINISHED IS CHECKED FIRST, because a finished campaign is also an underway
   * one — and the underway arm below is what used to catch it, which is how the
   * loop got there.
   *
   * ONE BUTTON, AND IT RESETS. `start` from here cannot reach a mission: the
   * chart's only exit from a completed Boot Hill is back to this screen. Offering
   * it would be offering the loop again under a better label.
   */
  if (model.campaignOver) {
    return [{ action: 'reset', label: 'Play again', confirms: false }]
  }
  if (model.campaignUnderway) {
    return [
      { action: 'start', label: 'Continue campaign', confirms: false },
      { action: 'reset', label: resetLabel(model.graves), confirms: true },
    ]
  }
  // A FRESH CAMPAIGN IS OFFERED NOTHING TO DESTROY (ticket 050). A greyed-out
  // wipe still tells a first-time player that this screen can destroy something
  // of his, which is a question he does not have yet.
  return [{ action: 'start', label: 'Start campaign', confirms: false }]
}
