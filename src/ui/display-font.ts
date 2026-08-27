/**
 * THE GAME'S DISPLAY FACE (ticket 053).
 *
 * `assets/source/fonts/font.woff2`, registered at runtime with `FontFace` rather
 * than declared in an `@font-face` rule — `src/ui` ships no stylesheet, every
 * screen in it is inline styles on elements it made, and this is the DOM API for
 * exactly that. It is also why the family name is a constant here: nothing else
 * spells it, so nothing else can misspell it.
 *
 * THE FALLBACKS ARE NOT DECORATION. `document.fonts.add` can fail (a blocked
 * font, a store that refuses, an old engine with no `FontFace`), and a stack
 * that ended at the custom family would leave the mission card set in whatever
 * the browser defaults to — proportional and mixed case, which is the one thing
 * the card must not be. The system faces named are the heavy condensed ones that
 * are actually installed somewhere: Impact on Windows and macOS, Haettenschweiler
 * on Windows, then anything.
 *
 * IT NEVER THROWS AND NEVER REPORTS. A missing display face is a screen that
 * looks wrong, not a game that stops — and there is no player-facing channel on
 * a mission card for "the font did not load", nor anything he could do about it.
 */

import fontUrl from '../../assets/source/fonts/font.woff2?url'

/** What a screen puts in `font-family`. The custom face first, then reality. */
export const DISPLAY_FONT =
  '"Cannon Fodder", "Impact", "Haettenschweiler", "Franklin Gothic Bold", system-ui, sans-serif'

/** The family name inside the stack above, and the one `FontFace` is told. */
const FAMILY = 'Cannon Fodder'

/**
 * Registered already?
 *
 * MODULE-SCOPED AND NOT A LOOKUP IN `document.fonts`, because the question being
 * answered is "have WE added it", which a set that other code can also add to
 * cannot tell us. Every screen that uses the face calls this on the way up; the
 * second call onwards is a boolean.
 */
let started = false

/**
 * Load the face and make it available to every screen.
 *
 * FIRE AND FORGET, DELIBERATELY: nothing waits on the returned promise. Text is
 * painted in the fallback and reflows into the real face when it arrives, which
 * for a card that appears between missions is a flicker at worst — whereas
 * awaiting it would hold the mission card off screen behind a network fetch, on
 * the one screen the player is waiting to get past.
 */
export function loadDisplayFont(): void {
  if (started) return
  started = true
  // `FontFace` is missing on nothing this game runs on, but the whole point of
  // this module is that a screen never depends on the face arriving.
  if (typeof FontFace === 'undefined') return
  const face = new FontFace(FAMILY, `url(${fontUrl}) format("woff2")`)
  face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded)
    })
    .catch(() => {
      // See the header: a display face that would not load is a screen that
      // looks plainer, and there is nothing to tell anybody and nothing to do.
    })
}
