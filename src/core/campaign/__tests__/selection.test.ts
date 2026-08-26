import { describe, it, expect } from 'vitest'
import {
  applyMissionReport,
  createCampaign,
  maxSquadFor,
  recruitmentModel,
  recruitsAvailable,
  selectSquad,
} from '../index'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import type { CampaignState } from '../index'
import type { LevelData, SpawnPoint } from '../../level/types'

/**
 * Ticket 021 — assigning men to a mission.
 *
 * THE CAP IS THE LEVEL'S OWN AVATAR SLOTS. You cannot field more men than the
 * map has places to put them, and declaring a second maximum somewhere would let
 * the two disagree — with the loser being an authored spawn point standing empty
 * or a soldier with nowhere to stand.
 *
 * EXACTLY THAT MANY, NOT AT MOST. A short squad leaves a hole in the level the
 * designer did not intend, so under-selection is refused as firmly as over-.
 * Which means a campaign whose squad was wiped must be able to field a fresh
 * one: telling the player "not enough men" with no way to get more is a dead
 * end, so the roster is topped up rather than the mission refused.
 */

const levelWith = (slots: number): LevelData => {
  const base = asciiLevel(`
    ....................
    ....................
    ....................
    ....................
  `)
  const avatars: SpawnPoint[] = []
  for (let i = 0; i < slots; i += 1) avatars.push({ x: 2 + i, y: 2 })
  return { ...base, spawns: { ...base.spawns, avatars } }
}

const ids = (state: CampaignState, n: number): string[] =>
  recruitsAvailable(state).slice(0, n).map((r) => r.id)

describe('how many men a level takes', () => {
  it('is however many avatar slots it declares', () => {
    expect(maxSquadFor(levelWith(4))).toBe(4)
  })

  it('level 1 fields two, because that is what it has room for', () => {
    expect(maxSquadFor(levelWith(2))).toBe(2)
  })

  it('a level with no avatar slots takes nobody', () => {
    // Not a crash: a level document is hand-authored and this is a real mistake
    // somebody can make.
    expect(maxSquadFor(levelWith(0))).toBe(0)
  })
})

describe('a valid selection', () => {
  it('is accepted when it fills the level exactly', () => {
    const s = createCampaign({ seed: 1, recruits: 6 })
    const result = selectSquad(s, levelWith(3), ids(s, 3))
    expect(result.ok).toBe(true)
  })

  it('hands back the men chosen, in the order chosen', () => {
    /**
     * ORDER IS THE PLAYER'S. It decides who stands on which spawn point, and a
     * screen that let you place your veteran on the left flank must not have him
     * silently sorted to the right.
     */
    const s = createCampaign({ seed: 2, recruits: 6 })
    const chosen = [...ids(s, 3)].reverse()
    const result = selectSquad(s, levelWith(3), chosen)
    if (!result.ok) throw new Error(result.reason)
    expect(result.squad.map((m) => m.id)).toEqual(chosen)
  })

  it('carries each man`s name and rank, not just his id', () => {
    const s = createCampaign({ seed: 3, recruits: 4 })
    const result = selectSquad(s, levelWith(2), ids(s, 2))
    if (!result.ok) throw new Error(result.reason)
    for (const man of result.squad) {
      expect({ name: man.name.length > 0, rank: (man.rank ?? '').length > 0 }).toEqual({
        name: true,
        rank: true,
      })
    }
  })

  it('leaves the campaign alone when nobody had to be recruited', () => {
    const s = createCampaign({ seed: 4, recruits: 6 })
    const result = selectSquad(s, levelWith(3), ids(s, 3))
    if (!result.ok) throw new Error(result.reason)
    expect(result.state).toEqual(s)
  })
})

