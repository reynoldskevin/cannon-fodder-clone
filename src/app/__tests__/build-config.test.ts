import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import config from '../../../vite.config'

/**
 * Ticket 081 — the production build does not ship its sourcemaps.
 *
 * WHAT THIS IS ACTUALLY PROTECTING. `sourcemap: true` emitted a 4.25 MB
 * `index.js.map` next to a 667 kB bundle: the map was six times the size of the
 * code it described and 15% of everything in `dist`. No player ever downloaded a
 * byte of it — browsers fetch a `.map` only with devtools open — so the cost was
 * the upload and the per-deployment storage, every deploy, forever.
 *
 * AND IT IS A ONE-CHARACTER REVERT. `sourcemap: true` is what Vite's own examples
 * show and what a future edit reaches for by reflex, and nothing in the build
 * output complains: the deploy just gets quietly bigger again until somebody
 * measures `dist` a second time. That is the whole reason the decision is pinned
 * here rather than left to a comment.
 */

describe('the production build config', () => {
  it('does not emit sourcemaps', () => {
    /**
     * `false`, NOT `'hidden'`. Hidden still WRITES the map into `dist` and only
     * strips the `//# sourceMappingURL` comment — it drops the browser's ability
     * to use the map while keeping every byte of the upload, which is the exact
     * reverse of the trade this ticket is making. Asserting the literal keeps
     * that distinction, where `toBeFalsy()` would accept `'hidden'` and
     * `undefined` alike.
     */
    expect(config.build?.sourcemap).toBe(false)
  })

  it('states the choice rather than leaning on a default', () => {
    /**
     * NON-VACUITY, AND IT IS NOT THEORETICAL HERE. Vite's default for
     * `build.sourcemap` is already `false`, so deleting the line entirely would
     * leave the case above passing on `undefined`... except `toBe(false)` rejects
     * `undefined`, which is half the guard. This is the other half: the key has to
     * be WRITTEN DOWN, so the next person reads a decision instead of an absence
     * and cannot mistake "nobody chose" for "somebody chose no".
     */
    const source = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/sourcemap:\s*false/)
  })
})
