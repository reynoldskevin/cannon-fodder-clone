import type { Difficulty } from '../core/combat'

/**
 * Which difficulty a query string asks for (ticket 093).
 *
 * A PURE FUNCTION TAKING THE SEARCH STRING, not a read of `window.location`
 * where it is needed. `vitest.config.ts` sets `environment: 'node'` and this
 * repo has no jsdom, so a flag read inline from `window` is a flag no test can
 * reach — which is exactly how `?demo=1&level=N` came to be parsed, unwired and
 * unnoticed. Keeping the parse separate from the lookup means the rule below is
 * testable and `main.ts` is the only file that knows where a search string comes
 * from.
 *
 * `=== '1'`, MATCHING `?debug=1` BESIDE IT, and the strictness is the point. A
 * truthy check would turn `?hard=0` — the obvious way to write "off" — ON, and
 * this is a flag whose entire purpose is that the default is untouched. Anything
 * that is not exactly `1` means the normal game: `?hard`, `?hard=true`,
 * `?HARD=1`, a missing parameter, an empty search.
 *
 * WHAT IT SELECTS is the enemy of ticket 092 — the squad's eight tiles instead
 * of 6.4, and 40 ticks instead of 46. See `core/combat/weapons.ts`.
 */
export function difficultyFromSearch(search: string): Difficulty {
  return new URLSearchParams(search).get('hard') === '1' ? 'hard' : 'normal'
}
