/**
 * Fatal-error overlay.
 *
 * A black canvas is the failure mode this exists to prevent: if the level cannot
 * be fetched, fails validation, or WebGL is unavailable, the player must be told
 * WHICH of those happened, on screen, without opening devtools.
 *
 * Built with DOM APIs rather than `innerHTML` so an error message that happens
 * to contain markup (a server's HTML 404 page, say) is shown as text.
 */

export interface FatalErrorReport {
  /** Short headline, e.g. 'Could not load level 1'. */
  readonly title: string
  /** What actually went wrong, in the user's words as far as possible. */
  readonly detail: string
  /** Optional technical line: URL, field path, validation code. */
  readonly technical?: string
  /**
   * Optional recovery button.
   *
   * Some failures are worth retrying (a lost WebGL context usually comes back on
   * a reload); a malformed level file is not. The caller decides, so the overlay
   * never offers an action that cannot work.
   */
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

export function showFatalError(mount: HTMLElement, report: FatalErrorReport): void {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'alert')
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:100',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:0.75rem',
    'padding:2rem',
    'background:#161a1d',
    'color:#f2efe6',
    'font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
    'text-align:center',
  ].join(';')

  const heading = document.createElement('h1')
  heading.textContent = report.title
  heading.style.cssText = 'margin:0;font-size:1.5rem;color:#ff8f6b'

  const detail = document.createElement('p')
  detail.textContent = report.detail
  detail.style.cssText = 'margin:0;max-width:46rem'

  overlay.append(heading, detail)

  if (report.technical !== undefined && report.technical !== '') {
    const technical = document.createElement('pre')
    technical.textContent = report.technical
    technical.style.cssText = [
      'margin:0',
      'max-width:46rem',
      'overflow-x:auto',
      'padding:0.75rem 1rem',
      'border-radius:6px',
      'background:#0d1012',
      'color:#9fb3bd',
      'font:13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-align:left',
      'white-space:pre-wrap',
    ].join(';')
    overlay.append(technical)
  }

  if (report.action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = report.action.label
    button.style.cssText = [
      'margin-top:0.5rem',
      'padding:0.6rem 1.4rem',
      'border:1px solid #ff8f6b',
      'border-radius:6px',
      'background:transparent',
      'color:#f2efe6',
      'font:inherit',
      'cursor:pointer',
    ].join(';')
    button.addEventListener('click', report.action.onClick)
    overlay.append(button)
  }

  mount.append(overlay)
}
