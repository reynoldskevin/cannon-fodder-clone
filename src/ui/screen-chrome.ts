/**
 * THE CHROME EVERY CAMPAIGN SCREEN SHARES (ticket 022b).
 *
 * Ticket 022b added four screens at once — Menu, Recruitment, Briefing, Debrief
 * — and each of them was the same dimmed backdrop, the same panel and the same
 * button as `boot-hill.ts`, which the player walks through in one sitting. Four
 * copies of a twelve-line `cssText` is four things to keep in step, and the
 * first one that drifts is the one screen in the run that looks like a different
 * game. So the panel is built once here and the screens hold only what they say.
 *
 * TICKET 040 LEFT IT WITH TWO CALLERS; TICKET 043 GAVE IT THREE AND MADE IT THE
 * SURFACE ITSELF. The Menu and Boot Hill used to be a dimmed panel over the live
 * level while the Briefing hand-rolled a full-bleed black card — two answers to
 * "what does a campaign screen look like", and the player met both inside thirty
 * seconds. The Briefing's answer won: this file now hands out that surface, and
 * all three screens are built from it.
 *
 * SO THE FILE IS NO LONGER OPTIONAL. While it only supplied a shared look, a
 * screen could quietly opt out by transcribing its own styles — which Boot Hill
 * did, and which is why the memorial could have stayed translucent after the
 * shared value was fixed. `screen-chrome.test.ts` pins that at source level.
 *
 * IT DECIDES NOTHING AND HOLDS NOTHING. No callbacks, no state, no model — it
 * makes elements and hands them back. Everything that could be wrong about a
 * screen is in the screen; this file can only be ugly.
 *
 * THE VALUES ARE `hud.ts`'S AND `boot-hill.ts`'S, unchanged, so the game has one
 * palette. Those two are left alone rather than converted: the HUD's panel is a
 * different shape (a corner readout, not a modal) and Boot Hill is shipped,
 * tested-by-eye code that this ticket has no reason to touch.
 *
 * DOM APIs and inline styles, matching the rest of `src/ui`, so the UI layer
 * ships no stylesheet.
 */

export const TEXT = '#f2efe6'
export const MUTED = '#9fb3bd'
/** A win, a promotion, a man who came home. */
export const GOOD = '#8fd694'
/** A loss, a fresh grave, a refusal. The same warm one the lose screen used. */
export const BAD = '#ff8f6b'

/**
 * The surface a campaign screen IS (ticket 043).
 *
 * OPAQUE, AND THAT IS THE WHOLE CHANGE. This was `rgba(9,11,13,0.82)`, so the
 * terrain and the squad showed through the start screen and through Boot Hill —
 * they read as panels floating over the level rather than as screens of their
 * own. The stage is built during `boot()` BEFORE the router mounts anything, so
 * this was true on the very first frame of the game, not only between missions.
 *
 * A DARKER TRANSLUCENT VALUE WOULD NOT DO. `rgba(0,0,0,0.98)` looks black and is
 * still a veil; the mission card has always been `#000` and the other two now
 * say the same word.
 *
 * EXPORTED so it can be read in a test. `vitest` runs with `environment: 'node'`
 * and there is no jsdom, which is why `src/ui` has no tests: every screen calls
 * `document.createElement` immediately. This module's BODY touches no DOM, so
 * putting the decision in a plain string here is what makes it checkable at all.
 */
export const BACKDROP_STYLE = [
  'position:fixed',
  'inset:0',
  'z-index:60',
  'display:flex',
  'flex-direction:column',
  'align-items:flex-start',
  'justify-content:center',
  // The mission card's own padding, so the three screens indent their text to
  // the same place and the campaign does not appear to shift under the player.
  'padding:2rem clamp(2rem, 12vw, 10rem)',
  'background:#000',
  'font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
  'color:' + TEXT,
  // The screen sits over the canvas, and a click that lands on the backdrop is a
  // click the player meant for nothing. Only the content column takes input —
  // see below — so a stray press cannot be swallowed by a full-bleed div, which
  // is the failure `hud.ts` guards against for the same reason. Still true now
  // the backdrop is opaque: what changed is whether you can see through it, not
  // whether it should eat clicks.
  //
  // IT IS ALSO WHY EVERY SCREEN MUST PUT ITS CONTENT IN THE COLUMN AND NOT ON
  // THE BACKDROP DIRECTLY. `pointer-events` inherits, so a button appended
  // straight onto this div is a button that cannot be clicked. The Briefing did
  // exactly that while it owned its own backdrop — which had no such rule — and
  // moving it onto the shared one disabled its Start button until it was moved
  // into the column with the others. Nothing in the type system says this; it is
  // caught by clicking the button.
  'pointer-events:none',
].join(';')

