import { describe, it, expect } from 'vitest'
import * as campaignApi from '../index'
import {
  applyMissionReport,
  campaignSummary,
  campaignUnderway,
  createCampaign,
  missionReport,
  rankFor,
  recruit,
  recruitsAvailable,
  RANKS,
  MAX_ROSTER,
} from '../index'
import type { CampaignState } from '../index'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 019 — the roster behind Boot Hill.
 *
 * THIS IS THE ONLY STATE IN THE GAME THAT OUTLIVES A MISSION, and the only
 * state a player can lose by accident. Everything else is rebuilt from
 * `level.json` on the next load; a dead soldier is gone because the campaign
 * says so and for no other reason. That is why permadeath here is structural
 * rather than a rule somebody remembers, and why a name is never reissued.
 *
 * PURE, AND SEEDED. No clock, no `Math.random`, no `localStorage`. A campaign
 * carries its seed so that reloading it produces the same roster it had — a
 * generator that drew from an unseeded source would hand a returning player a
 * squad of strangers.
 */

const campaign = (seed = 1): CampaignState => createCampaign({ seed })

/** A `UnitDied` as the bus would stamp it. */
const died = (id: number, killerId: number | null, team: 'player' | 'enemy'): SimEvent => ({
  type: 'UnitDied',
  id,
  team,
  killerId,
  friendlyFire: false,
  tick: 1,
  seq: 1,
})

const complete = (): SimEvent => ({
  type: 'MissionComplete',
  objective: 'kill_all',
  tick: 2,
  seq: 2,
})

const failed = (): SimEvent => ({
  type: 'MissionFailed',
  reason: 'squad wiped out',
  tick: 2,
  seq: 2,
})

describe('a fresh campaign', () => {
  it('starts with recruits', () => {
    expect(recruitsAvailable(campaign()).length).toBeGreaterThan(0)
  })

  it('starts with nobody dead', () => {
    expect(campaign().dead).toEqual([])
  })

  it('gives every recruit a distinct id', () => {
    const ids = recruitsAvailable(campaign()).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every recruit a distinct name', () => {
    const names = recruitsAvailable(campaign()).map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('starts everyone at the bottom of the ladder, alive', () => {
    // `status` is a named field of the acceptance criterion and every other case
    // here projects it away. Left unasserted, `recruitsAvailable` could report
    // every living man as `dead` — or as `undefined` — and the suite stayed
    // green, which adversarial review demonstrated twice.
    for (const r of recruitsAvailable(campaign())) {
      expect({
        id: r.id,
        rank: r.rank,
        missions: r.missionsSurvived,
        kills: r.kills,
        status: r.status,
      }).toEqual({
        id: r.id,
        rank: RANKS[0]?.name,
        missions: 0,
        kills: 0,
        status: 'active',
      })
    }
  })

  it('a survivor is still reported as active afterwards', () => {
    // The other half: a status hardcoded to 'active' at generation would pass
    // the case above and be wrong the moment anything happened.
    let s = createCampaign({ seed: 8, recruits: 3 })
    const man = recruitsAvailable(s)[0]!
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: true, kills: 1 }],
    })
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.status).toBe('active')
  })

  it('is reproducible from its seed', () => {
    // A returning player must get HIS squad back, not a fresh set of strangers
    // wearing the same save file.
    const names = (s: CampaignState): string[] => recruitsAvailable(s).map((r) => r.name)
    expect(names(campaign(7))).toEqual(names(campaign(7)))
  })

  it('and two different seeds give different rosters', () => {
    // Otherwise "seeded" is indistinguishable from "hardcoded".
    const names = (s: CampaignState): string => recruitsAvailable(s).map((r) => r.name).join()
    expect(names(campaign(1))).not.toBe(names(campaign(999)))
  })

  it('unlocks the first level and nothing beyond it', () => {
    const s = campaign()
    expect(s.unlockedLevels).toBeGreaterThanOrEqual(1)
    expect(s.unlockedLevels).toBe(1)
  })
})

