/**
 * THE ROLL OF THE MEN, DOWN THE LEFT OF THE LEVEL (ticket 065).
 *
 * The HUD already says `Squad 4/6` and draws six pips, which is how MANY are
 * standing and never WHO. The player has just spent a Briefing screen picking
 * these men out by name, so the mission he then plays should be able to tell him
 * which of them is which. This is that list: one row per man, in the same column
 * width Boot Hill gives its own roster — see `roster-column.ts` for why that
 * number is shared rather than copied.
 *
 * LAID OUT THE OTHER WAY ROUND FROM BOOT HILL'S ROWS. There the name is left and
 * a tally is right, because the memorial is a scoreboard. Here there is no
 * second column to balance against, so the name is CENTRED and the man's badge
 * is repeated on BOTH sides of it — REPEATED, not mirrored-and-different: two
 * badges showing two ranks would read as two facts about one man, and the second
 * one would be wrong.
 *
 * THE MODULE BODY TOUCHES NO DOM, and that is the whole reason the decisions in
 * it are checkable. Vitest runs `environment: 'node'` with no jsdom, so nothing
 * in `src/ui` that reaches for `document` at import time can be loaded by a test
 * at all. The styles are string constants and the row's shape is a pure
 * function, so both are importable; the `createElement` calls stay inside
 * `createSquadPanel`, where nothing can reach them. Same split `rank-insignia.ts`,
 * `screen-chrome.ts` and `mission-banner.ts` already run on.
 *
 * A NAME ON THIS RAIL MEANS "THIS MAN IS STILL WITH YOU" (ticket 066). It was
 * fed once, from `startMission`, and therefore listed everyone who LANDED for as
 * long as the mission ran — including the men lying face down in the grass. It
 * is now driven from the frame loop and draws `rollCall(model.squad)`: the dead
 * man's row goes and the rail closes up behind him. Dropped rather than greyed,
 * because a struck-through row is the panel still claiming him and hedging about
 * it, and because ticket 064 took the two-tone roster off Boot Hill on the same
 * argument.
 *
 * UNDER THE ROLL, THE TWO THINGS YOU CAN THROW (ticket 067). The grenade and the
 * rocket were armed by pressing `2` and `3` and by nothing else. They are now
 * also a pair of painted buttons at the foot of the rail, built from
 * `ORDNANCE_ICONS` — which is where "which weapons, in what order, on which
 * digit" is decided and tested. A second list hand-written here would be a
 * second answer to all three, and the tested one would not be the one on screen.
 *
 * AND HOW MANY OF EACH ARE LEFT (ticket 069). The icons said what could be
 * thrown and never how much of it remained — that number was in the HUD's
 * selector, on the far side of the screen from the button the player is aiming
 * at. Each icon now carries its own count in the corner, read from the armoury
 * every frame so it cannot disagree with the selector about one pouch.
 *
 * THE PANEL REPORTS THE WEAPON AND DECIDES NOTHING. It does not touch the
 * command queue and does not know what arming means; it says which ordnance was
 * asked for and `app/main.ts` does with that exactly what it does with a digit.
 * That is what makes "clicking arms it the way pressing 2 does" true by
 * construction rather than by two call sites that happen to agree today.
 *
 * DOM APIs and inline styles, like every other file here, so `src/ui` ships no
 * stylesheet. ROWS ARE REUSED AND TEXT IS WRITTEN ONLY ON CHANGE, the bargain
 * `hud.ts` and `boot-hill.ts` make — and now for the HUD's own reason as well,
 * since this is rewritten every frame the rail is up. The pool also outlives the
 * mission: the rows a six-man squad built are the rows the next one writes over.
 */

import { DISPLAY_FONT, loadDisplayFont } from './display-font'
import {
  ORDNANCE_COUNT_STYLE,
  ORDNANCE_ICONS,
  ORDNANCE_ICON_ARMED_STYLE,
  ORDNANCE_ICON_BAR_STYLE,
  ORDNANCE_ICON_STYLE,
  ordnanceCountLabel,
} from './ordnance-icons'
import type { OrdnanceIcon } from './ordnance-icons'
import { INSIGNIA_STYLE, insigniaPosition } from './rank-insignia'
import { ROSTER_COLUMN_WIDTH } from './roster-column'

