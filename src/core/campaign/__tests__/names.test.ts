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

describe('issuing names walks the pool in order', () => {
  it('the first men are the first rows, and Jools leads', () => {
    /**
     * THE TICKET. `issueNames` used to SHUFFLE the pool from the campaign's seed,
     * so a fresh campaign opened on whichever names that seed happened to deal.
     * The roll has an order of its own — Jools and Jops are the first two men —
     * and a fresh campaign now always starts there.
     */
    expect(issueNames(0, 5)).toEqual(['JOOLS', 'JOPS', 'STOO', 'RJ', 'UBIK'])
  })

  it('and the whole issue is the pool read straight through', () => {
    // Not just the head. A generator that special-cased the first two and dealt
    // the rest would pass the case above.
    expect(issueNames(0, 40)).toEqual(NAME_POOL.slice(0, 40))
  })

  it('picking up wherever the campaign had got to', () => {
    // Issued by an ever-rising counter, which is what makes recruitment
    // replayable from a save holding only that number.
    expect(issueNames(20, 3)).toEqual(NAME_POOL.slice(20, 23))
  })
})

describe('and the seed has nothing to do with it any more', () => {
  it('two campaigns get the same men, which is now the POINT', () => {
    /**
     * THIS INVERTS A RULE THIS FILE USED TO STATE. The case here read "two seeds
     * give two different ones", justified as "otherwise seeded is
     * indistinguishable from hardcoded" — a fair rule for a pool of thirty
     * invented surnames, where a fixed order would have made every campaign open
     * on Baker and Nowak for no reason anyone chose.
     *
     * It is the wrong rule for a roll that HAS an order. Ticket 045 replaced the
     * pool with the shipped one; 052 stopped shuffling it. Hardcoded is exactly
     * what is wanted, so the case is rewritten rather than deleted — a suite that
     * simply dropped it would leave the reversal unrecorded.
     */
    expect(issueNames(0, 12)).toEqual(issueNames(0, 12))
  })

  it('and reloading a save still returns the same squad', () => {
    // The promise the seed used to carry, which survives it: naming is a pure
    // function of the counter, so a save holding only that number replays it.
    expect(issueNames(6, 8)).toEqual(issueNames(6, 8))
  })
})

describe('and no name is ever reissued', () => {
  it('not even well past the end of the pool', () => {
    /**
     * THE PROPERTY THE MODULE EXISTS FOR, and it never depended on the shuffle —
     * it depends on the counter only ever rising. Past the end the generation
     * suffix takes over, and it must not repeat either.
     */
    const names = issueNames(0, NAME_POOL.length * 2 + 5)
    expect(new Set(names).size).toBe(names.length)
  })

  it('and the man after the last one is a second of that name, not the first again', () => {
    // The wrap point, stated exactly. `JOOLS` then `JOOLS II`, never `JOOLS`
    // twice — two identical gravestones is the failure the whole module prevents.
    const wrap = issueNames(NAME_POOL.length, 1)
    expect(wrap).toEqual([`${NAME_POOL[0] ?? ''} II`])
  })
})
