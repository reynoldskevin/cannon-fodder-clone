/**
 * THE MEMORIAL'S LOOK (ticket 073), as plain strings.
 *
 * `assets/mockups/end-screen.png` is the screen this describes: LOST IN SERVICE
 * in gold on black, a poppy either side, and the dead under the mission that
 * took them.
 *
 * NO DOM IN THIS MODULE'S BODY, which is the whole reason it is a module.
 * `vitest.config.ts` sets `environment: 'node'` and `menu.ts` calls
 * `document.createElement` on its way up, so nothing in it can be imported by a
 * test. Everything the memorial DECIDES lives here as an exported constant or a
 * pure function; the elements that wear them are built in `menu.ts`, where they
 * belong and where nothing checks them. `mission-banner.ts` and
 * `rank-insignia.ts` are the same bargain.
 */

import { DISPLAY_FONT } from './display-font'
import poppyUrl from '../../assets/source/sprites/poppy.webp?url'

/** The URL of the flower, re-exported so `menu.ts` needs no second import. */
export const POPPY_URL: string = poppyUrl

/**
 * What the screen is called.
 *
 * NOT "CAMPAIGN COMPLETE", which is what it said. That is a status line about
 * the player's progress, printed over a list of the men it cost him.
 */
export const LOST_IN_SERVICE_TITLE = 'LOST IN SERVICE'

/**
 * The one warm colour on the screen.
 *
 * NOT `GOOD` AND NOT `BAD`. The shared status colours mean "a win" and "a loss"
 * everywhere else in the game, and a memorial is neither — green would read as a
 * result and the warm orange as a warning. Gold is the mockup's, and it is the
 * only colour here that is not black, bone or ash.
 */
export const MEMORIAL_GOLD = '#e8a317'

/** The bone the names are set in — a shade off white, so the gold stays the accent. */
const BONE = '#e6e2d8'

/** The ash the mission headings and the kill counts are set in. */
const ASH = '#8d8b84'

/**
 * The dark this screen sits on.
 *
 * IT BURIES THE JUNGLE RATHER THAN TINTING IT. The Menu's own scrim clears to
 * 25% through the middle so the marching cast reads against the art; that is
 * right for a title card and wrong for a memorial, and the mockup has no
 * background at all. A gradient rather than a flat fill only so the very top and
 * bottom go fully black and the buttons and title have nothing behind them.
 *
 * A BARE `background` VALUE, not a declaration. It is assigned to
 * `scrim.style.background` on the one screen state that wants it and back to the
 * Menu's own on every other, so a `background:` prefix would only be something
 * to strip.
 */
export const MEMORIAL_SCRIM = [
  'linear-gradient(',
  'rgba(2,3,4,1) 0%,',
  'rgba(2,3,4,0.94) 40%,',
  'rgba(2,3,4,0.94) 60%,',
  'rgba(2,3,4,1) 100%)',
].join('')

/**
 * The title, on its plaque.
 *
 * `letter-spacing` IS DOING REAL WORK. The mockup's title is widely tracked
 * caps, and the display face is a heavy condensed one — set solid it reads as a
 * block rather than as words.
 */
export const MEMORIAL_TITLE_STYLE = [
  'margin:0',
  `font-family:${DISPLAY_FONT}`,
  // Bigger than a mission heading and smaller than the mission-end banner: this
  // is the heading of a screen, not an announcement over the field.
  'font-size:clamp(1.9rem, 6vw, 3.4rem)',
  'font-weight:400',
  'letter-spacing:0.18em',
  // The tracking is added to the RIGHT of the last letter too, which pushes
  // centred text visibly off centre. Half of it back as padding is the fix.
  'padding:0.35rem 0.6rem 0.35rem calc(0.6rem + 0.18em)',
  'text-transform:uppercase',
  `color:${MEMORIAL_GOLD}`,
  // The mockup's title sits on a scratched stone plate. A flat panel is the
  // honest version of that with no second asset.
  'background:linear-gradient(rgba(70,70,70,0.55), rgba(28,28,28,0.55))',
  'border-top:1px solid rgba(255,255,255,0.14)',
  'border-bottom:1px solid rgba(0,0,0,0.6)',
  'text-shadow:0 2px 6px rgba(0,0,0,0.9)',
].join(';')

/** `Mission 9` — the heading over one mission's dead. */
export const MISSION_HEADING_STYLE = [
  'margin:0.9rem 0 0.35rem',
  `font-family:${DISPLAY_FONT}`,
  'font-size:clamp(1.425rem, 3.3vw, 1.875rem)',
  'font-weight:400',
  'letter-spacing:0.14em',
  `color:${ASH}`,
  'text-align:center',
].join(';')

/**
 * One man: his badge, his name, and what he killed at the far end.
 *
 * THE NUMBER GOES TO THE FAR END so a column of them lines up and can be read
 * down. The mockup centres the name between two decorative marks, which is the
 * right shape for a plaque carrying no data and the wrong one for a row that
 * has a figure in it.
 *
 * `center`, NOT `baseline` (ticket 088). Baseline was right while both children
 * were text. The badge is a background on an EMPTY span and has no text baseline
 * to align to, so it would sit wherever the box model happened to leave it —
 * which is why `squad-panel.ts` and `boot-hill.ts` both centre the same badge.
 */