/** One man as the panel lists him: who he is, what he wears, and whether he is still up. */
export interface SquadPanelMember {
  /**
   * His campaign recruit id (ticket 066).
   *
   * THE JOIN, AND NOT DECORATION. `alive` is answered from
   * `livingRecruitIds(session.assignment, ...)`, which speaks recruit ids; the
   * caller needs something to match a row against that is NOT its position in an
   * array, because a positional pairing between the squad and the entity list is
   * exactly the bug `core/session/__tests__/squad-assignment.test.ts` exists to
   * prevent. Never drawn.
   */
  readonly id: string
  readonly name: string
  /**
   * His badge on the sheet, NOT his rank as a word. Which badge a rank wears is
   * `core/campaign`'s answer (`insigniaIndexOf`), where Vitest can see it; this
   * file would otherwise be a second, untested copy of the ladder.
   */
  readonly rankIndex: number
  /** Whether he is still standing. A man who is not is not drawn at all — see `rollCall`. */
  readonly alive: boolean
}

/** Everything the panel draws, as of this frame. */
export interface SquadPanelModel {
  /**
   * The squad, in the order the player chose them — the order he thinks of them
   * in. EVERY MAN WHO LANDED, dead ones included: who is drawn is this file's
   * decision (`rollCall`) and not the caller's, so the two cannot answer it
   * differently.
   */
  readonly squad: readonly SquadPanelMember[]
  /**
   * The weapon the next order will use, as `session.armoury.selected` says it
   * (ticket 067) — so exactly one icon is lit and the bar cannot disagree with
   * the HUD's selector about what is in the squad's hands.
   *
   * IT IS THE ARMOURY'S ANSWER AND NEVER THE BAR'S OWN. A panel that remembered
   * the last icon clicked would go stale the moment a digit, a shift-wheel or a
   * replayed command changed the selection behind its back, and the lit icon
   * would then be a claim about the weapon rather than a report of it.
   *
   * Frequently the rifle, which has no icon: nothing is lit, which is correct —
   * see `ORDNANCE_ICONS` for why the rifle has no button.
   */
  readonly armed: string
  /**
   * Rounds left, keyed by ordnance name, as `session.armoury.count` answers it
   * (ticket 069) — the number in the corner of each icon.
   *
   * READ FROM THE ARMOURY EVERY FRAME, LIKE `armed`, AND FOR THE SAME REASON. A
   * count the panel decremented on its own would drift the moment a chest, a
   * replayed command or a mission restart moved it, and the icon would then
   * disagree with the HUD's selector about the same pouch.
   *
   * A MISSING KEY IS AN EMPTY POUCH AND STILL PRINTS `0`, not a blank corner —
   * see `ordnanceCountLabel`.
   */
  readonly counts: Readonly<Record<string, number>>
}

/** What the rail needs from the game around it. */
export interface SquadPanelOptions {
  /**
   * Arm `ordnance` — the panel's whole share of the ordnance bar.
   *
   * It reports the weapon and stops there; the caller queues the selection
   * exactly as it does for a keypress. See the header.
   */
  onSelectOrdnance(ordnance: string): void
}

/**
 * One cell of a row: a badge, or the name between two of them.
 *
 * A DISCRIMINATED UNION rather than one object with two optional fields, so a
 * cell cannot claim to be a badge and carry text — `kind` decides which of the
 * two it has, and the renderer below narrows on it rather than testing for
 * `undefined`.
 *
 * THE ABSENT FIELD IS DECLARED `?: undefined` ON EACH ARM ON PURPOSE. Without
 * those two lines the union has no common properties, and reading `cell.text`
 * off an un-narrowed cell is a type error rather than `undefined` — which is
 * exactly what a caller holding the three-cell tuple wants to do when it already
 * knows which end is which.
 */
export type SquadRowCell =
  | { readonly kind: 'insignia'; readonly position: string; readonly text?: undefined }
  | { readonly kind: 'name'; readonly text: string; readonly position?: undefined }