describe('a selection that would break the level is refused', () => {
  const refusal = (chosen: string[], slots: number, s: CampaignState): string => {
    const result = selectSquad(s, levelWith(slots), chosen)
    if (result.ok) throw new Error('expected a refusal')
    return result.reason
  }

  it('too many men', () => {
    const s = createCampaign({ seed: 11, recruits: 6 })
    expect(refusal(ids(s, 4), 3, s).length).toBeGreaterThan(10)
  })

  it('too few men', () => {
    // An unfilled avatar slot is a hole in the level the designer did not put
    // there. "At most" would allow it; "exactly" does not.
    const s = createCampaign({ seed: 12, recruits: 6 })
    expect(refusal(ids(s, 2), 3, s).length).toBeGreaterThan(10)
  })

  it('nobody at all, when the level wants somebody', () => {
    const s = createCampaign({ seed: 13, recruits: 6 })
    expect(refusal([], 3, s).length).toBeGreaterThan(10)
  })

  it('the same man twice', () => {
    /**
     * NOT PEDANTRY. A click-to-toggle roster produces this the first time
     * anybody double-clicks, and it would put one soldier on two spawn points
     * and leave a third empty — which reads as the game losing a man.
     */
    const s = createCampaign({ seed: 14, recruits: 6 })
    const one = ids(s, 1)[0] ?? ''
    const second = ids(s, 2)[1] ?? ''
    expect(refusal([one, one, second], 3, s).length).toBeGreaterThan(10)
  })

  it('an id naming nobody', () => {
    const s = createCampaign({ seed: 15, recruits: 6 })
    expect(refusal([...ids(s, 2), 'nobody'], 3, s).length).toBeGreaterThan(10)
  })

  it('a dead man', () => {
    // The one refusal a player would find most alarming if it were missing.
    let s = createCampaign({ seed: 16, recruits: 6 })
    const doomed = recruitsAvailable(s)[0]
    if (doomed === undefined) throw new Error('no recruits')
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: doomed.id, survived: false, kills: 0 }],
    })
    const living = ids(s, 2)
    const result = selectSquad(s, levelWith(3), [...living, doomed.id])
    expect(result.ok).toBe(false)
  })

  it('every refusal says why, and never throws', () => {
    const s = createCampaign({ seed: 17, recruits: 6 })
    const bad: readonly string[][] = [ids(s, 9), [], ['ghost'], [ids(s, 1)[0] ?? '']]
    for (const chosen of bad) {
      expect(() => selectSquad(s, levelWith(3), chosen)).not.toThrow()
      const result = selectSquad(s, levelWith(3), chosen)
      expect({ chosen: chosen.length, refused: !result.ok }).toEqual({
        chosen: chosen.length,
        refused: true,
      })
    }
  })

  it('a refusal changes nothing', () => {
    // No half-recruitment: a rejected selection must not leave names issued.
    const s = createCampaign({ seed: 18, recruits: 6 })
    const before = JSON.stringify(s)
    selectSquad(s, levelWith(3), ids(s, 9))
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('a campaign short of men fields a squad anyway', () => {
  it('tops the roster up rather than refusing the mission', () => {
    /**
     * THE DEAD END THIS AVOIDS. A campaign whose squad was wiped has one living
     * man and a level wanting four; refusing to deploy leaves the player at a
     * Recruitment screen with no button that works and no way to get more men.
     */
    const s = createCampaign({ seed: 21, recruits: 1 })
    expect(recruitsAvailable(s)).toHaveLength(1)
    const result = selectSquad(s, levelWith(4), [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.squad).toHaveLength(4)
  })

  it('and remembers the names it issued', () => {
    /**
     * `selectSquad` returns the new campaign state as well as the squad, and
     * this is why: ticket 019's whole name-uniqueness guarantee runs through
     * `recruitsIssued`. Throwing away the returned state would reissue those
     * same names next mission, and Boot Hill would end up with two gravestones
     * reading the same thing.
     */
    const s = createCampaign({ seed: 22, recruits: 1 })
    const result = selectSquad(s, levelWith(4), [])
    if (!result.ok) throw new Error(result.reason)
    const names = recruitsAvailable(result.state).map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    expect(recruitsAvailable(result.state).length).toBeGreaterThanOrEqual(4)

    const next = selectSquad(result.state, levelWith(4), [])
    if (!next.ok) throw new Error(next.reason)
    const laterNames = recruitsAvailable(next.state).map((r) => r.name)
    expect(new Set(laterNames).size).toBe(laterNames.length)
  })

  it('an empty roster still fields a full squad', () => {
    const s = createCampaign({ seed: 23, recruits: 0 })
    const result = selectSquad(s, levelWith(3), [])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.squad).toHaveLength(3)
  })

  it('keeps the men the player DID choose', () => {
    // Auto-fill tops up; it does not overrule. A player who picked his veteran
    // must still get him.
    const s = createCampaign({ seed: 24, recruits: 2 })
    const chosen = ids(s, 2)
    const result = selectSquad(s, levelWith(4), chosen)
    if (!result.ok) throw new Error(result.reason)
    expect(result.squad.slice(0, 2).map((m) => m.id)).toEqual(chosen)
  })

  it('never fills a slot with a dead man', () => {
    let s = createCampaign({ seed: 25, recruits: 3 })
    const dead = recruitsAvailable(s).map((r) => r.id)
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: dead.map((id) => ({ recruitId: id, survived: false, kills: 0 })),
    })
    const result = selectSquad(s, levelWith(3), [])
    if (!result.ok) throw new Error(result.reason)
    expect(result.squad.map((m) => m.id).filter((id) => dead.includes(id))).toEqual([])
  })
})