describe('names are never reissued', () => {
  it('fills a full roster without repeating anybody', () => {
    /**
     * THE CASE THAT WILL HAPPEN IN PLAY. A generator that wrapped around would
     * put two identical gravestones on Boot Hill, which is the one screen this
     * ticket exists to feed.
     *
     * THIS CASE USED TO ASK FOR `NAME_POOL.length + 12` MEN AND CALL THAT
     * EXHAUSTION, which worked only while the pool was 30 names — shorter than
     * `MAX_ROSTER`. Ticket 045 replaced it with the 347 names of the supplied
     * sheet, and `recruit` caps the living roster at 64, so exhaustion is no
     * longer reachable from here AT ALL: asking for 359 men now yields 64, and
     * the old assertion failed on the cap rather than on any name.
     *
     * So this asks for the most men a roster can hold, which is what it could
     * always actually check. Exhaustion moved to `names.test.ts`, which drives
     * `issueNames` past twice the pool with no roster in the way and holds the
     * generation suffix to the same distinctness rule.
     */
    const s = createCampaign({ seed: 3, recruits: MAX_ROSTER })
    const names = recruitsAvailable(s).map((r) => r.name)
    expect(names).toHaveLength(MAX_ROSTER)
    expect(new Set(names).size).toBe(names.length)
  })

  it('never reuses a dead man`s name', () => {
    // A gravestone is a name. Reissuing one to a living recruit makes the
    // memorial ambiguous and the promotion list wrong.
    let s = createCampaign({ seed: 5, recruits: 4 })
    const doomed = recruitsAvailable(s)[0]
    if (doomed === undefined) throw new Error('no recruits')
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: doomed.id, survived: false, kills: 0 }],
    })
    s = recruit(s, 20)
    const living = recruitsAvailable(s).map((r) => r.name)
    expect(living).not.toContain(doomed.name)
    expect(new Set(living).size).toBe(living.length)
  })

  it('every name is non-empty and trimmed', () => {
    for (const r of recruitsAvailable(createCampaign({ seed: 2, recruits: 40 }))) {
      expect({ name: r.name, ok: r.name.length > 0 && r.name === r.name.trim() }).toEqual({
        name: r.name,
        ok: true,
      })
    }
  })
})

