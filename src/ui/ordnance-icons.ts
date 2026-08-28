/**
 * EVERY ORDNANCE TYPE, AS SOMETHING YOU CAN CLICK (tickets 067, 073).
 *
 * Arming a grenade was a keyboard-only act: press `2`, and the only
 * acknowledgement was a line of monospace in the HUD's selector. These are the
 * game's weapons as painted icons under the squad rail, and clicking one has
 * to arm it EXACTLY as its digit does.
 *
 * THE RIFLE IS ON THE BAR, AND 067'S REASONING FOR LEAVING IT OFF IS REVERSED
 * (ticket 073). It was excluded on the grounds that it is unlimited, is what
 * every soldier is already holding, and has no count to show — sound while the
 * bar was two pictures of throwables, wrong the moment the bar became how the
 * player CHANGES weapon. Arming a grenade was one click and putting it down
 * again was not: the only ways back were the `1` key and spending the last
 * round. "A button that only ever undoes one of the other two" turned out to be
 * precisely the button that was missing.
 *
 * THE HOTKEY IS DERIVED AND IS NOT AUTHORED TWICE. `core/armoury` decides a
 * weapon's digit from its position in `ORDNANCE_ORDER` (`hotkeyAt`,
 * `ordnanceForHotkey`), so a table that wrote `hotkey: '2'` beside the grenade
 * would be a second copy of that rule — right today and wrong the first time a
 * weapon is inserted ahead of it. The icon would then arm the rocket while
 * showing a grenade, and the player would find out by throwing the wrong thing.
 * So the digits are scanned back through `ordnanceForHotkey` and the answer is
 * whatever the keyboard handler would have got.
 *
 * A MISSING PICTURE IS A LOUD FAILURE AND NOT A MISSING BUTTON. `ORDNANCE` is
 * where a designer adds a weapon; one that arrives with no art throws here, at
 * module load, naming itself. Skipping it silently would ship a level screen
 * with a control quietly absent, and the only symptom would be a weapon the
 * mouse cannot reach.
 *
 * THE MODULE BODY TOUCHES NO DOM, which is the whole reason any of this is
 * checkable: Vitest runs `environment: 'node'` with no jsdom, so nothing in
 * `src/ui` that reaches for `document` at import time can be loaded by a test at
 * all. The table is data and the styles are strings; the `createElement` calls
 * live in `squad-panel.ts`. Same split `rank-insignia.ts` and `squad-panel.ts`
 * already run on.
 */

import { ORDNANCE_ORDER, RIFLE_ORDNANCE, labelFor, ordnanceForHotkey } from '../core/armoury'
import grenadeUrl from '../../assets/source/sprites/grenade.png?url'
import rifleUrl from '../../assets/source/sprites/rifle.png?url'
import rocketUrl from '../../assets/source/sprites/rocket.png?url'

/**
 * The picture for each weapon, keyed by its `ORDNANCE` name.
 *
 * Imported with `?url` rather than read out of `public/`, the bargain
 * `boot-hill.ts` and `rank-insignia.ts` make: these are hand-made files that
 * nothing generates, so a rename becomes a build failure with the importing line
 * named instead of an empty box at run time.
 */
const ART: Readonly<Record<string, string>> = {
  // KEYED BY THE CONSTANT AND NOT BY THE WORD `rifle`. The rifle is the one
  // weapon whose name lives in `core/armoury` rather than in `ORDNANCE`, so a
  // literal here would be a second copy of it — and the failure would be a
  // module-load throw the day it is renamed, which is loud but avoidable.
  [RIFLE_ORDNANCE]: rifleUrl,
  grenade: grenadeUrl,
  rocket: rocketUrl,
}

/** One clickable weapon: what it is, what it looks like, and how else to reach it. */
export interface OrdnanceIcon {
  /** The `selectOrdnance` command's `ordnance`, and the key into `ORDNANCE`. */
  readonly ordnance: string
  /** The digit that arms it, asked of `core/armoury` rather than written down. */
  readonly hotkey: string
  /** The accessible name, and the only words on the control — the art has none. */
  readonly label: string
  /** The bundled URL of its picture. */
  readonly src: string
}

