/**
 * The win and lose screens (ticket 013).
 *
 * The one thing on screen that says the mission is over, and the only way back
 * into a new one. It is deliberately thin: WHICH screen to show is
 * `Session.outcome()`'s answer, decided in `src/core/objectives` and tested
 * under Node; this file knows how to draw two variants of a panel and how to
 * call back when the player wants another go.
 *
 * DOM APIs and inline styles, matching `error-overlay.ts` and `hud.ts`, so the
 * UI layer ships no stylesheet.
 *
 * IT DOES NOT COVER THE WHOLE SCREEN. The sim keeps stepping after the mission
 * ends — the death animation of the man who won it is still playing — and a
 * full-bleed overlay would hide the thing the player is being congratulated
 * for. It is a panel over a dimmed map, and the map keeps moving behind it.
 */

import { formatMissionTime } from './hud'

/** Which of the two screens this is. Mirrors `MissionOutcome`'s two end states. */
export type MissionEndKind = 'complete' | 'failed'

export interface MissionEndOptions {
  readonly kind: MissionEndKind
  /** Why the mission was lost, from `MissionFailed.reason`. Ignored on a win. */
  readonly reason?: string
  /** The mission's length, in simulation ticks — never a wall clock. */
  readonly elapsedTicks: number
  /** Start a new mission. The app rebuilds the session; the page is not reloaded. */
  readonly onRestart: () => void
}

export interface MissionEndScreen {
  /** Take the screen down. Safe to call twice. */
  dispose(): void
}

const WON = '#8fd694'
const LOST = '#ff8f6b'

export function showMissionEnd(mount: HTMLElement, options: MissionEndOptions): MissionEndScreen {
  const won = options.kind === 'complete'
  const accent = won ? WON : LOST

  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'false')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:60',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:2rem',
    // Dimmed rather than opaque: the mission is still playing out behind this.
    'background:rgba(9,11,13,0.55)',
    'font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
    'color:#f2efe6',
    'text-align:center',
  ].join(';')

  const panel = document.createElement('div')
  panel.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:0.75rem',
    'min-width:min(24rem, 100%)',
    'padding:1.75rem 2.25rem',
    'border-radius:10px',
    `border:1px solid ${accent}`,
    'background:rgba(13,16,18,0.94)',
  ].join(';')

  const heading = document.createElement('h1')
  heading.textContent = won ? 'Mission complete' : 'Mission failed'
  heading.style.cssText = `margin:0;font-size:1.6rem;color:${accent}`

  const detail = document.createElement('p')
  detail.textContent = won
    ? `Every objective met in ${formatMissionTime(options.elapsedTicks)}.`
    : (options.reason ?? 'The mission was lost.')
  detail.style.cssText = 'margin:0;max-width:30rem;color:#9fb3bd'

  const restart = document.createElement('button')
  restart.type = 'button'
  restart.textContent = 'Play again'
  restart.style.cssText = [
    'margin-top:0.5rem',
    'padding:0.6rem 1.6rem',
    `border:1px solid ${accent}`,
    'border-radius:6px',
    'background:transparent',
    'color:#f2efe6',
    'font:inherit',
    'cursor:pointer',
  ].join(';')

  let done = false
  const dispose = (): void => {
    if (done) return
    done = true
    backdrop.remove()
  }

  restart.addEventListener('click', () => {
    // The screen goes first, so a restart that throws leaves the error overlay
    // visible rather than buried under a dialog for a mission that is over.
    dispose()
    options.onRestart()
  })

  panel.append(heading, detail, restart)
  backdrop.append(panel)
  mount.append(backdrop)
  // Focused, so the keyboard alone can start the next mission — and so the
  // player's next click does not go to the map underneath by accident.
  restart.focus()

  return { dispose }
}