describe('what the Recruitment screen draws', () => {
  it('says how many men the level takes', () => {
    const s = createCampaign({ seed: 31, recruits: 5 })
    expect(recruitmentModel(s, levelWith(3)).maxSquad).toBe(3)
  })

  it('lists the living, with name, rank and record', () => {
    const s = createCampaign({ seed: 32, recruits: 4 })
    const model = recruitmentModel(s, levelWith(2))
    expect(model.available).toHaveLength(4)
    for (const man of model.available) {
      expect({
        name: man.name.length > 0,
        rank: man.rank.length > 0,
        missions: Number.isFinite(man.missionsSurvived),
        kills: Number.isFinite(man.kills),
      }).toEqual({ name: true, rank: true, missions: true, kills: true })
    }
  })

  it('never lists the dead', () => {
    // The screen a player looks at to pick a squad is the last place a man he
    // buried last mission should appear.
    let s = createCampaign({ seed: 33, recruits: 4 })
    const doomed = recruitsAvailable(s)[0]
    if (doomed === undefined) throw new Error('no recruits')
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: doomed.id, survived: false, kills: 0 }],
    })
    const model = recruitmentModel(s, levelWith(2))
    expect(model.available.map((m) => m.id)).not.toContain(doomed.id)
    expect(model.available.map((m) => m.name)).not.toContain(doomed.name)
  })

  it('shows a veteran`s record, which is why the player picks him', () => {
    let s = createCampaign({ seed: 34, recruits: 3 })
    const man = recruitsAvailable(s)[0]
    if (man === undefined) throw new Error('no recruits')
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: true, kills: 4 }],
    })
    const shown = recruitmentModel(s, levelWith(2)).available.find((m) => m.id === man.id)
    expect({ missions: shown?.missionsSurvived, kills: shown?.kills }).toEqual({
      missions: 1,
      kills: 4,
    })
  })

  it('is data, and survives a JSON round-trip', () => {
    const s = createCampaign({ seed: 35, recruits: 3 })
    const model = recruitmentModel(s, levelWith(2))
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })

  it('is a copy, not a window onto the roster', () => {
    const s = createCampaign({ seed: 36, recruits: 3 })
    const model = recruitmentModel(s, levelWith(2))
    expect(model.available).not.toBe(recruitsAvailable(s))
  })
})
