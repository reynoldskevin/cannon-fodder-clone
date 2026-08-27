import { describe, it, expect } from 'vitest'
import { NAME_POOL, issueNames } from '../names'

/**
 * Ticket 045 — the pool is the supplied sheet, and the invariants `names.ts`
 * states about it are real.
 *
 * THE INVARIANTS WERE ONLY PROSE BEFORE THIS FILE. `names.ts` has always said the
 * pool "must never contain a duplicate or a name already ending in a numeral",
 * and nothing checked either. That was survivable while the pool was thirty
 * hand-written surnames a reader could scan; it is not survivable now it is 347
 * rows imported from a spreadsheet that DID contain thirteen repeats. The
 * dedupe happened at import time, once, and a later re-import or hand-edit is
 * exactly the thing that would quietly reintroduce them.
 *
 * A duplicate is not cosmetic. `issueNames` hands out by index and the campaign
 * never cross-checks the dead, so two identical entries put two identical
 * gravestones on Boot Hill and make the promotion list ambiguous — the failure
 * the whole module is built to prevent.
 */

describe('the pool is the sheet', () => {
  it('opens on the sheet`s first rows, in the sheet`s order', () => {
    // Provenance, as evidence rather than as a claim in a comment. These are rows
    // 1-5 of `recruit_names.csv`; a pool that had drifted back to invented
    // surnames, or been re-sorted, fails here.
    expect(NAME_POOL.slice(0, 5)).toEqual(['JOOLS', 'JOPS', 'STOO', 'RJ', 'UBIK'])
  })

  it('and ends on its last ones', () => {
    // The tail matters as much as the head: a truncated paste would keep the
    // opening intact and lose everything after it.
    expect(NAME_POOL.slice(-4)).toEqual(['GONNER', 'WASTER', 'LOSER', 'FODDER'])
  })

  it('holding every row the sheet has, less its repeats', () => {
    // 360 rows, 13 of them a name that already appeared. Pinned as a number
    // because "some names" would pass on a pool of six.
    expect(NAME_POOL).toHaveLength(347)
  })
})

describe('the pool honours what names.ts promises about it', () => {
  it('contains no duplicate, compared the way a reader would', () => {
    /**
     * CASE-INSENSITIVELY, and not because the sheet mixes case — it does not.
     * `Baker` and `BAKER` are one man on a gravestone, so a re-import that
     * title-cased half the rows would be a duplicate the moment it landed, and an
     * exact-match check would wave it through.
     */
    const seen = NAME_POOL.map((name) => name.toUpperCase())
    expect(new Set(seen).size).toBe(NAME_POOL.length)
  })

  it('and no entry that ends in a numeral', () => {
    // The generation suffix is `NAME II`. A pool entry already ending in one
    // would collide with a suffixed form of some other name and reintroduce the
    // ambiguity by the back door.
    const numeral = NAME_POOL.filter((name) => /[0-9]$| [IVXLC]+$/.test(name))
    expect(numeral).toEqual([])
  })

  it('and nothing blank or padded', () => {
    // A blank renders as an empty gravestone; leading space is a name that sorts
    // and truncates differently from the one next to it that looks identical.
    const wrong = NAME_POOL.filter((name) => name.trim() !== name || name.length === 0)
    expect(wrong).toEqual([])
  })

  it('and every name short enough to survive a roster row', () => {
    /**
     * THE FIELD IS NARROW AND THE OLD COMMENT KNEW IT — "deliberately short
     * surnames: these are rendered into a roster row and onto a gravestone, and a
     * long name is a truncated name on both". The sheet's longest is six
     * characters, so 12 is slack rather than a limit anything is up against; it
     * catches a future paste that brought a full name or a rank along with it.
     */
    const long = NAME_POOL.filter((name) => name.length > 12)
    expect(long).toEqual([])
  })

  it('and no rank riding along with a name', () => {
    /**
     * THE ONE THE SHEET COULD ACTUALLY HAVE CAUSED. The brief was to take the
     * name column ALONE — the sheet has four other columns, and a name imported
     * as `2 JOOLS` or `PVT JOOLS` would read as a name everywhere in the game and
     * be wrong on every screen. Every entry is a single bare word.
     */
    const compound = NAME_POOL.filter((name) => !/^[A-Za-z]+$/.test(name))
    expect(compound).toEqual([])
  })
})

describe('issuing names off the bigger pool', () => {
  it('gives distinct names well past exhaustion', () => {
    // The property `names.ts` exists for, re-checked at the new size: past the end
    // the generation suffix takes over, and it must not repeat either.
    const names = issueNames(11, 0, NAME_POOL.length * 2 + 5)
    expect(new Set(names).size).toBe(names.length)
  })

  it('and the same seed still gives the same roster', () => {
    // A player reloading a save must get his squad back, not strangers. The pool
    // changed; the promise did not.
    expect(issueNames(7, 0, 8)).toEqual(issueNames(7, 0, 8))
  })

  it('while two seeds give two different ones', () => {
    // Otherwise "seeded" is indistinguishable from "hardcoded" — and with 347
    // names the shuffle has far more room to prove it than it had with 30.
    expect(issueNames(1, 0, 12)).not.toEqual(issueNames(2, 0, 12))
  })
})
