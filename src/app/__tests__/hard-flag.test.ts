import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { difficultyFromSearch } from '../difficulty-flag'

/**
 * Ticket 093 — `?hard=1`, and nothing else, selects the hard enemy.
 *
 * PARSED BY A PURE FUNCTION TAKING A STRING, not by reading `window.location`
 * where it is used. `vitest.config.ts` sets `environment: 'node'` and there is
 * no jsdom in this repo, so a flag read inline from `window` is a flag no test
 * can reach — which is how `?demo=1&level=N` ended up unwired and unnoticed.
 * The function takes the search string; `main.ts` is the only thing that knows
 * where search strings come from.
 */

describe('the flag is opt-in and exact', () => {
  it('selects hard for exactly `?hard=1`', () => {
    expect(difficultyFromSearch('?hard=1')).toBe('hard')
    expect(difficultyFromSearch('?level=2&hard=1')).toBe('hard')
    expect(difficultyFromSearch('?hard=1&debug=1')).toBe('hard')
  })

  it('and normal for everything else, including the near misses', () => {
    /**
     * `=== '1'` RATHER THAN TRUTHINESS, matching `?debug=1` beside it. The near
     * misses are the point: a player who types `?hard` or `?hard=true` gets the
     * normal game, which is the safe direction for a flag whose whole purpose is
     * that the DEFAULT is untouched. A truthy check would make `?hard=0` — the
     * obvious way to write "off" — turn it ON.
     */
    for (const search of [
      '',
      '?',
      '?hard=0',
      '?hard=true',
      '?hard=yes',
      '?hard',
      '?hard=',
      '?hard=11',
      '?HARD=1',
      '?debug=1',
      '?nothard=1',
    ]) {
      expect({ search, difficulty: difficultyFromSearch(search) }).toEqual({
        search,
        difficulty: 'normal',
      })
    }
  })

  it('and tolerates a search string with no leading question mark', () => {
    // `URLSearchParams` accepts both, and a caller passing `location.search` on a
    // URL with no query gets `''`. Stated so the tolerance is deliberate.
    expect(difficultyFromSearch('hard=1')).toBe('hard')
  })
})

describe('and main.ts actually uses it, at EVERY mission', () => {
  const main = (): string => readFileSync(new URL('../main.ts', import.meta.url), 'utf8')

  it('reads the flag from the real location', () => {
    /**
     * A CORRECT PARSER CAN SHIP UNWIRED, and this repo has done it — `?demo=1`
     * is parsed and reaches nothing. The pure function above cannot tell the
     * difference, so the source is read.
     */
    const source = main()
    expect(source).toContain('difficultyFromSearch')
    expect(source).toMatch(/difficultyFromSearch\(\s*window\.location\.search\s*\)/)
  })

  it('and hands it to EVERY createSession, not just the first', () => {
    /**
     * THE TRAP THIS TICKET IS MOST LIKELY TO FALL INTO. `main.ts` builds a
     * session twice: once for the opening mission and once per mission after it,
     * when the campaign runner advances. Wiring the difficulty into the first
     * alone gives a player who typed `?hard=1` one hard mission and then a
     * silent return to normal for the rest of the campaign — no error, no
     * failing test anywhere else, just a flag that stops working after two
     * minutes.
     */
    const calls = [...main().matchAll(/createSession\(([^)]*)\)/g)].map((m) => m[1] ?? '')
    expect(calls.length).toBeGreaterThan(1)
    for (const args of calls) {
      expect({ args, carries: args.includes('difficulty') }).toEqual({ args, carries: true })
    }
  })
})