/** Same interface `hud.ts` exposes, so the router in `app/main.ts` drives both identically. */
export interface SquadPanel {
  /** Redraw from `model`. Called once a mission, and safe to call again; see the header. */
  update(model: SquadPanelModel): void
  /**
   * Show or hide the rail without tearing it down — the HUD's own mechanism, for
   * the HUD's own reason. This file has no idea which screen the game is on and
   * is not given one; the router owns that question and answers it from `viewFor`.
   */
  setVisible(visible: boolean): void
  /** Whether the rail is currently shown. See `setVisible`. */
  isVisible(): boolean
  /** Remove the rail. Safe to call twice. */
  dispose(): void
}

/**
 * Matched to `hud.ts` and `boot-hill.ts`, so the game has one palette.
 *
 * ONE COLOUR FOR EVERY NAME, and no `MUTED` second one. Ticket 064 took the
 * two-tone roster off Boot Hill for the reason that applies here as well: a list
 * that greys some of its own names is read as saying something about those men,
 * and this one is not saying anything about anybody.
 */
const TEXT = '#f2efe6'

/**
 * The panel's `display` when it is shown.
 *
 * A CONSTANT BECAUSE `setVisible` HAS TO PUT THIS EXACT STRING BACK after
 * `display:none`. A literal in both places breaks the layout silently the day
 * the rail stops being a column, and `hud.ts` carries the same note for the same
 * reason.
 */
export const SQUAD_PANEL_DISPLAY = 'flex'

/**
 * A ROW'S `display` WHEN IT IS SHOWN, for the same reason and the same trap one
 * level down: `update` puts a pooled row back after `display:none`, and a literal
 * there would silently force reused rows to `flex` while freshly-built ones took
 * whatever `SQUAD_ROW_STYLE` said. The two would disagree only for a squad that
 * had already been drawn once.
 */
export const SQUAD_ROW_DISPLAY = 'flex'

/**
 * The rail itself: full height, hard against the left edge.
 *
 * FLUSH TO THE EDGE AND NOT INSET, unlike the HUD's floating card. This is a
 * column of the level's furniture rather than a panel dropped on top of it, and
 * it is the same column Boot Hill draws — an inset one would be a rail that
 * nearly lined up with the memorial's.
 *
 * IT NEVER EATS A CLICK MEANT FOR THE SQUAD. `pointer-events:none` is the HUD's
 * rule and matters more here than it does there: an order given through the
 * panel is an order that never arrives, and this thing covers the full height of
 * the map rather than one corner of it.
 */
export const SQUAD_PANEL_STYLE = [
  'position:fixed',
  'left:0',
  'top:0',
  'bottom:0',
  `width:${ROSTER_COLUMN_WIDTH}`,
  'z-index:30',
  `display:${SQUAD_PANEL_DISPLAY}`,
  'flex-direction:column',
  'gap:0.35rem',
  'padding:0.5rem 0.6rem 1rem',
  /**
   * CLIPPED, NOT SCROLLABLE, and the difference is `pointer-events:none` below:
   * a rail that cannot be reached by the mouse cannot be scrolled by it either,
   * so this only stops a squad taller than the window from spilling its last
   * rows over the hint bar at the bottom. It is not a way to read them. If a
   * squad ever outgrows a short window, the fix is smaller rows or two columns —
   * not a scrollbar the player is unable to touch.
   */
  'overflow-y:hidden',
  'background:rgba(10,13,11,0.82)',
  'border-right:1px solid rgba(242,193,78,0.4)',
  `color:${TEXT}`,
  'pointer-events:none',
  'user-select:none',
].join(';')

/**
 * One man's bar — Boot Hill's plaque, centred.
 *
 * `justify-content:center` AND NOT `space-between`, which is Boot Hill's rule
 * and the wrong one here: pushed to the edges, the badges leave the name reading
 * as left-aligned against the first of them rather than as the middle of the row.
 */
export const SQUAD_ROW_STYLE = [
  `display:${SQUAD_ROW_DISPLAY}`,
  'align-items:center',
  'justify-content:center',
  'gap:0.5rem',
  'padding:0.1rem 0.4rem',
  'background:rgba(58,62,44,0.85)',
  'border:1px solid rgba(242,193,78,0.22)',
  `color:${TEXT}`,
  `font-family:${DISPLAY_FONT}`,
  // The same stops Boot Hill's rows take, so the two columns are set at one
  // size. The badge tracks it on its own — `INSIGNIA_STYLE` is sized in `em`
  // precisely so it does, and must not be scaled a second time here.
  'font-size:clamp(1.1rem, 2.6vw, 1.37rem)',
  'letter-spacing:0.06em',
].join(';')