/**
 * The digit `ordnance` is armed by, as the keyboard handler would resolve it.
 *
 * SCANNED RATHER THAN COMPUTED FROM AN INDEX. `hotkeyAt` is private to
 * `core/armoury`, and re-deriving `String(index + 1)` here would be the second
 * copy this file exists to avoid; asking `ordnanceForHotkey` means the icon's
 * digit is true by round trip. Nine because that is what `main.ts`'s
 * `Digit([1-9])` can produce — a tenth weapon has no key to claim, and throwing
 * says so rather than shipping a button labelled with a digit that does nothing.
 */
function hotkeyFor(ordnance: string): string {
  for (let digit = 1; digit <= 9; digit += 1) {
    const key = String(digit)
    if (ordnanceForHotkey(key) === ordnance) return key
  }
  throw new Error(`ordnance "${ordnance}" has no selection key: only 1-9 can arm a weapon`)
}

/**
 * Every weapon, in the armoury's own order — the rifle first (ticket 073).
 *
 * THE ARMOURY'S ORDER AND NOT THIS FILE'S, so the bar reads left to right in the
 * same order as the HUD's selector and as the digits. Two orders would make the
 * second icon the third weapon.
 *
 * "TO THE LEFT OF THE GRENADE AND ROCKET" IS THEREFORE NOT ARRANGED HERE. It
 * falls out of `ORDNANCE_ORDER`, which is the rifle followed by
 * `Object.keys(ORDNANCE)`; a sort in this file would be a second order that
 * agreed with the digits right up until somebody changed one of them. The
 * rifle's `1` round-trips through `hotkeyFor` for free, for the same reason.
 *
 * WALKED FROM `ORDNANCE_ORDER` AND NOT FROM `ORDNANCE` DIRECTLY: `ORDNANCE` does
 * not hold the rifle at all, and even for the two it does hold, the order is the
 * thing being copied — taking it from anywhere else would be this file
 * re-deciding it.
 *
 * NOTHING IS FILTERED OUT ANY MORE. Between 067 and 073 the rifle was dropped
 * here; the whole of that reversal is in this file's header.
 */
export const ORDNANCE_ICONS: readonly OrdnanceIcon[] = Object.freeze(
  ORDNANCE_ORDER.map((ordnance) => {
    const src = ART[ordnance]
    if (src === undefined) {
      throw new Error(
        `ordnance "${ordnance}" has no icon: add its art to src/ui/ordnance-icons.ts`,
      )
    }
    const hotkey = hotkeyFor(ordnance)
    // The weapon AND its key, because the keyboard route is not discoverable
    // from a picture of a grenade.
    return { ordnance, hotkey, label: `${labelFor(ordnance)} (key ${hotkey})`, src }
  }),
)

/** Matched to `hud.ts`, `boot-hill.ts` and `squad-panel.ts`, so the game has one palette. */
const HIGHLIGHT = '#f2c14e'

/**
 * The bar the icons sit on, under the roster.
 *
 * `pointer-events:auto` IS THE ONE LINE THAT WILL SILENTLY NOT WORK WITHOUT.
 * `SQUAD_PANEL_STYLE` carries `pointer-events:none` so an order clicked through
 * the full-height rail still reaches the canvas, and that inherits — leave this
 * out and the icons draw perfectly, light up correctly, and cannot be clicked at
 * all. Taken back here and nowhere higher, so the rest of the rail keeps giving
 * clicks away.
 *
 * DIRECTLY UNDER THE LAST NAME, NOT AT THE FOOT OF THE RAIL (ticket 068). It was
 * pinned to the bottom by `margin-top:auto` on the reasoning that a bar which
 * followed the roster would walk up the screen as men died. It reads as detached
 * furniture down there — the rail is full height, so the icons sat a long way
 * from the thing they belong to. They move with the roster now, which is the
 * cost of belonging to it.
 */
