/**
 * Control hint — one unobtrusive line telling the player how to move the camera.
 *
 * Deliberately temporary. A permanent HUD string sitting over the map is
 * clutter, and this is a discoverability aid, not a status readout: it fades out
 * on its own after a few seconds, and a click dismisses it early.
 *
 * Built with DOM APIs and inline styles, matching `error-overlay.ts`, so the
 * whole UI layer stays free of a stylesheet the build would have to ship.
 */

/** How long the hint stays fully visible before it starts to fade, in ms. */
const VISIBLE_MS = 7000

/** Fade duration, in ms. Kept in step with the CSS transition below. */
const FADE_MS = 900

export interface ControlHint {
  /** Remove the hint and cancel its pending timers. Safe to call twice. */
  dismiss(): void
}

export function showControlHint(mount: HTMLElement, text: string): ControlHint {
  const hint = document.createElement('div')
  hint.setAttribute('role', 'note')
  hint.textContent = text
  hint.title = 'Click to dismiss'
  hint.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:1.25rem',
    'transform:translateX(-50%)',
    'z-index:50',
    'max-width:calc(100vw - 2rem)',
    'padding:0.4rem 0.85rem',
    'border-radius:999px',
    'background:rgba(13,16,18,0.72)',
    'color:#9fb3bd',
    'font:13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    'text-align:center',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'cursor:pointer',
    'user-select:none',
    // Never eat a click meant for the game: the hint sits over the canvas.
    'pointer-events:auto',
    `transition:opacity ${String(FADE_MS)}ms ease`,
    'opacity:1',
  ].join(';')

  let removeTimer: ReturnType<typeof setTimeout> | undefined
  let dismissed = false

  const dismiss = (): void => {
    if (dismissed) return
    dismissed = true
    clearTimeout(fadeTimer)
    if (removeTimer !== undefined) clearTimeout(removeTimer)
    hint.remove()
  }

  hint.addEventListener('click', dismiss)

  const fadeTimer = setTimeout(() => {
    hint.style.opacity = '0'
    // Remove rather than leave a transparent element over the canvas — an
    // invisible hint that still swallows clicks is worse than a visible one.
    removeTimer = setTimeout(dismiss, FADE_MS)
  }, VISIBLE_MS)

  mount.append(hint)
  return { dismiss }
}