export const FALLEN_ROW_STYLE = [
  'display:flex',
  'justify-content:space-between',
  'align-items:center',
  'gap:1rem',
  'padding:0.3rem 0.75rem',
  `font-family:${DISPLAY_FONT}`,
  'font-size:clamp(1.35rem, 3vw, 1.65rem)',
  'letter-spacing:0.06em',
  /**
   * DOUBLED IN 089, DOWN A QUARTER IN 090, AND THE BADGE DOWN A QUARTER IN 091.
   * `INSIGNIA_STYLE` is `1.05em x 1.4em`, sized off THIS number, so the insignia
   * tracks the row again — 090 had held it still with a memorial-only override
   * widened by `1 / 0.75`, and 091's reduction cancelled that factor exactly,
   * which is why the override is gone rather than retuned.
   *
   * ALL THREE CLAMP STOPS MOVE TOGETHER, because a phone sits on the floor or
   * the `vw` term: editing the ceiling alone changes nothing on the narrow
   * screens this is hardest to read on.
   */
  `color:${BONE}`,
  // The faintest of plaques, so a long roll reads as stacked rows rather than a
  // wall of text, without drawing a box around every man.
  'background:linear-gradient(rgba(255,255,255,0.07), rgba(255,255,255,0.02))',
].join(';')

/**
 * The man's name, between his badge and his tally (ticket 088).
 *
 * `flex:1` IS THE WHOLE STYLE AND IT IS NOT COSMETIC. The row is
 * `justify-content:space-between`: with two children that pinned the name left
 * and the count right, but the badge makes THREE, and space-between spreads
 * three items evenly — badge left, name marooned in the middle, count right.
 * Letting the name take the free space keeps it against its badge and the
 * count against the far edge. Ticket 062 fixed exactly this on Boot Hill, which
 * is why the same line appears there.
 */
export const FALLEN_NAME_STYLE = 'flex:1'

/** The kill count at the end of a row — present, but not the loud part. */
export const KILL_COUNT_STYLE = `color:${ASH};font-variant-numeric:tabular-nums;white-space:nowrap`

/**
 * Which layer the roll is on.
 *
 * EXPORTED SO THE POPPIES CAN BE CHECKED AGAINST IT rather than against a
 * transcribed number. The two constants below must stay under this one, and a
 * test that compared both to `2` would pass while somebody raised one of them.
 */
export const ROLL_Z_INDEX = 3

/** The layer the flowers are on — under the roll, by construction. */
const POPPY_Z_INDEX = ROLL_Z_INDEX - 1

/**
 * A poppy against one edge.
 *
 * SIZED BY HEIGHT, NOT WIDTH. `poppy.png` is 1024x1024 with the opaque pixels
 * confined to x339-641 and y111-993 — a tall stem in a square frame. Sizing it
 * by width would show a flower a third of the size asked for and pad the rest
 * with empty pixels that shove the roll inward.
 *
 * `pointer-events:none` AND UNDER THE ROLL, both load-bearing. A PNG's
 * transparent pixels still take the mouse, so a flower on top of a scrolling
 * list of the dead — or of the buttons under it — is a screen the player cannot
 * leave. `briefing.ts` records the game already shipping one unclickable button
 * for a neighbouring reason.
 *
 * OFF THE BOTTOM EDGE by a little: the asset ends in a tuft of grass, and a stem
 * that stops short of the edge reads as a picture of a flower rather than as a
 * flower growing at the side of the screen.
 */
const poppy = (side: 'left' | 'right'): string =>
  [
    'position:absolute',
    'bottom:-2vh',
    `${side}:clamp(-3rem, 1vw, 2rem)`,
    // Tall enough that the flower HEAD comes up beside the roll rather than
    // sitting under it — the head is in the top sixth of the asset, so a short
    // stem puts it below the names it is meant to flank. Capped so it does not
    // tower over the title on a wide screen or crowd the names on a narrow one.
    'height:min(88vh, 44rem)',
    'width:auto',
    `z-index:${String(POPPY_Z_INDEX)}`,
    'pointer-events:none',
    'user-select:none',
    // Sunk into the black rather than pasted on it. The art is a bright,
    // hard-outlined illustration and at full strength it is the loudest thing on
    // a screen whose subject is a list of names.
    'opacity:0.85',
    'filter:drop-shadow(0 0 2rem rgba(0,0,0,0.9))',
    // ONE ASSET, TWO SIDES. Shipping a mirrored copy would be 160kB to say this.
    side === 'right' ? 'transform:scaleX(-1)' : 'transform:none',
  ].join(';')

export const POPPY_LEFT_STYLE = poppy('left')
export const POPPY_RIGHT_STYLE = poppy('right')

/**
 * `Mission 9` from a level number.
 *
 * FLOORED, AND FLOORED AT ONE. `diedOnLevel` reaches this from a save file, and
 * `parseState` bounds the campaign's numbers below and no further — the same
 * hole `campaignSummary` floors `levelsCompleted` for. "Mission 2.5" and
 * "Mission NaN" are sentences no memorial should print, and there is nothing
 * useful to do about a damaged one but name the first mission.
 */
export function missionHeading(level: number): string {
  const safe = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1
  return `Mission ${String(safe)}`
}
