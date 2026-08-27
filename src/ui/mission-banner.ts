/**
 * MISSION COMPLETE / MISSION FAILED, ACROSS THE LIVE FIELD (ticket 058).
 *
 * The three seconds `core/render-state/mission-end.ts` holds for are three
 * seconds of the mission still being on screen — the smoke, the bodies, the
 * river, whatever the last shot left. This layer goes over that and says which
 * way it went.
 *
 * SO IT IS NOT A SCREEN AND MUST NOT LOOK LIKE ONE. `screen-chrome.ts` hands out
 * an opaque black surface and all three campaign screens are built from it;
 * using it here would black out the field and turn the hold into an end screen
 * that merely arrives three seconds late — strictly worse than the instant cut
 * this replaces, because the player would be looking at nothing for longer. This
 * layer has no background at all. The words are made legible by a shadow.
 *
 * IT SWALLOWS NOTHING. `pointer-events:none`, because a live mission is
 * underneath and the player is still holding a mouse. `briefing.ts` records the
 * matching bug from the other direction — the shared backdrop's
 * `pointer-events:none` inherited into a button and made it unclickable. Here
 * there is nothing to click and the inheritance is what is wanted.
 *
 * DOM APIs and inline styles, matching the rest of `src/ui`, so the UI layer
 * ships no stylesheet.
 *
 * THE MODULE BODY TOUCHES NO DOM. The two styles below are plain strings so
 * `mission-banner.test.ts` can import and read them under Vitest's `node`
 * environment, which has no `document`. Same split `screen-chrome.ts` runs on.
 */

import { DISPLAY_FONT, loadDisplayFont } from './display-font'
import { TEXT } from './screen-chrome'

/**
 * The full-viewport layer the words are centred in.
 *
 * `fixed` and `inset:0` rather than anything in the flow: `mount` is the
 * canvas's container, so an element merely appended to it would land wherever
 * the layout left off. NO `background` — see the header.
 */
export const BANNER_LAYER_STYLE = [
  'position:fixed',
  'inset:0',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'pointer-events:none',
  /**
   * ABOVE THE HUD AND BELOW THE CAMPAIGN SCREENS.
   *
   * SPELLED OUT RATHER THAN LEFT TO TIE. The HUD is also `z-index:40`, and a tie
   * is broken by document order — which this layer happens to win, because it is
   * appended when it is shown and the HUD was appended at boot. That is a
   * correct result reached by accident, and it would invert the first time
   * anything re-appended the HUD. 41 says it on purpose.
   *
   * The numbers above it are all things that SHOULD cover the result: the debug
   * overlay (45), the control hint (50), a campaign screen (60) and the fatal
   * error overlay (100). The banner is gone before a screen mounts anyway — the
   * transition takes it down on the same frame — but the ordering should not
   * depend on that being true.
   */
  'z-index:41',
].join(';')

/**
 * The words.
 *
 * LARGER THAN ANYTHING ELSE IN THE GAME — the briefing's title tops out at
 * 3.58rem and this beats it, because it is the one line the player reads from
 * across the room rather than leans in for. The `clamp` scales it on the
 * viewport's width so it fills a phone and a monitor alike without a media
 * query, and the upper bound stops it running off a very wide screen.
 *
 * THE SHADOW IS WHAT REPLACES THE PANEL. Jungle, river and sand all pass under
 * this text and none of them is a reliable backdrop for a light face; two
 * stacked dark shadows hold the letterforms against all three.
 */
export const BANNER_TEXT_STYLE = [
  'margin:0',
  `color:${TEXT}`,
  `font-family:${DISPLAY_FONT}`,
  'font-size:clamp(2.6rem, 11vw, 6.5rem)',
  'letter-spacing:0.08em',
  'line-height:1.1',
  'text-align:center',
  'padding:0 1rem',
  'text-shadow:0 0.06em 0.12em rgba(0,0,0,0.95), 0 0 0.5em rgba(0,0,0,0.8)',
].join(';')

export interface MissionBanner {
  /** Put the words up, or take them down when handed `null`. */
  show(text: string | null): void
  dispose(): void
}

/**
 * Build the layer once and drive it by text.
 *
 * MADE ONCE AT BOOT AND KEPT, rather than mounted and disposed per mission. The
 * render loop asks the hold for its banner on EVERY frame — including the many
 * thousands where the answer is `null` — and a factory called from there would
 * be building and destroying elements at 60 Hz. `show` writes only when the text
 * actually changes, so the steady state is a string comparison.
 */
export function createMissionBanner(mount: HTMLElement): MissionBanner {
  // The display face, asked for on the way up rather than at boot, the way
  // every other screen that uses it does. Nothing waits for it: the words are
  // painted in the fallback and reflow when it lands. See `display-font.ts`.
  loadDisplayFont()

  const layer = document.createElement('div')
  layer.style.cssText = BANNER_LAYER_STYLE
  // ANNOUNCED, because the words are the whole result of the mission and a
  // player using a screen reader gets no other telling of it — the cue is a
  // sound and the field is a canvas. `assertive` rather than `polite`: there are
  // three seconds before the screen changes underneath it.
  layer.setAttribute('role', 'status')
  layer.setAttribute('aria-live', 'assertive')

  const words = document.createElement('p')
  words.style.cssText = BANNER_TEXT_STYLE
  layer.append(words)

  /**
   * What is on screen now.
   *
   * TRACKED HERE RATHER THAN READ BACK OFF THE ELEMENT. `show` is called every
   * frame; comparing against a local is a string comparison, while asking the
   * DOM for `textContent` is a DOM read on a node the compositor may be using.
   */
  let showing: string | null = null
  let attached = false

  return {
    show(text) {
      if (text === showing) return
      showing = text
      if (text === null) {
        if (attached) {
          layer.remove()
          attached = false
        }
        return
      }
      words.textContent = text
      if (!attached) {
        mount.append(layer)
        attached = true
      }
    },
    dispose() {
      layer.remove()
      attached = false
      showing = null
    },
  }
}