export const ORDNANCE_ICON_BAR_STYLE = [
  'display:flex',
  'flex-direction:row',
  'justify-content:center',
  'gap:0.5rem',
  /**
   * NO WIDER THAN THE ICONS IT CARRIES, and centred by `align-self` rather than
   * by filling the rail. This bar is the one part of the screen that takes
   * pointer events BACK, so every pixel of it is a pixel the canvas stops
   * hearing — full width, it would swallow a band of clicks right across the
   * foot of the rail that used to fall through as move orders. The player would
   * lose orders in a strip of ground and never be told why.
   */
  'align-self:center',
  'width:fit-content',
  /**
   * AND NO WIDER THAN THE RAIL EITHER, which is the opposite failure and the one
   * the third icon caused (ticket 073). `fit-content` alone asks for whatever
   * the row needs: three buttons is `3 × 3.9rem` plus two `0.5rem` gaps plus
   * borders, a shade over 13rem, against a rail of `clamp(11rem, 22vw, 16rem)`
   * whose 22vw sits under the 11rem floor on any viewport below 800px. Two
   * icons fitted with room to spare; three do not.
   *
   * THE SPILL WOULD BE CLIPPED RATHER THAN SHOWN, so this is a lost click and
   * not a cosmetic overhang. `SQUAD_PANEL_STYLE` sets `overflow-y:hidden`, which
   * makes the unset `overflow-x` compute to `auto` rather than `visible` — the
   * excess is cut off and stops being hit-testable. Centred by `align-self`, the
   * bite is taken out of BOTH ends, so the rifle loses part of the very click
   * target this ticket exists to give it.
   *
   * SO THE ROW WRAPS, rather than the rail growing to fit it.
   * `ROSTER_COLUMN_WIDTH` is shared with Boot Hill, and widening it to seat an
   * icon would shift a screen that has no icons on it — a memorial moved by a
   * weapon button is a change nobody asked for and nobody would connect back to
   * here. A second line of icons costs vertical room the full-height rail has.
   *
   * AND IT WRAPS SOONER SINCE TICKET 074, DELIBERATELY. Border-boxing the rail,
   * so the playfield could subtract a width that was actually true, took
   * `1.2rem` off the space INSIDE it — which moves the threshold from about a
   * 950px window to about a 1040px one, so a 1024-wide window now shows two rows
   * where it showed one. Taken over the alternative of shaving the icons back
   * down: they are 3.9rem because they were asked to be half again bigger
   * (ticket 068), and a wrap costs a strip of rail nobody was using while a
   * smaller icon costs the size on every screen.
   */
  'flex-wrap:wrap',
  'max-width:100%',
  'padding-top:0.6rem',
  'pointer-events:auto',
].join(';')

/**
 * One weapon's button, unarmed.
 *
 * THE PICTURE IS A BACKGROUND AND NOT AN `img` CHILD. `background-size:contain`
 * letterboxes art of any aspect inside a square without the child element that
 * an `img` would give a reader a second thing to announce; the button's
 * `aria-label` is the whole of its accessible name.
 *
 * DIMMED RATHER THAN GREYED, so the unarmed weapon still reads as available. It
 * is the armed one that is stated, below.
 */
export const ORDNANCE_ICON_STYLE = [
  'flex:none',
  /**
   * THE POSITIONING CONTEXT THE COUNT SITS IN (ticket 069). `position:absolute`
   * resolves against the nearest POSITIONED ancestor, and without this that is
   * the page: both badges would stack in the bottom-right of the viewport, on
   * top of each other, and neither icon would carry a number.
   */
  'position:relative',
  // 50% UP ON WHAT 067 SHIPPED (ticket 068). At 2.6rem the art was a thumbnail
  // of a grenade rather than a grenade, and it is a click target as well as a
  // picture — a button the size of a favicon is one the player has to aim at.
  'width:3.9rem',
  'height:3.9rem',
  'padding:0',
  'background-color:rgba(58,62,44,0.85)',
  'background-repeat:no-repeat',
  'background-position:center',
  // `contain`, never `cover`: the art has a real alpha channel and a cropped
  // grenade is a grenade the player has to guess at.
  'background-size:contain',
  'border:1px solid rgba(242,193,78,0.22)',
  'border-radius:0',
  /**
   * DIMMED, BUT NOT SO FAR THAT THE COUNT GOES WITH IT. `opacity` composites the
   * whole subtree, so whatever this says the badge in the corner says too — and
   * the count that matters most is the one on the weapon the player is NOT
   * holding, which is the only way he learns it is empty before he reaches for
   * it. 0.55 took the number down with the picture; the armed state is carried
   * by the border and the ring either way, so the dimming can afford to be a
   * hint rather than the whole signal.
   */
  'opacity:0.78',
  'cursor:pointer',
].join(';')

