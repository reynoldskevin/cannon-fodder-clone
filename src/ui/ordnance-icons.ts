/**
 * THE TWO ORDNANCE TYPES, AS THINGS YOU CAN CLICK (ticket 067).
 *
 * Arming a grenade was a keyboard-only act: press `2`, and the only
 * acknowledgement was a line of monospace in the HUD's selector. This is the
 * same two weapons as painted icons under the squad rail, and clicking one has
 * to arm it EXACTLY as its digit does.
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
 * Every weapon with an icon, in the armoury's own order.
 *
 * THE RIFLE IS NOT ON IT. It is unlimited, it is what every soldier is already
 * holding, and it has no count to show; a button for it would only ever undo one
 * of the other two.
 *
 * THE ARMOURY'S ORDER AND NOT THIS FILE'S, so the bar reads left to right in the
 * same order as the HUD's selector and as the digits. Two orders would make the
 * second icon the third weapon.
 *
 * WALKED FROM `ORDNANCE_ORDER` AND NOT FROM `ORDNANCE` DIRECTLY, though the two
 * hold the same names: the order is the thing being copied, and taking it from
 * anywhere else would be this file re-deciding it. `ORDNANCE_ORDER` is the rifle
 * followed by `Object.keys(ORDNANCE)`, so dropping the rifle leaves the table
 * whole — which is the coverage `ordnance-icons.test.ts` asserts.
 */
export const ORDNANCE_ICONS: readonly OrdnanceIcon[] = Object.freeze(
  ORDNANCE_ORDER.filter((ordnance) => ordnance !== RIFLE_ORDNANCE).map((ordnance) => {
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
 * `margin-top:auto` PUSHES IT TO THE FOOT OF THE RAIL. The roster grows and
 * shrinks as men fall; a bar that followed the last name would move up the
 * screen every time somebody died, and the player would reach for where it was.
 */
export const ORDNANCE_ICON_BAR_STYLE = [
  'display:flex',
  'flex-direction:row',
  'justify-content:center',
  'gap:0.5rem',
  'margin-top:auto',
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
  'width:2.6rem',
  'height:2.6rem',
  'padding:0',
  'background-color:rgba(58,62,44,0.85)',
  'background-repeat:no-repeat',
  'background-position:center',
  // `contain`, never `cover`: the art has a real alpha channel and a cropped
  // grenade is a grenade the player has to guess at.
  'background-size:contain',
  'border:1px solid rgba(242,193,78,0.22)',
  'border-radius:0',
  'opacity:0.55',
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