describe('death is permanent', () => {
  const killOne = (): { before: CampaignState; after: CampaignState; id: string } => {
    const before = createCampaign({ seed: 11, recruits: 5 })
    const victim = recruitsAvailable(before)[0]
    if (victim === undefined) throw new Error('no recruits')
    const after = applyMissionReport(before, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: victim.id, survived: false, kills: 0 }],
    })
    return { before, after, id: victim.id }
  }

  it('moves the man to the dead list', () => {
    const { after, id } = killOne()
    expect(after.dead.map((r) => r.id)).toContain(id)
  })

  it('takes him off the available roster', () => {
    const { after, id } = killOne()
    expect(recruitsAvailable(after).map((r) => r.id)).not.toContain(id)
  })

  it('records the level he fell on', () => {
    // Boot Hill's gravestone says where. Without it every stone reads the same —
    // and a `diedOnLevel: 1` hardcoded produces exactly that while passing a test
    // whose fixture only ever fights on level 1, which is what review found.
    const s = createCampaign({ seed: 14, recruits: 3 })
    const men = recruitsAvailable(s)
    const after = applyMissionReport(s, {
      levelId: 4,
      outcome: 'complete',
      entries: [{ recruitId: men[0]!.id, survived: false, kills: 0 }],
    })
    expect(after.dead.find((r) => r.id === men[0]!.id)?.diedOnLevel).toBe(4)
  })

  it('the dead of two levels each carry their own', () => {
    let s = createCampaign({ seed: 15, recruits: 4 })
    const men = recruitsAvailable(s)
    s = applyMissionReport(s, {
      levelId: 2,
      outcome: 'complete',
      entries: [{ recruitId: men[0]!.id, survived: false, kills: 0 }],
    })
    s = applyMissionReport(s, {
      levelId: 5,
      outcome: 'complete',
      entries: [{ recruitId: men[1]!.id, survived: false, kills: 0 }],
    })
    expect(s.dead.map((r) => r.diedOnLevel).sort()).toEqual([2, 5])
  })

  it('records the rank he held when he fell, not one he never reached', () => {
    let s = createCampaign({ seed: 12, recruits: 3 })
    const man = recruitsAvailable(s)[0]
    if (man === undefined) throw new Error('no recruits')
    /**
     * ONE MISSION SHORT OF THE SECOND RANK, deliberately. The first draft ran two
     * victories, and with thresholds at 0 and 2 both `rankFor(2)` and
     * `rankFor(3)` answer the same rank — so an implementation that recorded
     * `rankFor(missionsSurvived + 1)` passed. Stopping just below a threshold is
     * the only place a one-mission overshoot is visible.
     */
    const step = RANKS[1]?.missionsRequired ?? 1
    for (let i = 0; i < step - 1; i += 1) {
      s = applyMissionReport(s, {
        levelId: 1,
        outcome: 'complete',
        entries: [{ recruitId: man.id, survived: true, kills: 0 }],
      })
    }
    const beforeDeath = recruitsAvailable(s).find((r) => r.id === man.id)?.rank
    s = applyMissionReport(s, {
      levelId: 2,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: false, kills: 0 }],
    })
    expect(s.dead.find((r) => r.id === man.id)?.rankAtDeath).toBe(beforeDeath)
  })

  it('is idempotent, because one man can die twice in a tick', () => {
    /**
     * A grenade and a rifle round landing on the same soldier in the same tick
     * is ordinary — `applyDamage` guards the sim side of it, and the campaign
     * needs its own guard because a report could name him twice. Two entries,
     * one gravestone.
     */
    const before = createCampaign({ seed: 13, recruits: 3 })
    const man = recruitsAvailable(before)[0]
    if (man === undefined) throw new Error('no recruits')
    const after = applyMissionReport(before, {
      levelId: 1,
      outcome: 'complete',
      entries: [
        { recruitId: man.id, survived: false, kills: 0 },
        { recruitId: man.id, survived: false, kills: 1 },
      ],
    })
    expect(after.dead.filter((r) => r.id === man.id)).toHaveLength(1)
  })

  it('and a second mission cannot kill him again', () => {
    const { after, id } = killOne()
    const again = applyMissionReport(after, {
      levelId: 2,
      outcome: 'complete',
      entries: [{ recruitId: id, survived: false, kills: 0 }],
    })
    expect(again.dead.filter((r) => r.id === id)).toHaveLength(1)
  })

  it('a dead man earns no promotion from a later mission', () => {
    // He is not on the roster, so a report naming him must change nothing.
    const { after, id } = killOne()
    const again = applyMissionReport(after, {
      levelId: 2,
      outcome: 'complete',
      entries: [{ recruitId: id, survived: true, kills: 5 }],
    })
    expect(recruitsAvailable(again).map((r) => r.id)).not.toContain(id)
    expect(again.dead.find((r) => r.id === id)?.kills).toBe(0)
  })

  it('the module exposes no way to bring him back', () => {
    /**
     * PERMADEATH IS STRUCTURAL. A `setStatus` or a `revive` would make
     * resurrection one careless line away, and the acceptance criterion says no
     * such path exists — which is a claim about the public surface, so it is
     * asserted against the public surface.
     */
    const suspicious = Object.keys(campaignApi).filter((k) =>
      /revive|resurrect|setStatus|undoDeath|unkill|restoreRecruit/i.test(k),
    )
    expect(suspicious).toEqual([])
  })

  it('leaves the previous state untouched', () => {
    // Every transition returns a NEW state. A mutating one would make the
    // undo-free save model above meaningless, and would let a Debrief screen
    // holding last mission's state watch it change under it.
    const { before, after, id } = killOne()
    expect(recruitsAvailable(before).map((r) => r.id)).toContain(id)
    expect(after).not.toBe(before)
  })
})

