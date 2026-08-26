/**
 * Where a soldier's name comes from (ticket 019).
 *
 * A NAME IS NEVER REISSUED, AND THAT IS A REAL CONSTRAINT rather than a
 * nicety. The pool is finite and a campaign outlives it — five levels of
 * casualties will run through thirty names — so a generator that picked at
 * random, or that wrapped around when the pool ran dry, would eventually put
 * two identical gravestones on Boot Hill. Boot Hill is a list of names; two
 * stones reading the same thing destroys the one screen this whole ticket
 * exists to feed, and makes the promotion list ambiguous on the way.
 *
 * So names are ISSUED BY INDEX, not drawn:
 *
 *   - The pool is shuffled once, deterministically, from the campaign's seed.
 *     Same seed, same roster — a returning player must get his squad back, not
 *     a set of strangers wearing his save file. Two different seeds give two
 *     different rosters, or "seeded" would be indistinguishable from
 *     "hardcoded".
 *   - The campaign remembers how many men it has EVER recruited and issues the
 *     next index. That counter only rises, so a dead man's name is never handed
 *     to a living one — no cross-check against the dead list is needed, which
 *     means there is no cross-check to forget.
 *   - Past the end of the pool the name gets a generation suffix (`Jones II`,
 *     `Jones III`) rather than repeating. Ugly is survivable; ambiguous is not.
 *
 * Randomness is SEEDED (`core/world/prng`). `Math.random` here would break the
 * reload promise above, and is asserted against by the purity suite.
 */

import { createRng } from '../world/prng'
import type { Rng } from '../world/prng'

/**
 * The pool. Plain data, deliberately dull, deliberately short surnames: these
 * are rendered into a roster row and onto a gravestone, and a long name is a
 * truncated name on both.
 *
 * ADD TO IT FREELY — nothing derives a count from its length, and a longer pool
 * simply delays the first generation suffix. It must never contain a duplicate
 * or a name already ending in a numeral, either of which would collide with a
 * suffixed form and reintroduce exactly the ambiguity this file exists to stop.
 */
export const NAME_POOL: readonly string[] = [
  'Baker',
  'Nowak',
  'Fletcher',
  'Ashby',
  'Sokolov',
  'Whitlock',
  'Cronin',
  'Vasquez',
  'Doyle',
  'Marchetti',
  'Hargreaves',
  'Okonkwo',
  'Renshaw',
  'Kovac',
  'Pike',
  'Delaney',
  'Mercer',
  'Halloran',
  'Bright',
  'Yates',
  'Novak',
  'Strand',
  'Faulkner',
  'Rhodes',
  'Ackroyd',
  'Lindqvist',
  'Farrow',
  'Bellamy',
  'Grimes',
  'Weatherby',
]

/** Roman numeral pieces, largest first. Enough for any campaign a player finishes. */
const NUMERALS: readonly (readonly [number, string])[] = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

/**
 * Roman numerals, because `Jones II` reads as a second man of that name while
 * `Jones 2` reads as a bug. Large generations degrade to a long string of `X`s
 * rather than to nothing, which stays unique — the only property that matters.
 */
function roman(value: number): string {
  let left = Math.max(1, Math.floor(value))
  let out = ''
  for (const [amount, symbol] of NUMERALS) {
    while (left >= amount) {
      out += symbol
      left -= amount
    }
  }
  return out
}

/**
 * Fisher-Yates over a copy. In place on the pool itself would make the module
 * constant differ between two campaigns in the same session, which is a
 * cross-campaign leak that no test in this ticket would catch.
 */
function shuffled(pool: readonly string[], rng: Rng): string[] {
  const out = [...pool]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1)
    const here = out[i]
    const there = out[j]
    // Both are in range by construction; the guard is what `noUncheckedIndexedAccess`
    // costs, and skipping a swap is safer than asserting a non-null.
    if (here === undefined || there === undefined) continue
    out[i] = there
    out[j] = here
  }
  return out
}

/**
 * `count` names for the men numbered `fromIndex` onwards in a campaign seeded
 * with `seed`. Pure: the same arguments always give the same names, which is
 * what lets recruitment be replayed from a save that stores only a seed and a
 * counter.
 */
export function issueNames(seed: number, fromIndex: number, count: number): string[] {
  const order = shuffled(NAME_POOL, createRng(seed))
  const names: string[] = []
  for (let n = 0; n < count; n += 1) {
    const index = fromIndex + n
    // `?? 'Soldier'` is unreachable with a non-empty pool and exists only to
    // satisfy the index-may-be-undefined rule; an empty pool would make every
    // name identical, which is why the pool above must never be emptied.
    const base = order[index % order.length] ?? 'Soldier'
    const generation = Math.floor(index / order.length)
    names.push(generation === 0 ? base : `${base} ${roman(generation + 1)}`)
  }
  return names
}