/**
 * The name, between the two badges.
 *
 * `flex:1` IS WHAT KEEPS THE BADGES AT THE ENDS. Without it the name is only as
 * wide as its own text and the two badges close up against it, so a three-letter
 * man and an eight-letter one sit at different distances from the panel's edges
 * — a column that looks ragged for a reason nobody can name.
 *
 * `min-width:0` BESIDE IT, because a flex item will not shrink below its content
 * by default: one long name would push the second badge out through the border.
 */
export const SQUAD_NAME_STYLE = [
  'flex:1',
  'min-width:0',
  'text-align:center',
  'overflow:hidden',
  'text-overflow:ellipsis',
  'white-space:nowrap',
].join(';')

/**
 * The row's shape: badge, name, the same badge again.
 *
 * PURE, AND THE ONLY PART OF THIS SCREEN A TEST CAN SEE. Everything the row
 * decides — that there are three cells, that both badges show the same rank,
 * that the name is upper-cased — is decided here rather than inside the DOM
 * writes below, so `squad-panel.test.ts` can assert it under Node.
 *
 * UPPER-CASED IN THE VALUE, NOT IN CSS. `text-transform` leaves the accessible
 * name lower case, so a screen reader is handed "Jops" while the screen says
 * JOPS; the project's rule, and the one `briefing.ts` carries a header note
 * about.
 */
export function squadRowCells(
  // ONLY THE TWO FIELDS A ROW IS MADE OF, not the whole member. Who a man is and
  // whether he is standing decide WHETHER he gets a row (`rollCall`), never what
  // one looks like — a row that could read `alive` is a row that could start
  // greying the dead, which is the thing ticket 066 exists to not do.
  member: Pick<SquadPanelMember, 'name' | 'rankIndex'>,
): readonly SquadRowCell[] {
  // `insigniaPosition` clamps rather than validating, so a rank from outside the
  // sheet still comes back as a badge — see its own header. Read once and used
  // twice, which is also what makes "the same badge on both ends" structural
  // rather than a coincidence of two calls.
  const position = insigniaPosition(member.rankIndex)
  return [
    { kind: 'insignia', position },
    { kind: 'name', text: member.name.toUpperCase() },
    { kind: 'insignia', position },
  ]
}

/**
 * The men who are actually drawn: the living, in the order they were given in.
 *
 * PURE, so the ticket's whole rule is checkable under `environment: 'node'` —
 * `update` closes over the DOM and cannot be imported at all.
 *
 * FILTERED, NOT SORTED. The panel is the list the player built on the Briefing
 * screen and has been reading down the side of the map all mission; a roll that
 * re-ordered itself every time somebody died would make him find his men again at
 * the exact moment he is least able to.
 */
export function rollCall(squad: readonly SquadPanelMember[]): readonly SquadPanelMember[] {
  return squad.filter((member) => member.alive)
}

/** Write `text` into `node` only when it has actually changed. See `hud.ts`. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/** One row's elements, in the order `squadRowCells` returns them. */
interface Row {
  readonly element: HTMLElement
  readonly left: HTMLElement
  readonly name: HTMLElement
  readonly right: HTMLElement
}

/** One weapon's button, and what it is currently showing. */
interface IconButton {
  readonly element: HTMLButtonElement
  /**
   * The count in its corner (ticket 069). Built once with the button and kept,
   * because a badge re-created per frame would be a new element on every one of
   * them — and `setArmed` below rewrites the button's `cssText`, which would
   * otherwise be the thing that removed it.
   */
  readonly count: HTMLElement
  /** The last state written, so the style is rewritten only when it changes. */
  armed: boolean
}