describe('promotion', () => {
  const survive = (s: CampaignState, id: string, outcome: 'complete' | 'failed'): CampaignState =>
    applyMissionReport(s, {
      levelId: 1,
      outcome,
      entries: [{ recruitId: id, survived: true, kills: 0 }],
    })

  it('the ladder is ordered and starts at zero missions', () => {
    expect(RANKS.length).toBeGreaterThan(1)
    expect(RANKS[0]?.missionsRequired).toBe(0)
    for (let i = 1; i < RANKS.length; i += 1) {
      const prev = RANKS[i - 1]
      const here = RANKS[i]
      expect({
        i,
        rising: (here?.missionsRequired ?? 0) > (prev?.missionsRequired ?? 0),
      }).toEqual({ i, rising: true })
    }
  })

  it('the ladder is data, and survives a JSON round-trip', () => {
    expect(JSON.parse(JSON.stringify(RANKS))).toEqual(RANKS)
  })

  it('counts a survived victory', () => {
    let s = createCampaign({ seed: 21, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    s = survive(s, man.id, 'complete')
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.missionsSurvived).toBe(1)
  })

  it('promotes once the threshold is reached', () => {
    const step = RANKS[1]?.missionsRequired ?? 1
    let s = createCampaign({ seed: 22, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    for (let i = 0; i < step; i += 1) s = survive(s, man.id, 'complete')
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.rank).toBe(RANKS[1]?.name)
  })

  it('does not promote a mission early', () => {
    // The off-by-one that makes every threshold in the table a lie.
    const step = RANKS[1]?.missionsRequired ?? 1
    let s = createCampaign({ seed: 23, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    for (let i = 0; i < step - 1; i += 1) s = survive(s, man.id, 'complete')
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.rank).toBe(RANKS[0]?.name)
  })

  it('a defeat is not a distinction', () => {
    // Surviving a rout is not the same as winning, and a ladder that counted it
    // would promote a squad for losing repeatedly.
    let s = createCampaign({ seed: 24, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    for (let i = 0; i < 10; i += 1) s = survive(s, man.id, 'failed')
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.missionsSurvived).toBe(0)
  })

  it('rank is derived from missions, so the two cannot disagree', () => {
    // Stored separately, a retune of the ladder leaves every existing save with
    // ranks that no longer match the record they were earned by.
    for (const rank of RANKS) {
      expect(rankFor(rank.missionsRequired)).toBe(rank.name)
    }
  })

  it('tops out rather than running off the end of the ladder', () => {
    const beyond = (RANKS[RANKS.length - 1]?.missionsRequired ?? 0) + 50
    expect(rankFor(beyond)).toBe(RANKS[RANKS.length - 1]?.name)
  })

  it('a mission nobody survived promotes nobody', () => {
    let s = createCampaign({ seed: 25, recruits: 3 })
    const men = recruitsAvailable(s)
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'failed',
      entries: men.map((m) => ({ recruitId: m.id, survived: false, kills: 0 })),
    })
    expect(recruitsAvailable(s)).toEqual([])
    expect(s.dead).toHaveLength(men.length)
  })
})

describe('kills are credited to the man who fired', () => {
  it('adds to his record', () => {
    let s = createCampaign({ seed: 31, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: true, kills: 3 }],
    })
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.kills).toBe(3)
  })

  it('accumulates across missions', () => {
    let s = createCampaign({ seed: 32, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    for (let i = 0; i < 3; i += 1) {
      s = applyMissionReport(s, {
        levelId: 1,
        outcome: 'complete',
        entries: [{ recruitId: man.id, survived: true, kills: 2 }],
      })
    }
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.kills).toBe(6)
  })

  it('a man who died still keeps the kills he made', () => {
    // He fired, and the round landed. Ids are never reused, so he can still be
    // named — and a gravestone reading "3 kills" is the point of the screen.
    let s = createCampaign({ seed: 33, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: false, kills: 4 }],
    })
    expect(s.dead.find((r) => r.id === man.id)?.kills).toBe(4)
  })

  it('ignores a report naming somebody who was never on the roster', () => {
    const s = createCampaign({ seed: 34, recruits: 2 })
    expect(() =>
      applyMissionReport(s, {
        levelId: 1,
        outcome: 'complete',
        entries: [{ recruitId: 'nobody', survived: true, kills: 9 }],
      }),
    ).not.toThrow()
  })
})

