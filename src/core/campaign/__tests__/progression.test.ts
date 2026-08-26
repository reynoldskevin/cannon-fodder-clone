import { describe, it, expect } from 'vitest'
import {
  applyMissionReport,
  campaignSummary,
  createCampaign,
  recruitsAvailable,
} from '../index'
import { campaignComplete } from '../../flow'
import type { CampaignState, MissionReport } from '../index'

/**
 * Ticket 024 — the campaign as a whole, rather than one mission at a time.
 *
 * MOST OF THIS TICKET WAS ALREADY BUILT, and this file is careful not to
 * re-litigate it. Ticket 019 wrote the unlock ladder and 022a wired it:
 * `unlockAfter` uses `Math.max` so replaying a beaten level cannot skip one, a
 * failed mission does not advance but DOES bury its dead, and `campaignComplete`
 * compares with `>` for the reason ticket 020 measured. All of that is tested
 * where it lives.
 *
 * What is new here is the SUMMARY — what the player is told when it is over —
 * and the walk across several levels that nothing has ever taken, because until
 * this ticket the game only ever loaded one.
 */

/** A report that kills `killed` of the squad and credits `kills` to the first survivor. */
function report(
  levelId: number,
  outcome: 'complete' | 'failed',
  squad: readonly string[],
  killed: readonly string[] = [],
  kills = 0,
): MissionReport {
  return {
    levelId,
    outcome,
    entries: squad.map((id, i) => ({
      recruitId: id,
      survived: !killed.includes(id),
      kills: i === 0 ? kills : 0,
    })),
  }
}

const ids = (state: CampaignState, n: number): string[] =>
  recruitsAvailable(state).slice(0, n).map((m) => m.id)

describe('the summary the player is shown at the end', () => {
  it('counts nothing on a campaign nobody has played', () => {
    const s = createCampaign({ seed: 1, recruits: 6 })
    expect(campaignSummary(s)).toEqual({
      levelsCompleted: 0,
      casualties: 0,
      kills: 0,
      fallen: [],
    })
  })

  it('counts the dead, and names them oldest first', () => {
    // The same order Boot Hill uses, and for the same reason: `dead` is
    // append-only and never re-sorted, so insertion order IS chronological.
    let s = createCampaign({ seed: 2, recruits: 6 })
    const squad = ids(s, 3)
    s = applyMissionReport(s, report(1, 'complete', squad, [squad[0] ?? '']))
    s = applyMissionReport(s, report(2, 'complete', ids(s, 3), [ids(s, 3)[0] ?? '']))
    const summary = campaignSummary(s)
    expect(summary.casualties).toBe(2)
    expect(summary.fallen).toHaveLength(2)
    expect(summary.fallen.map((g) => g.diedOnLevel)).toEqual([1, 2])
  })

  it('counts a dead man`s kills as well as a living one`s', () => {
    /**
     * THE ONE THAT IS EASY TO GET WRONG, because the obvious implementation sums
     * over `recruitsAvailable` and a dead man is not on that list. He killed
     * three and then fell; the campaign total that forgot them would be telling
     * the player he did less than he did, and Boot Hill already carries the
     * number on his stone.
     */
    let s = createCampaign({ seed: 3, recruits: 4 })
    const squad = ids(s, 2)
    // The first man scores three and dies doing it.
    s = applyMissionReport(s, report(1, 'complete', squad, [squad[0] ?? ''], 3))
    expect(campaignSummary(s).casualties).toBe(1)
    expect(campaignSummary(s).kills).toBe(3)
    expect(s.recruits.some((r) => r.id === squad[0])).toBe(false)
  })

  it('adds the living and the dead together rather than one or the other', () => {
    // Two sources, one total. Asserted with a kill on each side, so an
    // implementation that summed only one of them fails whichever it picked.
    let s = createCampaign({ seed: 4, recruits: 4 })
    const first = ids(s, 2)
    s = applyMissionReport(s, report(1, 'complete', first, [first[0] ?? ''], 2))
    const second = ids(s, 2)
    s = applyMissionReport(s, report(2, 'complete', second, [], 5))
    expect(campaignSummary(s).kills).toBe(7)
  })

  it('counts levels completed, which is not the same as levels unlocked', () => {
    /**
     * `unlockedLevels` is a COUNT THAT STARTS AT ONE — a fresh campaign has one
     * level open and none beaten. Reporting it raw would tell a player who has
     * finished nothing that he has finished one, which is the off-by-one this
     * whole milestone keeps circling.
     */
    let s = createCampaign({ seed: 5, recruits: 4 })
    expect(s.unlockedLevels).toBe(1)
    expect(campaignSummary(s).levelsCompleted).toBe(0)
    s = applyMissionReport(s, report(1, 'complete', ids(s, 2)))
    expect(s.unlockedLevels).toBe(2)
    expect(campaignSummary(s).levelsCompleted).toBe(1)
  })

  it('is a fresh value, not a window into the campaign', () => {
    // The screens are DOM and nothing can test what they do with what they are
    // handed, so the guarantee has to be structural — the same argument
    // `bootHillModel` makes about `graves`.
    const s = createCampaign({ seed: 6, recruits: 4 })
    expect(campaignSummary(s)).not.toBe(campaignSummary(s))
    expect(campaignSummary(s).fallen).not.toBe(campaignSummary(s).fallen)
    expect(campaignSummary(s)).toEqual(campaignSummary(s))
  })
})