export function createSquadPanel(mount: HTMLElement, options: SquadPanelOptions): SquadPanel {
  // The rail is set in the same face as Boot Hill's roster; it registers once
  // however many screens ask.
  loadDisplayFont()

  const panel = document.createElement('aside')
  panel.setAttribute('aria-label', 'Squad')
  panel.style.cssText = SQUAD_PANEL_STYLE
  // HIDDEN UNTIL THE ROUTER SAYS OTHERWISE, exactly as the HUD is built. The
  // panel is made once at boot, before the first screen is decided; visible by
  // default would put a squad roster down the side of the Menu.
  panel.style.display = 'none'

  const list = document.createElement('ul')
  list.style.cssText =
    'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.15rem'
  panel.append(list)

  /**
   * The ordnance bar, under the roll (ticket 067).
   *
   * BUILT ONCE AND NEVER REBUILT. `ORDNANCE_ICONS` is a frozen table read at
   * import; the only thing that changes between frames is which button is lit,
   * and that is a style write on an existing element rather than a new one.
   */
  const bar = document.createElement('div')
  bar.style.cssText = ORDNANCE_ICON_BAR_STYLE
  bar.setAttribute('aria-label', 'Ordnance')
  bar.setAttribute('role', 'group')

  const buttons: IconButton[] = ORDNANCE_ICONS.map((icon) => {
    /**
     * A REAL `button`, NOT A `div` WITH A CLICK HANDLER. It is focusable, is
     * fired by Enter and Space, and announces itself as a control — and the
     * whole point of this bar is to be the mouse route to something that already
     * has a keyboard one.
     */
    const element = document.createElement('button')
    /**
     * `type="button"`, because a bare `<button>` inside any form the page ever
     * grows submits it and reloads the page — which mid-mission costs the
     * mission.
     */
    element.type = 'button'
    /**
     * The label is the whole accessible name: the art carries no words, so
     * without this a reader announces an unlabelled button and the keyboard
     * route stays undiscoverable.
     */
    element.setAttribute('aria-label', icon.label)
    // Repeated as the tooltip for the sighted player, who otherwise has a
    // picture and no way to learn the digit.
    element.title = icon.label
    element.style.cssText = ORDNANCE_ICON_STYLE
    element.style.backgroundImage = `url(${icon.src})`
    element.addEventListener('click', () => {
      options.onSelectOrdnance(icon.ordnance)
    })
    /**
     * The rounds left, in the corner of the square (ticket 069).
     *
     * A CHILD OF THE BUTTON AND NOT A SIBLING, so it moves with the icon and is
     * positioned against it — `ORDNANCE_ICON_STYLE` carries the `position:
     * relative` that makes that resolution work. Its own `cssText` is written
     * here and never again: `setArmed` rewrites the BUTTON's, which does not
     * reach a child's inline style.
     *
     * DECORATIVE TO A READER. The button's `aria-label` is its whole accessible
     * name and already overrides this text; marking it hidden says so rather
     * than leaving a stray digit in the subtree for anything that walks it.
     */
    const count = document.createElement('span')
    count.style.cssText = ORDNANCE_COUNT_STYLE
    count.setAttribute('aria-hidden', 'true')
    element.append(count)
    bar.append(element)
    return { element, count, armed: false }
  })

  panel.append(bar)
  mount.append(panel)

  /**
   * The row elements, by position in the squad. Kept and reused for the reason
   * in the header: the squad is fixed for the length of a mission, so the only
   * thing that can change is text.
   */
  const rows: Row[] = []

  function badge(): HTMLElement {
    const span = document.createElement('span')
    span.style.cssText = INSIGNIA_STYLE
    /**
     * DECORATIVE, AND SAID SO. The badge is drawn twice and says the same thing
     * both times; a reader announcing two unlabelled spans around every name
     * would read the roster three times over. The name is the record here, and
     * it is real text in the middle of the row.
     */
    span.setAttribute('aria-hidden', 'true')
    return span
  }

  function rowAt(index: number): Row {
    const existing = rows[index]
    if (existing !== undefined) return existing
    const element = document.createElement('li')
    element.style.cssText = SQUAD_ROW_STYLE
    const left = badge()
    const name = document.createElement('span')
    name.style.cssText = SQUAD_NAME_STYLE
    const right = badge()
    element.append(left, name, right)
    const made: Row = { element, left, name, right }
    rows[index] = made
    list.append(element)
    return made
  }

  /** Point a badge span at its cell, only when it has moved. */
  function setBadge(span: HTMLElement, cell: SquadRowCell): void {
    if (cell.kind !== 'insignia') return
    if (span.style.backgroundPosition !== cell.position) {
      span.style.backgroundPosition = cell.position
    }
  }

  /**
   * Light the armed weapon and dim the rest (ticket 067).
   *
   * WRITTEN ONLY ON CHANGE, like every other write in this file — `update` runs
   * on every frame the rail is up, and the selection changes a handful of times
   * a mission.
   *
   * `cssText` REWRITTEN WHOLE RATHER THAN THE THREE ARMED PROPERTIES UNSET.
   * Unsetting them one by one would be this file keeping its own list of what
   * `ORDNANCE_ICON_ARMED_STYLE` contains, and the day a fourth declaration is
   * added there the old one would stay on the button for the rest of the
   * mission. The background image is put back because `cssText` clears it.
   */
  function setArmed(button: IconButton, icon: OrdnanceIcon, armed: boolean): void {
    if (button.armed === armed) return
    button.armed = armed
    button.element.style.cssText = armed
      ? `${ORDNANCE_ICON_STYLE};${ORDNANCE_ICON_ARMED_STYLE}`
      : ORDNANCE_ICON_STYLE
    button.element.style.backgroundImage = `url(${icon.src})`
  }

  function update(model: SquadPanelModel): void {
    // THE LIVING, AND THE COUNT IS THEIRS TOO (ticket 066). Trimming the tail
    // against `model.squad.length` instead would leave the dead man's row shown
    // with the man BELOW him written into it — the rail would silently drop the
    // last name of the squad rather than the one who fell.
    const drawn = rollCall(model.squad)
    const count = drawn.length
    for (let i = 0; i < count; i += 1) {
      const member = drawn[i]
      const row = rowAt(i)
      // A HOLE IN THE LIST HIDES ITS ROW RATHER THAN SKIPPING IT. `member` cannot
      // actually be undefined below `drawn.length` — this is the
      // `noUncheckedIndexedAccess` concession every loop in this codebase makes —
      // but `continue` would be the wrong recovery if it ever were: the row is
      // inside `count`, so the tail loop below will not touch it, and it would
      // keep the PREVIOUS mission's man on screen under this mission's roster.
      if (member === undefined) {
        if (row.element.style.display !== 'none') row.element.style.display = 'none'
        continue
      }
      if (row.element.style.display !== SQUAD_ROW_DISPLAY) {
        row.element.style.display = SQUAD_ROW_DISPLAY
      }
      const cells = squadRowCells(member)
      const first = cells[0]
      const middle = cells[1]
      const last = cells[2]
      if (first === undefined || middle === undefined || last === undefined) continue
      setBadge(row.left, first)
      setBadge(row.right, last)
      if (middle.kind === 'name') setText(row.name, middle.text)
    }
    /**
     * Hide the tail rather than remove it.
     *
     * The panel outlives a mission and the next one can deploy fewer men; last
     * mission's seventh name still listed under this mission's six would be
     * indistinguishable from a bug in the campaign itself. Hidden and not
     * removed, because the pool above is the point.
     */
    for (let i = count; i < rows.length; i += 1) {
      const row = rows[i]
      if (row !== undefined && row.element.style.display !== 'none') {
        row.element.style.display = 'none'
      }
    }
    for (let i = 0; i < buttons.length; i += 1) {
      const button = buttons[i]
      const icon = ORDNANCE_ICONS[i]
      // Parallel arrays built from one `map`, so neither can be short — the
      // `noUncheckedIndexedAccess` concession every loop in this codebase makes.
      if (button === undefined || icon === undefined) continue
      setArmed(button, icon, icon.ordnance === model.armed)
      // `?? 0` because a pouch that was never stocked has no key at all, and an
      // icon with nothing in its corner reads as a weapon whose count is
      // unknown rather than as one that is empty.
      setText(button.count, ordnanceCountLabel(model.counts[icon.ordnance] ?? 0))
    }
  }

  return {
    update,
    setVisible(visible: boolean): void {
      panel.style.display = visible ? SQUAD_PANEL_DISPLAY : 'none'
    },
    isVisible(): boolean {
      return panel.style.display !== 'none'
    },
    dispose(): void {
      panel.remove()
    },
  }
}
