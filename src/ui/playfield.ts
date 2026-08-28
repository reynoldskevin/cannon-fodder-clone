/**
 * WHERE THE GAME IS DRAWN, NOW THAT SOMETHING ELSE OWNS THE LEFT EDGE
 * (ticket 074).
 *
 * The canvas used to be the whole window with the rail painted on top of it, so
 * a strip of map the width of the roster lived permanently behind the panel. It
 * was not a cosmetic overlap: men walked into it and disappeared, a click could
 * not be given on ground that was on screen by the camera's reckoning, and every
 * pan brought the squad into a column the player could not see them in.
 *
 * ONE NUMBER, NOT TWO THAT AGREE. The inset is `ROSTER_COLUMN_WIDTH` itself —
 * the same constant the rail sets its own width from and Boot Hill sets its
 * column from. A `clamp()` copied here would line up exactly until somebody
 * widened one of them, and then the map would either slide back under the panel
 * or leave a strip of dead background beside it, with nothing failing anywhere
 * and no way to notice but looking.
 *
 * `100vw` AND NOT `100%`. The canvas is `position:fixed`, so a percentage would
 * resolve against the initial containing block — the same thing today, and not
 * the same thing the moment the element is moved into a mount that has a size of
 * its own. The viewport is what is actually meant.
 *
 * NO `z-index`. This is the bottom of the page: the rail is 30, the mission
 * banner 41, the error overlay 50, and the playfield has no reason to enter that
 * argument. Position alone is enough to make the inset take effect.
 */

import { ROSTER_COLUMN_WIDTH } from './roster-column'

/**
 * The rectangle the game occupies, as positional declarations alone
 * (ticket 076).
 *
 * SPLIT OUT SO THE MISSION BANNER CAN SHARE IT. MISSION COMPLETE was
 * `inset:0` — correct while the canvas was the whole window, and half the
 * rail's width off-centre from the moment ticket 074 moved the playfield. The
 * fix is not a `calc()` copied into `mission-banner.ts`: that is the very
 * mistake this file's header refuses to make about `ROSTER_COLUMN_WIDTH`, one
 * level up. Two spellings would agree until somebody widened the rail, and then
 * the result of the mission would sit off the map with nothing failing.
 *
 * POSITION ONLY, NO `position` AND NO `display`. Both users are `position:fixed`
 * and say so themselves, but `display` differs — `block` is right for a canvas
 * and wrong for a flex layer that centres text on both axes — so it stays out of
 * the shared part.
 */
export const PLAYFIELD_INSET = [
  'top:0',
  `left:${ROSTER_COLUMN_WIDTH}`,
  `width:calc(100vw - ${ROSTER_COLUMN_WIDTH})`,
  'height:100vh',
].join(';')

export const PLAYFIELD_STYLE = [
  'position:fixed',
  PLAYFIELD_INSET,
  // A canvas is `inline` by default, which hands it a baseline and a few pixels
  // of descender gap — invisible while it was the only thing on the page and a
  // hairline of background once it has a neighbour.
  'display:block',
].join(';')
