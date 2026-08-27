import { describe, it, expect } from 'vitest'
import { RANKS, rankFor, rankIndexFor, insigniaIndexOf } from '../ranks'

/**
 * Ticket 062 — sixteen rungs, one per mission.
 *
 * THE LADDER WAS SIX RUNGS WITH WIDENING GAPS and Major was twenty survived
 * victories up, which most campaigns never reach — the top half of the table
 * was tuning nobody ever saw. It is now sixteen rungs at one mission each: live
 * through a mission, take the next rank.
 *
 * THE ARTWORK IS PART OF THE CONTRACT NOW. `rank-insignia-sheet.png` is an 8x2
 * grid of sixteen badges in ascending order, so the ladder's LENGTH is no longer
 * free — a seventeenth rung would be a rank with no badge and a fifteen-rung
 * ladder would leave one drawn for nobody. The tie between the two is asserted
 * in `src/ui/__tests__/rank-insignia.test.ts`, which is the only place that can
 * see both.
 */

describe('the ladder', () => {
  it('has sixteen rungs', () => {
    expect(RANKS).toHaveLength(16)
  })

  it('starts at nothing, so a fresh recruit holds a rank', () => {
    // A ladder whose first rung required 1 would leave every new man rankless —
    // a blank where a name badge goes, rather than a design decision.
    expect(RANKS[0]?.missionsRequired).toBe(0)
  })

  it('and rises by exactly one mission a rung', () => {
    /**
     * THE WHOLE TICKET, AS ONE ASSERTION. Written as `i` rather than as
     * "previous + 1" so that a table which drifted and then corrected itself —
     * 0, 1, 2, 4, 5 — cannot pass by being locally right.
     */
    for (let i = 0; i < RANKS.length; i += 1) {
      expect({ i, at: RANKS[i]?.missionsRequired }).toEqual({ i, at: i })
    }
  })

  it('and every rung has a distinct name', () => {
    // Two rungs sharing a name is two badges for one title, and a promotion
    // whose announcement reads "Jools: Sergeant → Sergeant".
    expect(new Set(RANKS.map((r) => r.name)).size).toBe(RANKS.length)
  })
})

describe('the rank a record earns', () => {
  it('is the bottom rung at nothing survived', () => {
    expect(rankFor(0)).toBe(RANKS[0]?.name)
  })

  it('and goes up by one on every mission survived', () => {
    for (let n = 0; n < RANKS.length; n += 1) {
      expect({ n, rank: rankFor(n) }).toEqual({ n, rank: RANKS[n]?.name })
    }
  })

  it('and never runs off the end of the table', () => {
    /**
     * A man who outlasts the ladder holds its top rung, not `undefined` printed
     * into the HUD as the word "undefined". The old six-rung table made this a
     * remote case; sixteen rungs at one a mission make it one a long campaign
     * actually reaches.
     */
    const top = RANKS[RANKS.length - 1]?.name
    for (const n of [16, 17, 40, 1000]) expect(rankFor(n)).toBe(top)
  })

  it('and a nonsense record does not produce a nonsense rank', () => {
    // `missionsSurvived` is a number off a save a stranger can edit.
    for (const n of [-1, -100, Number.NaN]) expect(rankFor(n)).toBe(RANKS[0]?.name)
  })
})

describe('which rung it is, as a number', () => {
  it('agrees with the name at every step', () => {
    /**
     * `rankIndexFor` AND `rankFor` MUST NOT BE TWO ANSWERS. The badge is picked
     * by index and the title is printed from the name, so a pair that disagreed
     * would put a Sergeant's stripes beside the word "Corporal" — and nothing
     * else in the game would notice.
     */
    for (let n = -2; n < 20; n += 1) {
      expect({ n, name: RANKS[rankIndexFor(n)]?.name }).toEqual({ n, name: rankFor(n) })
    }
  })

  it('and is always a real index into the table', () => {
    for (const n of [-5, 0, 3, 15, 16, 500, Number.NaN]) {
      const index = rankIndexFor(n)
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(RANKS.length)
    }
  })

  it('and it is the mission count itself, up to the top', () => {
    // The plain reading of "one rank per mission", stated so the index is not
    // free to be some other monotonic function of the same record.
    for (let n = 0; n < RANKS.length; n += 1) expect(rankIndexFor(n)).toBe(n)
  })
})

describe('and the rung a RECORDED rank names', () => {
  /**
   * THE HALF THIS TICKET COULD MOST EASILY GET WRONG.
   *
   * A dead man's rank is RECORDED, never recomputed — `types.ts` argues it at
   * length: his record has stopped changing, so recomputation can only overwrite
   * a fact with a guess made under a newer table. So a gravestone's badge cannot
   * come from a mission count. It has to be looked up from the NAME on the
   * stone, and that name was written by whatever ladder was current when he fell.
   */
  it('finds every rank the ladder currently has', () => {
    for (let i = 0; i < RANKS.length; i += 1) {
      expect({ i, found: insigniaIndexOf(RANKS[i]?.name ?? '') }).toEqual({ i, found: i })
    }
  })

  it('and answers null for a rank this ladder does not have', () => {
    /**
     * NULL, NOT ZERO. A save written under the six-rung table can name a rank
     * that no longer exists, and falling back to index 0 would pin a private's
     * single chevron on a dead Major — silently, and on a memorial, which is the
     * worst screen in the game to be quietly wrong on. No badge is honest.
     */
    for (const missing of ['Field Marshal', 'private', 'PRIVATE', '', 'undefined']) {
      expect({ missing, found: insigniaIndexOf(missing) }).toEqual({ missing, found: null })
    }
  })

  it('and still knows every rank the OLD six-rung ladder could have written', () => {
    /**
     * THE MIGRATION, PINNED. These six names are what shipped before this ticket,
     * so they are the ones already sitting in players' saved games and carved on
     * their existing gravestones. Dropping any of them would turn a live save's
     * memorial blank one rank at a time — which the `null` above makes safe, but
     * safe is not the same as right.
     */
    for (const old of ['Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major']) {
      expect({ old, found: insigniaIndexOf(old) }).not.toEqual({ old, found: null })
    }
  })

  it('and the order the old ranks stood in has not been shuffled', () => {
    // They were ascending before and must still ascend: a table that kept all
    // six names but reordered them would demote every veteran on the hill.
    const order = ['Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major'].map(
      (name) => insigniaIndexOf(name),
    )
    for (let i = 1; i < order.length; i += 1) {
      expect(Number(order[i])).toBeGreaterThan(Number(order[i - 1]))
    }
  })
})