describe('a campaign walked across several levels', () => {
  /**
   * THE WALK NOTHING HAS EVER TAKEN. Until this ticket the game loaded one
   * level, so "beat one, the next opens" was true of the roster and untested
   * against a campaign of any length.
   */

  it('opens each level in turn, and never two at once', () => {
    let s = createCampaign({ seed: 7, recruits: 8 })
    const opened: number[] = [s.unlockedLevels]
    for (let level = 1; level <= 4; level += 1) {
      s = applyMissionReport(s, report(level, 'complete', ids(s, 2)))
      opened.push(s.unlockedLevels)
    }
    expect(opened).toEqual([1, 2, 3, 4, 5])
  })

  it('and replaying a level already beaten opens nothing further', () => {
    // `unlockAfter` uses `Math.max`, which is the progression bug that would
    // otherwise let a player skip a level by grinding the first.
    let s = createCampaign({ seed: 8, recruits: 8 })
    s = applyMissionReport(s, report(1, 'complete', ids(s, 2)))
    s = applyMissionReport(s, report(1, 'complete', ids(s, 2)))
    s = applyMissionReport(s, report(1, 'complete', ids(s, 2)))
    expect(s.unlockedLevels).toBe(2)
  })

  it('a failed attempt advances nothing and still buries its dead', () => {
    /**
     * Both halves in one case, because they are the same decision: a retry that
     * resurrected the men who died in the failed attempt would make death
     * optional, and one that advanced would make failing free.
     */
    let s = createCampaign({ seed: 9, recruits: 6 })
    const squad = ids(s, 3)
    s = applyMissionReport(s, report(1, 'failed', squad, [squad[0] ?? '']))
    expect(s.unlockedLevels).toBe(1)
    expect(campaignSummary(s).casualties).toBe(1)
    expect(recruitsAvailable(s).some((m) => m.id === squad[0])).toBe(false)
  })
})

describe('where a campaign ENDS depends on how many levels there are', () => {
  it('is not over while a level remains, however many that is', () => {
    /**
     * NO COUNT IS HARDCODED, which is the rule this ticket adds. Ticket 023 has
     * not run: two levels are published, not five. The comparison is against
     * whatever the manifest lists, so the same code is right today and right
     * when three more arrive.
     */
    for (const total of [1, 2, 5, 12]) {
      let s = createCampaign({ seed: 10, recruits: 8 })
      for (let level = 1; level < total; level += 1) {
        s = applyMissionReport(s, report(level, 'complete', ids(s, 2)))
        expect({ total, level, over: campaignComplete(s.unlockedLevels, total) }).toEqual({
          total,
          level,
          over: false,
        })
      }
      // And the last one ends it.
      s = applyMissionReport(s, report(total, 'complete', ids(s, 2)))
      expect({ total, over: campaignComplete(s.unlockedLevels, total) }).toEqual({
        total,
        over: true,
      })
    }
  })

  it('and a lost last mission does not end it', () => {
    let s = createCampaign({ seed: 11, recruits: 6 })
    s = applyMissionReport(s, report(1, 'complete', ids(s, 2)))
    s = applyMissionReport(s, report(2, 'failed', ids(s, 2)))
    expect(campaignComplete(s.unlockedLevels, 2)).toBe(false)
  })
})