describe('hostile report data, because a report is assembled from a live mission', () => {
  it('a negative kill count is ignored, not recorded', () => {
    /**
     * The asymmetry review found: the pure layer accepted `kills: -5` while the
     * LOADER rejects any record with a negative count — so a campaign this
     * module will happily produce cannot be read back, and the player's whole
     * save is discarded as damaged on next launch. A state that cannot survive
     * its own round trip is a bug wherever the guard is missing.
     */
    let s = createCampaign({ seed: 41, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    s = applyMissionReport(s, {
      levelId: 1,
      outcome: 'complete',
      entries: [{ recruitId: man.id, survived: true, kills: -5 }],
    })
    expect(recruitsAvailable(s).find((r) => r.id === man.id)?.kills).toBe(0)
  })

  it('a non-finite kill count is ignored', () => {
    let s = createCampaign({ seed: 42, recruits: 2 })
    const man = recruitsAvailable(s)[0]!
    for (const kills of [Number.NaN, Number.POSITIVE_INFINITY]) {
      s = applyMissionReport(s, {
        levelId: 1,
        outcome: 'complete',
        entries: [{ recruitId: man.id, survived: true, kills }],
      })
    }
    expect(Number.isFinite(recruitsAvailable(s).find((r) => r.id === man.id)?.kills)).toBe(true)
  })

  it('a nonsense level id does not unlock the whole campaign', () => {
    // One report naming level 9999 must not hand the player every level there
    // will ever be.
    const s = applyMissionReport(campaign(), { levelId: 9999, outcome: 'complete', entries: [] })
    expect(s.unlockedLevels).toBeLessThan(100)
  })

  it('recruiting an absurd number terminates rather than hanging', () => {
    // `recruit(state, Infinity)` looped forever: `Math.floor(Infinity)` is
    // `Infinity`, and the name issuer walked toward it. A hang is the one
    // failure a test suite reports as a timeout rather than a defect.
    for (const count of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      expect(() => recruit(createCampaign({ seed: 43, recruits: 2 }), count)).not.toThrow()
    }
  })
})

describe('unlock state', () => {
  it('a victory unlocks the next level', () => {
    const s = applyMissionReport(campaign(), { levelId: 1, outcome: 'complete', entries: [] })
    expect(s.unlockedLevels).toBe(2)
  })

  it('a defeat unlocks nothing', () => {
    const s = applyMissionReport(campaign(), { levelId: 1, outcome: 'failed', entries: [] })
    expect(s.unlockedLevels).toBe(1)
  })

  it('replaying a level already beaten does not unlock two', () => {
    // The progression bug that lets a player skip a level by grinding the first.
    let s = applyMissionReport(campaign(), { levelId: 1, outcome: 'complete', entries: [] })
    s = applyMissionReport(s, { levelId: 1, outcome: 'complete', entries: [] })
    expect(s.unlockedLevels).toBe(2)
  })
})

describe('reading a mission off the event stream', () => {
  const assignment = new Map<number, string>([
    [1, 'alpha'],
    [2, 'bravo'],
  ])

  it('reports the men who lived and the men who did not', () => {
    const report = missionReport([died(1, 99, 'player'), complete()], assignment, 1)
    const byId = new Map(report.entries.map((e) => [e.recruitId, e]))
    expect({ alpha: byId.get('alpha')?.survived, bravo: byId.get('bravo')?.survived }).toEqual({
      alpha: false,
      bravo: true,
    })
  })

  it('reads the outcome from the mission events', () => {
    expect(missionReport([complete()], assignment, 1).outcome).toBe('complete')
    expect(missionReport([failed()], assignment, 1).outcome).toBe('failed')
  })

  it('credits a kill to the recruit whose entity fired', () => {
    // `UnitDied.killerId` is the entity; the assignment maps it back to a man.
    const report = missionReport([died(50, 2, 'enemy'), complete()], assignment, 1)
    expect(report.entries.find((e) => e.recruitId === 'bravo')?.kills).toBe(1)
  })

  it('credits nothing for an enemy killed by another enemy', () => {
    // Friendly fire on their side is not the player's achievement.
    const report = missionReport([died(50, 51, 'enemy'), complete()], assignment, 1)
    expect(report.entries.every((e) => e.kills === 0)).toBe(true)
  })

  it('credits nothing for a death with no attributable killer', () => {
    const report = missionReport([died(50, null, 'enemy'), complete()], assignment, 1)
    expect(report.entries.every((e) => e.kills === 0)).toBe(true)
  })

  it('does not credit killing your own squad', () => {
    /**
     * Friendly fire IS reachable since ticket 015 — a grenade does not ask whose
     * side anyone is on — so this is a real path, not a hypothetical. Blowing up
     * your own corporal is not a kill, and counting it would put the campaign's
     * best marksman on Boot Hill's promotion list for it.
     */
    const report = missionReport([died(1, 2, 'player'), complete()], assignment, 1)
    expect(report.entries.find((e) => e.recruitId === 'bravo')?.kills).toBe(0)
  })

  it('names every assigned recruit, including the untouched ones', () => {
    const report = missionReport([complete()], assignment, 1)
    expect(report.entries.map((e) => e.recruitId).sort()).toEqual(['alpha', 'bravo'])
  })

  it('carries the level it was fought on', () => {
    expect(missionReport([complete()], assignment, 4).levelId).toBe(4)
  })

  it('an empty stream is a mission that is still running, not a victory', () => {
    // A `MissionComplete` that never arrived must not read as one.
    expect(missionReport([], assignment, 1).outcome).not.toBe('complete')
  })
})

/**
 * Ticket 046 — the Menu's button says "Continue" to a player who is coming back.
 *
 * THE WHOLE POINT IS THE FIRST CASE. `createCampaign` recruits eight men on its
 * way out of the door, so every obvious spelling of "has this campaign been
 * played" — `recruitsIssued > 0`, `recruits.length > 0` — is TRUE on a campaign
 * nobody has touched, and would greet a first-time player with "Continue
 * campaign". The rest are the three independent ways a campaign can be underway;
 * none of them implies either of the others.
 */
describe('a campaign that is underway', () => {
  const men = (state: CampaignState): readonly string[] =>
    recruitsAvailable(state).map((man) => man.id)

  it('is not a campaign that has merely been created', () => {
    expect(campaignUnderway(createCampaign({ seed: 21 }))).toBe(false)
  })

  it('is one with a level beaten, even with nobody lost', () => {
    const state = createCampaign({ seed: 22, recruits: 3 })
    const after = applyMissionReport(state, {
      levelId: 1,
      outcome: 'complete',
      entries: men(state).map((id) => ({ recruitId: id, survived: true, kills: 0 })),
    })
    expect(after.unlockedLevels).toBeGreaterThan(1)
    expect(after.dead.length).toBe(0)
    expect(campaignUnderway(after)).toBe(true)
  })

  it('is one with a man in the ground, even with no level beaten', () => {
    const state = createCampaign({ seed: 23, recruits: 3 })
    const after = applyMissionReport(state, {
      levelId: 1,
      outcome: 'failed',
      entries: [{ recruitId: men(state)[0]!, survived: false, kills: 0 }],
    })
    expect(after.unlockedLevels).toBe(1)
    expect(campaignUnderway(after)).toBe(true)
  })

  it('is NOT one where a failed mission killed nobody and lost nobody', () => {
    /**
     * THE LIMIT, PINNED RATHER THAN LEFT TO BE DISCOVERED. A failed mission
     * increments no `missionsSurvived` (see `applyMissionReport`), so a squad
     * that came home from one having killed nobody leaves a save that is
     * byte-for-byte a fresh campaign. There is nothing here to find — and if the
     * campaign ever starts recording the attempt, this is the case that says so.
     */
    const state = createCampaign({ seed: 24, recruits: 3 })
    const after = applyMissionReport(state, {
      levelId: 1,
      outcome: 'failed',
      entries: [{ recruitId: men(state)[0]!, survived: true, kills: 0 }],
    })
    expect(campaignSummary(after)).toMatchObject({ levelsCompleted: 0, casualties: 0, kills: 0 })
    expect(campaignUnderway(after)).toBe(false)
  })

  it('is one whose men have killed, even before a mission is recorded against them', () => {
    const state = createCampaign({ seed: 25, recruits: 3 })
    const after = applyMissionReport(state, {
      levelId: 1,
      outcome: 'failed',
      entries: [{ recruitId: men(state)[0]!, survived: true, kills: 2 }],
    })
    expect(campaignUnderway(after)).toBe(true)
  })
})
