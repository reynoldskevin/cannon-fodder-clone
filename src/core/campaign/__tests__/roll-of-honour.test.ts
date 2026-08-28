import { describe, it, expect } from 'vitest'
import { rollOfHonour } from '../roll-of-honour'
import type { Grave } from '../boothill'

/**
 * Ticket 073 — the fold behind the memorial.
 *
 * THE ONLY REAL LOGIC ON THE END SCREEN LIVES HERE, and that is the point of the
 * module existing. Vitest runs `environment: 'node'`; `src/ui/menu.ts` builds
 * `div`s and is unit-tested by nobody, so "group the dead by mission, newest
 * first" written inline in the renderer would be a rule verified by looking at
 * the screen and in no other way.
 *
 * A PURE SELECTOR OVER `CampaignSummary.fallen`, not a second read of
 * `CampaignState`. `campaignSummary` already folds the roster and the dead into
 * one shape both Boot Hill and the Menu agree on; a grouping that went back to
 * the state could disagree with the totals printed two lines above it.
 */

/** A gravestone, with only the fields under test spelled out per case. */
function grave(over: Partial<Grave> & Pick<Grave, 'name' | 'diedOnLevel'>): Grave {
  return {
    rankAtDeath: 'Private',
    rankIndex: 0,
    kills: 0,
    fresh: false,
    plot: 0,
    ...over,
  }
}

/**
 * A campaign that lost men on three missions, in the order the campaign records
 * them: oldest first, which is `state.dead`'s own append order.
 */
const CAMPAIGN: readonly Grave[] = [
  grave({ name: 'Jools', diedOnLevel: 1, kills: 3, rankAtDeath: 'Private', rankIndex: 0 }),
  grave({ name: 'Jops', diedOnLevel: 1, kills: 0, rankAtDeath: 'Private', rankIndex: 0 }),
  grave({ name: 'Donald', diedOnLevel: 2, kills: 7, rankAtDeath: 'Corporal', rankIndex: 2 }),
  grave({ name: 'Trevor', diedOnLevel: 5, kills: 1, rankAtDeath: 'Sergeant', rankIndex: 3 }),
  grave({ name: 'Kenny', diedOnLevel: 5, kills: 12, rankAtDeath: 'Private', rankIndex: 0 }),
]

describe('the roll reads newest mission first', () => {
  it('lists the missions in reverse, not the order they were fought', () => {
    /**
     * THE INVERSION THIS TICKET EXISTS FOR. The old screen printed one flat list
     * oldest-first, so the men the player had just lost were at the BOTTOM,
     * behind every mission he had already grieved over.
     */
    expect(rollOfHonour(CAMPAIGN).map((entry) => entry.level)).toEqual([5, 2, 1])
  })

  it('and a mission that cost nobody is not on it', () => {
    // Levels 3 and 4 were taken clean. A roll padded with empty missions would
    // read as a list of levels rather than a memorial.
    const levels = rollOfHonour(CAMPAIGN).map((entry) => entry.level)
    for (const clean of [3, 4]) {
      expect({ level: clean, listed: levels.includes(clean) }).toEqual({
        level: clean,
        listed: false,
      })
    }
  })
})

describe('each mission carries the men it cost', () => {
  it('names them, with the rank on the stone and what each of them killed', () => {
    const [latest] = rollOfHonour(CAMPAIGN)
    expect(latest?.dead).toEqual([
      { name: 'Trevor', rankAtDeath: 'Sergeant', rankIndex: 3, kills: 1 },
      { name: 'Kenny', rankAtDeath: 'Private', rankIndex: 0, kills: 12 },
    ])
  })

  it('and keeps the order the campaign recorded them in, WITHIN the mission', () => {
    /**
     * THE INVERSION IS PER MISSION AND STOPS THERE. Two men who fell on the same
     * level fell in the same firefight; `state.dead`'s order inside one level is
     * the order the deaths were REPORTED, which is arbitrary rather than
     * chronological. Reversing it as well would be reversing an arbitrary order
     * and presenting the result as recency.
     */
    const first = rollOfHonour(CAMPAIGN).find((entry) => entry.level === 1)
    expect(first?.dead.map((man) => man.name)).toEqual(['Jools', 'Jops'])
  })
})

describe('a level played twice is one mission', () => {
  it('folds both attempts into a single group', () => {
    /**
     * REPLAYING AN EARLIER LEVEL APPENDS TO THE SAME `state.dead`, so the flat
     * list interleaves: level 2, level 1, level 2. A fold that started a new
     * group whenever `diedOnLevel` CHANGED — the obvious one-pass
     * implementation — would print Mission 2, then Mission 1, then Mission 2
     * again, and the player would count his losses twice.
     */
    const replayed: readonly Grave[] = [
      grave({ name: 'A', diedOnLevel: 2, kills: 1 }),
      grave({ name: 'B', diedOnLevel: 1, kills: 2 }),
      grave({ name: 'C', diedOnLevel: 2, kills: 3 }),
    ]
    const roll = rollOfHonour(replayed)
    expect(roll.map((entry) => entry.level)).toEqual([2, 1])
    expect(roll[0]?.dead.map((man) => man.name)).toEqual(['A', 'C'])
  })
})

describe('nobody is lost between the state and the screen', () => {
  it('accounts for every man exactly once', () => {
    /**
     * THE INVARIANT THAT SURVIVES ANY REORDERING. A memorial is the one screen
     * where a dropped row is unforgivable, and every case above pins an ORDER —
     * all of which a fold that silently swallowed a man could still satisfy.
     */
    const listed = rollOfHonour(CAMPAIGN).flatMap((entry) => entry.dead.map((man) => man.name))
    expect(listed.slice().sort()).toEqual(CAMPAIGN.map((g) => g.name).slice().sort())
    expect(listed.length).toBe(CAMPAIGN.length)
  })

  it('and an untouched campaign has an empty roll rather than a blank mission', () => {
    expect(rollOfHonour([])).toEqual([])
  })
})

describe('it is a selector, not a rearrangement of the caller', () => {
  it('leaves the array it was handed alone', () => {
    /**
     * `campaignSummary.fallen` IS `gravesOf(state)`'s array, and Boot Hill reads
     * the same order. A sort in place here would reorder the memorial by writing
     * to a value the Menu merely borrowed.
     */
    const input = [...CAMPAIGN]
    const before = input.map((man) => man.name)
    rollOfHonour(input)
    expect(input.map((man) => man.name)).toEqual(before)
  })

  it('and hands out rows the screen cannot write back through', () => {
    // Fresh rows, not the `Grave` objects: a screen that mutated one would be
    // reaching into the campaign's own record of who died.
    const roll = rollOfHonour(CAMPAIGN)
    const man = roll[0]?.dead[0]
    expect(man).not.toBe(CAMPAIGN[3])
    // And only what the memorial prints — no `plot`, no `fresh`.
    expect(Object.keys(man ?? {}).sort()).toEqual(['kills', 'name', 'rankAtDeath', 'rankIndex'])
  })
})
