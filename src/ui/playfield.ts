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

export const PLAYFIELD_STYLE = [
  'position:fixed',
  'top:0',
  `left:${ROSTER_COLUMN_WIDTH}`,
  `width:calc(100vw - ${ROSTER_COLUMN_WIDTH})`,
  'height:100vh',
  // A canvas is `inline` by default, which hands it a baseline and a few pixels
  // of descender gap — invisible while it was the only thing on the page and a
  // hairline of background once it has a neighbour.
  'display:block',
].join(';')
