/**
 * ONE BADGE OUT OF A SHEET OF SIXTEEN (ticket 062).
 *
 * `assets/source/sprites/rank-insignia-sheet.png` is 1920x640: an 8x2 grid of
 * 240x320 cells, sixteen badges in ascending order on a TRANSPARENT background.
 * Every one of those numbers was measured off the file rather than assumed — the
 * eight column runs and the two row runs are exactly uniform, and the black the
 * sheet appears to sit on is a viewer's backdrop, not a matte.
 *
 * A CSS SPRITE AND NOT SIXTEEN FILES. Boot Hill is DOM, so a badge is a
 * `background-image` on a `span` and the whole of the decision is a
 * `background-position` — a string, which Vitest can read under `environment:
 * 'node'`. Sixteen separate imports would be sixteen requests and sixteen more
 * things for a rename to break silently.
 *
 * THE PERCENTAGE ARITHMETIC IS THE PART THAT IS EASY TO GET WRONG, so it is
 * stated once, here, and tested. A CSS `background-position` of `n%` does NOT
 * mean "n% along the image": it aligns the n% point of the IMAGE with the n%
 * point of the BOX. With the sheet scaled to `800%` the eight columns therefore
 * land at multiples of 100/7 — not 100/8. Both give 0% for the first cell and
 * 100% for the last, so the error is invisible at both ends of the row and
 * wrong everywhere in between.
 *
 * THE MODULE BODY TOUCHES NO DOM. Same split `screen-chrome.ts`,
 * `mission-banner.ts` and `briefing.ts` run on.
 */

import sheetUrl from '../../assets/source/sprites/rank-insignia-sheet.png?url'

/** The grid, as measured. */
export const INSIGNIA_COLUMNS = 8
export const INSIGNIA_ROWS = 2

/**
 * How many badges there are.
 *
 * DERIVED FROM THE GRID rather than written down, so it cannot become a third
 * number that disagrees with the other two. `rank-insignia.test.ts` ties it to
 * `RANKS.length` — that file imports both the sheet's shape and the ladder, and
 * is the only one that can.
 */
export const INSIGNIA_COUNT = INSIGNIA_COLUMNS * INSIGNIA_ROWS

/**
 * The `background-position` that shows badge `index`.
 *
 * CLAMPED, NOT VALIDATED. `background-position` does not fail on a silly value —
 * it just scrolls the image — so an out-of-range index would show a slice of two
 * badges, or nothing, with no error raised anywhere. Clamping makes a wrong
 * number look like a rank rather than like a rendering fault. `NaN` clamps to 0
 * because neither comparison below is true of it.
 */
export function insigniaPosition(index: number): string {
  const safe = Number.isFinite(index) ? Math.min(Math.max(Math.floor(index), 0), INSIGNIA_COUNT - 1) : 0
  const column = safe % INSIGNIA_COLUMNS
  const row = Math.floor(safe / INSIGNIA_COLUMNS)
  // See the header: the divisor is columns MINUS ONE, and the same for rows.
  const x = (column * 100) / (INSIGNIA_COLUMNS - 1)
  const y = (row * 100) / (INSIGNIA_ROWS - 1)
  // Trimmed so `0` and `100` stay whole rather than reading `0.0000%`; the
  // fractional columns keep enough places to land inside the right cell.
  const trim = (value: number): string => String(Number(value.toFixed(4)))
  return `${trim(x)}% ${trim(y)}%`
}

/**
 * Everything about a badge except WHICH one.
 *
 * `flex:none` IS LOAD-BEARING, not defensive. The row it sits in is
 * `display:flex` with `justify-content:space-between`, and a flex item with a
 * background but no text content has a base size of zero — without this the
 * badge collapses and the only symptom is a name that did not move.
 *
 * SIZED IN `em` SO IT TRACKS THE ROW. The rows are set in a `clamp()` that moves
 * with the viewport; a badge in `px` would be right at one window width and
 * wrong at every other. The ratio is the cell's own 240:320 — a square badge
 * would stretch every chevron by a third, which reads as bad artwork rather than
 * as a layout bug.
 */
export const INSIGNIA_STYLE = [
  'flex:none',
  'width:1.05em',
  'height:1.4em',
  `background-image:url(${sheetUrl})`,
  `background-size:${String(INSIGNIA_COLUMNS * 100)}% ${String(INSIGNIA_ROWS * 100)}%`,
  'background-repeat:no-repeat',
  // The cells have air around the badge already; contain would letterbox it
  // twice. The size above is exact, so the cell maps 1:1 onto the box.
  'image-rendering:auto',
].join(';')

/** The sheet's URL, for anything that wants to preload it. */
export const INSIGNIA_SHEET_URL = sheetUrl