/**
 * The one that is armed.
 *
 * STRUCTURAL AND NOT A HUE. Which weapon am I holding is the question this bar
 * exists to answer, and a colour-blind player or a washed-out screen must not be
 * the reason it goes unanswered — the same bargain the HUD's selector and the
 * roster's pips make. So the armed state is full opacity and a ring as well as a
 * brighter border, and any one of the three would carry it alone.
 *
 * APPENDED AFTER `ORDNANCE_ICON_STYLE` rather than replacing it: later
 * declarations win in a `style` attribute, so this only has to say what differs.
 */
export const ORDNANCE_ICON_ARMED_STYLE = [
  'opacity:1',
  `border-color:${HIGHLIGHT}`,
  `box-shadow:0 0 0 2px rgba(242,193,78,0.45)`,
].join(';')

/**
 * How many rounds are left, as the corner of an icon prints it (ticket 069).
 *
 * A ZERO IS PRINTED AND NOT HIDDEN. An empty pouch is the thing the player most
 * needs to read: a badge that went blank at zero would leave an icon that looks
 * exactly like a loaded weapon, and the only difference would be that firing
 * does nothing.
 *
 * A WEAPON THAT CANNOT RUN OUT SAYS NOTHING AT ALL (ticket 073). The armoury
 * answers `Number.POSITIVE_INFINITY` for the rifle, and `String()` of that is
 * the word `Infinity` — nine characters across the corner of a 3.9rem button,
 * over the art, saying something no player has ever wanted to read.
 *
 * READ OFF THE COUNT AND NEVER OFF THE WEAPON'S NAME. The rule is "no finite
 * count, no badge", which is exactly what `count()` is already saying; `if
 * (ordnance === RIFLE_ORDNANCE)` would be a second place in the codebase that
 * knows which weapon is unlimited, and it would be wrong the first day another
 * one is. `isFinite` rather than a check against `Infinity` because it also
 * catches `NaN`, which is what a count arrives as when something upstream has
 * gone wrong — and a blank corner is a better answer to that than the word.
 *
 * PURE AND SEPARATE FROM THE ELEMENT that shows it, the split the rest of this
 * file runs on — Vitest has no DOM, so the rule is only checkable out here. What
 * an empty answer LOOKS like is `squad-panel.ts`'s half: the badge carries a
 * plate, padding and a min-width, so it is hidden rather than written empty.
 */
export function ordnanceCountLabel(count: number): string {
  if (!Number.isFinite(count)) return ''
  return String(count)
}

/**
 * The count, tucked into the bottom-right of the square.
 *
 * `bottom`/`right` AND NEITHER OF THE OTHER TWO EDGES. Pinned to all four the
 * badge stretches across the icon and centres the number over the art, which
 * hides the picture the button is identified by.
 *
 * `pointer-events:none` IS NOT COSMETIC. The badge is a child of the button, so
 * a click on the number is a click on the button only if the badge never becomes
 * the event's target — and the corner is exactly where a player aiming at a
 * small icon tends to land.
 *
 * LEGIBLE OVER ART OF ANY BRIGHTNESS: a dark plate under it, not a text-shadow
 * alone, because the pale side of the grenade sprite is close enough to the
 * highlight colour that a shadowed number on it is a smudge.
 */
export const ORDNANCE_COUNT_STYLE = [
  'position:absolute',
  'bottom:0',
  'right:0',
  'min-width:1em',
  'padding:0 0.15em',
  'background-color:rgba(10,13,11,0.85)',
  `color:${HIGHLIGHT}`,
  'font-family:monospace',
  // Small enough to stay a marginal note on a 3.9rem button, bold because at
  // this size a hairline digit is the first thing a busy background eats.
  'font-size:0.85rem',
  'font-weight:700',
  'line-height:1.1',
  'text-align:center',
  'pointer-events:none',
].join(';')
