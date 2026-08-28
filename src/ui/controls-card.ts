/**
 * THE CONTROLS CARD (ticket 074): the one screen that says how to play.
 *
 * Nothing else in the game does. `control-hint.ts` puts a line under a running
 * mission and that is all, so a player reaching his first firefight has never
 * been told that the right button fires.
 * `assets/source/sprites/instructions.png` is the card that says it, and this
 * file mounts it between the title and Boot Hill.
 *
 * A REAL SCREEN IN THE CHART, NOT A MODAL THE MENU OPENS. `Menu -> Controls ->
 * BootHill` lives in `transitions.ts` where `transitions.test.ts` and
 * `diagram.test.ts` can hold it; a flag inside `menu.ts` would have hidden a
 * piece of the campaign's flow in the layer `environment: 'node'` cannot test,
 * and `viewFor` would have gone on reporting the Menu while the player looked at
 * something else.
 *
 * THE DECISIONS ARE EXPORTED STRINGS AND THE `document` CALLS ARE NOT, which is
 * the arrangement every other tested file in `src/ui` uses — `mission-banner.ts`,
 * `rank-insignia.ts`, `lost-in-service.ts`. Anything the module body touched
 * would make the whole file unimportable under Vitest.
 */

import { createButton, createChrome } from './screen-chrome'
import { DISPLAY_FONT, loadDisplayFont } from './display-font'
import instructionsUrl from '../../assets/source/sprites/instructions.png?url'

/** What the screen is called. */
export const CONTROLS_TITLE = 'CONTROLS'

/**
 * The button off the card.
 *
 * WRITTEN THE WAY IT IS READ, not upper-cased in CSS. `text-transform` leaves
 * the accessible name in whatever case the markup used, so a screen reader would
 * announce one thing while the button showed another — `briefing.ts` makes the
 * same argument about GO FOR IT.
 */
export const CONTROLS_CONTINUE_LABEL = 'GOT IT'

/**
 * Flat black, edge to edge.
 *
 * NOT A GRADIENT AND NOT A TINT. The Menu wears the jungle and the campaign's
 * end wears the memorial's near-black; this is neither. `instructions.png` is
 * grey-green panels on transparency, and anything showing through behind them
 * competes with the one thing this screen exists to make legible.
 *
 * OPAQUE, WHICH IS LOAD-BEARING. The shared chrome's backdrop is a translucent
 * dim over whatever was on screen before, and inheriting that here would leave
 * the Menu's jungle ghosting behind the instructions.
 */
export const CONTROLS_BACKDROP_STYLE = [
  'position:fixed',
  'inset:0',
  'z-index:60',
  'display:flex',
  'flex-direction:column',
  'align-items:center',
  'justify-content:center',
  'gap:clamp(1rem, 4vh, 2.5rem)',
  'padding:clamp(1rem, 4vw, 3rem)',
  'box-sizing:border-box',
  'background:#000',
].join(';')

/**
 * CONTROLS, in white.
 *
 * WHITE AND NOT THE MEMORIAL'S GOLD. `#e8a317` is the colour the end of a
 * campaign earned; an instruction card wearing it would read like a eulogy.
 */
export const CONTROLS_TITLE_STYLE = [
  'margin:0',
  `font-family:${DISPLAY_FONT}`,
  'font-size:clamp(2rem, 7vw, 3.6rem)',
  'font-weight:400',
  'letter-spacing:0.18em',
  // The tracking is added to the right of the last letter too, which pushes
  // centred text visibly off centre; half of it back as padding is the fix.
  'padding-left:0.18em',
  'color:#ffffff',
  'text-align:center',
].join(';')

/**
 * The picture, whole.
 *
 * `contain` AND BOTH CAPS, because the asset is 2400x960 — wider than 2:1. A
 * plain `width:100%` under a capped height, or an `object-fit:cover`, slices the
 * rifle and rocket panels off the ends on any ordinary window, and the player
 * loses exactly the third of the card that explains the weapons.
 *
 * `max-width` IS IN `rem` so the image stops growing once it is comfortably
 * readable: 2400 physical pixels stretched across a 4K display is soft, and a
 * card of instructions has no reason to be the biggest thing anybody sees.
 *
 * `pointer-events:none` BECAUSE IT SITS OVER THE BUTTON'S COLUMN. A full-width
 * image is precisely the element that lands on a centred control — `briefing.ts`
 * records this game already shipping one unclickable button, and ticket 073
 * avoided the mirror image of it with the poppies.
 */
export const CONTROLS_IMAGE_STYLE = [
  'display:block',
  'max-width:min(72rem, 100%)',
  'max-height:60vh',
  'width:auto',
  'height:auto',
  'object-fit:contain',
  'pointer-events:none',
  'user-select:none',
].join(';')

export interface ControlsOptions {
  /** On to Boot Hill. The chart decides where that is, not this screen. */
  readonly onContinue: () => void
}

export interface ControlsScreen {
  /** Take the screen down and stop the button firing. Safe to call twice. */
  dispose(): void
}

export function createControlsCard(mount: HTMLElement, options: ControlsOptions): ControlsScreen {
  // The title is set in the display face and this can be the second screen the
  // page ever shows. Fire and forget — see `display-font.ts`.
  loadDisplayFont()

  // THE SHARED CHROME IS USED FOR ITS ROLE AND LABEL, then overdrawn: it gives
  // the dialog semantics every campaign screen has, and this screen's own black
  // replaces its translucent dim. See `CONTROLS_BACKDROP_STYLE`.
  const { backdrop } = createChrome('Controls')
  backdrop.style.cssText = CONTROLS_BACKDROP_STYLE

  const heading = document.createElement('h1')
  heading.textContent = CONTROLS_TITLE
  heading.style.cssText = CONTROLS_TITLE_STYLE

  const picture = document.createElement('img')
  picture.src = instructionsUrl
  // A REAL DESCRIPTION AND NOT `alt=''`. The poppies on the memorial are
  // decoration and are correctly silent; this image IS the content of the
  // screen, and a player who cannot see it would otherwise be told nothing at
  // all about how to play.
  picture.alt =
    'Left click to move. Right click to fire rifle. Click an icon for rifle, grenade or rocket.'
  picture.draggable = false
  picture.style.cssText = CONTROLS_IMAGE_STYLE

  const button = createButton(CONTROLS_CONTINUE_LABEL)
  // The shared button aligns itself to the left of a reading column; this screen
  // is a centred card, so it gives that up.
  button.style.alignSelf = 'auto'
  button.style.margin = '0'

  let done = false
  button.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — a detached button can still be clicked by anything holding
    // a reference to it. `boot-hill.ts` and `menu.ts` pay for the same lesson.
    if (done) return
    options.onContinue()
  })

  backdrop.append(heading, picture, button)
  mount.append(backdrop)

  return {
    dispose(): void {
      if (done) return
      done = true
      backdrop.remove()
    },
  }
}