/**
 * Where a screen's own content goes.
 *
 * NOT A PANEL ANY MORE, AND THE NAME IS A HOLDOVER. It was a bordered card on
 * `rgba(13,16,18,0.94)`; it is now a bare column with no fill and no border, so
 * the text sits directly on the black exactly as the mission card's always has.
 * The `Chrome` shape is kept so the callers did not all have to change at once —
 * but a field called `panel` that is not a panel is worth saying out loud rather
 * than leaving for the next reader to discover.
 */
export const PANEL_STYLE = [
  'display:flex',
  'flex-direction:column',
  'gap:1.25rem',
  'width:min(46rem, 100%)',
  'max-height:100%',
  // Re-enabled for the column alone: the buttons inside it have to be clickable.
  'pointer-events:auto',
].join(';')

export const LIST_STYLE =
  'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.35rem'

/** A screen's outer two elements: the dimmed backdrop, and the panel on it. */
export interface Chrome {
  /** Append to the mount; remove to take the whole screen down. */
  readonly backdrop: HTMLElement
  /** Where a screen's own content goes. */
  readonly panel: HTMLElement
}

/**
 * Build the backdrop and panel for one screen.
 *
 * `aria-modal="false"` deliberately, as Boot Hill has it: the canvas underneath
 * is still there and still being drawn, and claiming a modal would tell a screen
 * reader the rest of the page had gone away when it has not.
 */
export function createChrome(label: string): Chrome {
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'false')
  backdrop.setAttribute('aria-label', label)
  backdrop.style.cssText = BACKDROP_STYLE

  const panel = document.createElement('div')
  panel.style.cssText = PANEL_STYLE
  backdrop.append(panel)

  return { backdrop, panel }
}

/** The screen's title, in the one style all four use. */
export function createHeading(text: string): HTMLElement {
  const heading = document.createElement('h1')
  heading.textContent = text
  heading.style.cssText = 'margin:0;font-size:1.5rem;letter-spacing:0.06em;text-transform:uppercase'
  return heading
}

/**
 * The one button on a screen that moves the flow along.
 *
 * `type="button"` matters: an unset type inside a form is a submit button, and a
 * submit reloads the page — which on this game means losing the mission.
 */
export function createButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.style.cssText = [
    'align-self:flex-start',
    'margin-top:0.25rem',
    'padding:0.55rem 1.5rem',
    'border:1px solid rgba(159,179,189,0.55)',
    'border-radius:6px',
    'background:transparent',
    `color:${TEXT}`,
    'font:inherit',
    'cursor:pointer',
  ].join(';')
  return button
}

/**
 * A line the player only sometimes gets: a refusal, a persistence notice.
 *
 * HIDDEN WHEN EMPTY rather than left as a blank row, so a screen that has
 * nothing to report does not show a gap where a warning goes and invite the
 * player to wonder what it said.
 */
export function createNotice(colour: string): HTMLElement {
  const notice = document.createElement('p')
  notice.style.cssText = `margin:0;color:${colour};display:none`
  return notice
}

/** Put `text` on a notice, or take it off screen when there is nothing to say. */
export function setNotice(node: HTMLElement, text: string | null): void {
  setText(node, text ?? '')
  const display = text === null || text === '' ? 'none' : 'block'
  if (node.style.display !== display) node.style.display = display
}

/** Write `text` into `node` only when it has actually changed. See `hud.ts`. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}
