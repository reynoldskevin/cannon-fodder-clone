import { describe, it, expect } from 'vitest'
import {
  applyMissionReport,
  bootHillModel,
  createCampaign,
  loadCampaign,
  promotionsBetween,
  recruit,
  recruitmentModel,
  recruitsAvailable,
  saveCampaign,
  RANKS,
} from '../index'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import type { CampaignState, PersistencePort } from '../index'
import type { LevelData, SpawnPoint } from '../../level/types'

/**
 * Ticket 022 — Boot Hill.
 *
 * THE ONLY SCREEN IN THIS GAME THAT IS ABOUT MEMORY. Every other one shows the
 * player something he can act on; this one shows him a list of names he cannot
 * do anything about, and that is why the campaign has weight at all. A soldier
 * who dies in the mission and vanishes from the record is a unit; a soldier
 * whose gravestone is still on the hill four levels later is a loss.
 *
 * SO IT ADDS NO STATE, and that is the test of the three tickets before it.
 * Ticket 019 already carves the stones — `DeadRecruit` carries `rankAtDeath` and
 * `diedOnLevel`, and a dead man's rank is RECORDED rather than derived precisely
 * so this screen can show what he was when he fell. If this ticket needed a new
 * field, something upstream was wrong.
 */

const levelWith = (slots: number): LevelData => {
  const base = asciiLevel(`
    ....................
    ....................
    ....................
  `)
  const avatars: SpawnPoint[] = []
  for (let i = 0; i < slots; i += 1) avatars.push({ x: 2 + i, y: 1 })
  return { ...base, spawns: { ...base.spawns, avatars } }
}

/** Fight `levelId`, killing the named men and surviving with the rest. */
function fight(
  state: CampaignState,
  levelId: number,
  killIds: readonly string[],
  outcome: 'complete' | 'failed' = 'complete',
): CampaignState {
  const men = recruitsAvailable(state)
  return applyMissionReport(state, {
    levelId,
    outcome,
    entries: men.map((m) => ({
      recruitId: m.id,
      survived: !killIds.includes(m.id),
      kills: killIds.includes(m.id) ? 2 : 1,
    })),
  })
}

describe('the hill', () => {
  it('is empty before anybody has died', () => {
    const s = createCampaign({ seed: 1, recruits: 4 })
    expect(bootHillModel(s, promotionsBetween(s, s)).graves).toEqual([])
  })

  it('carves a stone for the man who fell', () => {
    const before = createCampaign({ seed: 2, recruits: 4 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [doomed.id])
    const graves = bootHillModel(after, promotionsBetween(before, after)).graves
    expect(graves.map((g) => g.name)).toEqual([doomed.name])
  })

  it('the stone says his name, his rank when he fell, and where', () => {
    /**
     * All three, because a stone with only a name is a list. `rankAtDeath` is
     * RECORDED by ticket 019 rather than recomputed — the ladder is a tuning
     * surface, and a stone that changed its inscription when a designer edited a
     * table would be worse than no stone at all.
     */
    const before = createCampaign({ seed: 3, recruits: 4 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 4, [doomed.id])
    const stone = bootHillModel(after, promotionsBetween(before, after)).graves[0]
    expect({ name: stone?.name, rank: stone?.rankAtDeath, level: stone?.diedOnLevel }).toEqual({
      name: doomed.name,
      rank: doomed.rank,
      level: 4,
    })
  })

  it('and how many he took with him', () => {
    // A gravestone reading "3 kills" is the difference between a casualty and a
    // soldier the player remembers.
    const before = createCampaign({ seed: 4, recruits: 3 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [doomed.id])
    expect(bootHillModel(after, []).graves[0]?.kills).toBeGreaterThan(0)
  })

  it('GROWS across the campaign, oldest first', () => {
    /**
     * THE WHOLE POINT OF THE SCREEN, and the reason 019's dead list is
     * append-only. A hill that showed only this mission's casualties would be a
     * casualty report — the player is meant to scroll past men he lost four
     * levels ago and recognise the names.
     */
    let s = createCampaign({ seed: 5, recruits: 8 })
    const fallen: string[] = []
    for (let level = 1; level <= 4; level += 1) {
      const next = recruitsAvailable(s)[0]!
      fallen.push(next.name)
      s = fight(s, level, [next.id])
    }
    const graves = bootHillModel(s, []).graves
    expect(graves.map((g) => g.name)).toEqual(fallen)
    expect(graves.map((g) => g.diedOnLevel)).toEqual([1, 2, 3, 4])
  })

  it('keeps two men who fell on the same level, both of them', () => {
    const before = createCampaign({ seed: 6, recruits: 5 })
    const men = recruitsAvailable(before).slice(0, 2)
    const after = fight(before, 2, men.map((m) => m.id))
    expect(bootHillModel(after, []).graves).toHaveLength(2)
  })

  it('marks the men who fell THIS mission, so the new stones stand out', () => {
    let s = createCampaign({ seed: 7, recruits: 6 })
    const first = recruitsAvailable(s)[0]!
    s = fight(s, 1, [first.id])
    const beforeSecond = s
    const second = recruitsAvailable(s)[0]!
    s = fight(s, 2, [second.id])
    const model = bootHillModel(s, promotionsBetween(beforeSecond, s), beforeSecond)
    expect(model.graves).toHaveLength(2)
    expect(model.fallenThisMission.map((g) => g.name)).toEqual([second.name])
  })

  it('and marks only the new ones when the SAME level is replayed', () => {
    /**
     * THE CASE A LEVEL-BASED HEURISTIC CANNOT SEE, and it is reachable: lose men
     * on level 3, retry level 3, lose more. `applyMissionReport` appends one
     * mission's fallen as a block, so "the trailing run sharing the last grave's
     * level" identifies them — until two consecutive missions are fought on the
     * SAME level, when the two blocks merge and last attempt's dead are marked
     * fresh again.
     *
     * Measured before the fix: after the retry, Boot Hill marked both Kovac (the
     * previous attempt) and Farrow (this one) as newly fallen. Comparing against
     * the previous CAMPAIGN STATE is exact and needs no new state, because the
     * dead list is append-only.
     */
    let s = createCampaign({ seed: 71, recruits: 8 })
    const firstAttempt = recruitsAvailable(s)[0]!
    s = fight(s, 3, [firstAttempt.id], 'failed')
    const beforeRetry = s
    const secondAttempt = recruitsAvailable(s)[0]!
    s = fight(s, 3, [secondAttempt.id])
    const model = bootHillModel(s, [], beforeRetry)
    expect(model.graves.map((g) => g.name)).toEqual([firstAttempt.name, secondAttempt.name])
    expect(model.fallenThisMission.map((g) => g.name)).toEqual([secondAttempt.name])
  })

  it('marks nobody when it has no previous state to compare against', () => {
    // What a RELOAD is: the campaign comes back and nothing fell this session,
    // so no stone is new. Marking the last mission's dead as fresh every time
    // the player reopened the tab would be the same lie in the other direction.
    let s = createCampaign({ seed: 72, recruits: 4 })
    s = fight(s, 1, [recruitsAvailable(s)[0]!.id])
    expect(bootHillModel(s, []).fallenThisMission).toEqual([])
  })

  it('a mission nobody lost marks nobody', () => {
    const before = createCampaign({ seed: 8, recruits: 4 })
    const after = fight(before, 1, [])
    expect(
      bootHillModel(after, promotionsBetween(before, after), before).fallenThisMission,
    ).toEqual([])
  })

  it('a wipe puts the whole squad on the hill at once', () => {
    const before = createCampaign({ seed: 9, recruits: 4 })
    const all = recruitsAvailable(before).map((m) => m.id)
    const after = fight(before, 3, all, 'failed')
    const model = bootHillModel(after, promotionsBetween(before, after), before)
    expect(model.graves).toHaveLength(4)
    expect(model.fallenThisMission).toHaveLength(4)
  })

  it('is a copy a screen can hold', () => {
    const before = createCampaign({ seed: 10, recruits: 3 })
    const after = fight(before, 1, [recruitsAvailable(before)[0]!.id])
    const model = bootHillModel(after, [])
    expect(model.graves).not.toBe(after.dead)
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })

  it('a stone carries the four things it promised and nothing else', () => {
    /**
     * `not.toBe` and a JSON round-trip both accept a WIDER object, and TypeScript
     * accepts one structurally — so spreading the campaign's own `DeadRecruit`
     * into a grave passed every check here while leaking `id`, `status`,
     * `missionsSurvived` and the live `rank` into a `src/ui` contract for good.
     * What a screen is handed is what a screen will end up depending on.
     */
    const before = createCampaign({ seed: 11, recruits: 3 })
    const after = fight(before, 2, [recruitsAvailable(before)[0]!.id])
    const stone = bootHillModel(after, []).graves[0]
    expect(Object.keys(stone ?? {}).sort()).toEqual([
      'diedOnLevel',
      'kills',
      'name',
      'rankAtDeath',
    ])
  })
})

describe('promotions', () => {
  /** Survive `n` winning missions with everybody alive. */
  const veteranise = (state: CampaignState, n: number): CampaignState => {
    let s = state
    for (let i = 0; i < n; i += 1) s = fight(s, 1, [])
    return s
  }

  it('nobody is promoted for standing still', () => {
    const s = createCampaign({ seed: 21, recruits: 3 })
    expect(promotionsBetween(s, s)).toEqual([])
  })

  it('names the man who crossed a threshold, and both ranks', () => {
    const step = RANKS[1]?.missionsRequired ?? 2
    const before = veteranise(createCampaign({ seed: 22, recruits: 3 }), step - 1)
    const after = fight(before, 1, [])
    const promoted = promotionsBetween(before, after)
    expect(promoted).toHaveLength(recruitsAvailable(before).length)
    expect(promoted[0]?.from).toBe(RANKS[0]?.name)
    expect(promoted[0]?.to).toBe(RANKS[1]?.name)
    expect(promoted[0]?.name.length).toBeGreaterThan(0)
  })

  it('covers only THIS mission, not the whole campaign', () => {
    /**
     * The list is what the player earned just now. Recomputing it from the
     * campaign's total record would re-announce every promotion ever, every
     * time — the screen would grow a paragraph a mission and mean nothing.
     */
    const step = RANKS[1]?.missionsRequired ?? 2
    let s = veteranise(createCampaign({ seed: 23, recruits: 3 }), step)
    const beforeNext = s
    s = fight(s, 2, [])
    expect(promotionsBetween(beforeNext, s)).toEqual([])
  })

  it('a mission that promoted nobody promotes nobody', () => {
    const before = createCampaign({ seed: 24, recruits: 3 })
    const after = fight(before, 1, [])
    // One survived mission, and the second rung needs more than one.
    const step = RANKS[1]?.missionsRequired ?? 2
    expect(promotionsBetween(before, after)).toEqual(step > 1 ? [] : promotionsBetween(before, after))
  })

  it('a man who DIED is never listed as promoted', () => {
    /**
     * He did not survive the mission, so `applyMissionReport` credits him
     * nothing — and a posthumous promotion printed beside his own gravestone,
     * on the same screen, would read as a bug in the most conspicuous place the
     * game has.
     */
    const step = RANKS[1]?.missionsRequired ?? 2
    const before = veteranise(createCampaign({ seed: 25, recruits: 3 }), step - 1)
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 2, [doomed.id])
    const promoted = promotionsBetween(before, after).map((p) => p.name)
    expect(promoted).not.toContain(doomed.name)
    expect(bootHillModel(after, promotionsBetween(before, after)).graves.map((g) => g.name)).toEqual(
      [doomed.name],
    )
  })

  it('and his squadmates who lived still are', () => {
    // The control: a mission with a casualty still promotes the survivors.
    const step = RANKS[1]?.missionsRequired ?? 2
    const before = veteranise(createCampaign({ seed: 26, recruits: 4 }), step - 1)
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 2, [doomed.id])
    expect(promotionsBetween(before, after).length).toBeGreaterThan(0)
  })

  it('a defeat promotes nobody, however many survive it', () => {
    const step = RANKS[1]?.missionsRequired ?? 2
    let s = veteranise(createCampaign({ seed: 27, recruits: 3 }), step - 1)
    const beforeLoss = s
    s = fight(s, 2, [], 'failed')
    expect(promotionsBetween(beforeLoss, s)).toEqual([])
  })

  it('a new recruit who was not there before is not a promotion', () => {
    /**
     * THE FIRST DRAFT OF THIS COULD NOT FAIL. It built `grown` as
     * `{ ...after, recruits: after.recruits }` — which is just `after` — so no
     * recruit was ever introduced and the answer was `[]` whatever the
     * implementation did. A mutant reporting every unknown man as promoted to
     * the bottom rank stayed green.
     *
     * Auto-fill genuinely issues men between missions, so this is a real path: a
     * naive diff sees somebody on the `after` roster who was not on the `before`
     * one and calls it a promotion. He was not promoted, he was recruited.
     */
    const before = createCampaign({ seed: 28, recruits: 2 })
    const grown = recruit(before, 6)
    expect(recruitsAvailable(grown).length).toBeGreaterThan(recruitsAvailable(before).length)
    expect(promotionsBetween(before, grown)).toEqual([])
  })

  it('and a man who left the roster is not a promotion either', () => {
    // The other direction: somebody on `before` and absent from `after` has
    // died, and a diff that reported a missing man as a change would put a
    // promotion beside his gravestone.
    const before = createCampaign({ seed: 30, recruits: 3 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [doomed.id])
    expect(promotionsBetween(before, after).map((p) => p.name)).not.toContain(doomed.name)
  })

  it('is data, and survives a JSON round-trip', () => {
    const step = RANKS[1]?.missionsRequired ?? 2
    const before = veteranise(createCampaign({ seed: 29, recruits: 3 }), step - 1)
    const after = fight(before, 1, [])
    const promoted = promotionsBetween(before, after)
    expect(JSON.parse(JSON.stringify(promoted))).toEqual(promoted)
  })
})

describe('the hill survives a reload', () => {
  it('the same stones come back, in the same order', () => {
    /**
     * Boot Hill is the reason ticket 019 exists. A memorial that emptied when
     * the player closed the tab would be worse than no memorial — it would
     * teach them the deaths did not matter.
     */
    let stored: string | null = null
    const port: PersistencePort = {
      load: () => stored,
      save: (state) => {
        stored = JSON.stringify(state)
      },
    }
    let s = createCampaign({ seed: 31, recruits: 8 })
    for (let level = 1; level <= 3; level += 1) {
      s = fight(s, level, [recruitsAvailable(s)[0]!.id])
    }
    const before = bootHillModel(s, [])
    saveCampaign(port, s)
    const reloaded = loadCampaign(port)
    expect(reloaded.notice).toBeNull()
    expect(bootHillModel(reloaded.state, [])).toEqual(before)
  })

  it('and the ranks on them are the ranks they were carved with', () => {
    // The freeze ticket 019 fixed, seen from the screen that depends on it.
    let stored: string | null = null
    const port: PersistencePort = {
      load: () => stored,
      save: (state) => {
        stored = JSON.stringify(state)
      },
    }
    const step = RANKS[1]?.missionsRequired ?? 2
    let s = createCampaign({ seed: 32, recruits: 4 })
    for (let i = 0; i < step; i += 1) s = fight(s, 1, [])
    const veteran = recruitsAvailable(s)[0]!
    expect(veteran.rank).toBe(RANKS[1]?.name)
    s = fight(s, 2, [veteran.id])
    saveCampaign(port, s)
    const stone = bootHillModel(loadCampaign(port).state, []).graves[0]
    expect(stone?.rankAtDeath).toBe(RANKS[1]?.name)
  })
})

describe('the Recruitment screen says how many men it will assign for you', () => {
  it('none when the player has picked a full squad', () => {
    const s = createCampaign({ seed: 41, recruits: 6 })
    const chosen = recruitsAvailable(s).slice(0, 3).map((r) => r.id)
    expect(recruitmentModel(s, levelWith(3), chosen).autoFilled).toBe(0)
  })

  it('the shortfall when the roster leaves him no choice', () => {
    /**
     * THE TRAP TICKET 021 LEFT FOR THIS ONE. Auto-fill silently completes a
     * short selection when the roster is no bigger than the squad, so the same
     * click means "refused" or "deploys three men you did not pick" depending on
     * a quantity the screen never showed. The button can now say so.
     */
    const s = createCampaign({ seed: 42, recruits: 4 })
    expect(recruitmentModel(s, levelWith(4), []).autoFilled).toBe(4)
  })

  it('counts only the shortfall, not the whole squad', () => {
    const s = createCampaign({ seed: 43, recruits: 4 })
    const chosen = recruitsAvailable(s).slice(0, 1).map((r) => r.id)
    expect(recruitmentModel(s, levelWith(4), chosen).autoFilled).toBe(3)
  })

  it('is zero when a short selection would be REFUSED rather than filled', () => {
    // The other side of 021's rule: with more living men than slots, a short
    // list is a half-made choice and nothing is assigned for him.
    const s = createCampaign({ seed: 44, recruits: 8 })
    const chosen = recruitsAvailable(s).slice(0, 1).map((r) => r.id)
    expect(recruitmentModel(s, levelWith(3), chosen).autoFilled).toBe(0)
  })

  it('promises nothing when the selection would be REFUSED for any reason', () => {
    /**
     * `autoFilled` printed over a button that refuses is worse than no notice at
     * all — it tells the player men will be assigned and then nothing happens.
     * The first draft only covered ONE refusal (a roster bigger than the squad),
     * so an implementation that ignored the player's picks entirely and asked
     * "how many would a blank selection need" answered 2 for a duplicate-id
     * click that `selectSquad` rejects outright.
     */
    const s = createCampaign({ seed: 46, recruits: 3 })
    const men = recruitsAvailable(s).map((r) => r.id)
    const one = men[0] ?? ''
    for (const [label, chosen] of [
      ['a duplicate id', [one, one]],
      ['an unknown id', [one, 'ghost']],
      ['more men than slots', men.slice(0, 3)],
    ] as const) {
      expect({ label, autoFilled: recruitmentModel(s, levelWith(2), chosen).autoFilled }).toEqual({
        label,
        autoFilled: 0,
      })
    }
  })

  it('promises nothing when a dead man is among the picks', () => {
    let s = createCampaign({ seed: 47, recruits: 4 })
    const doomed = recruitsAvailable(s)[0]!
    s = fight(s, 1, [doomed.id])
    const living = recruitsAvailable(s)[0]!
    expect(recruitmentModel(s, levelWith(4), [living.id, doomed.id]).autoFilled).toBe(0)
  })

  it('still works when the screen has not asked about a selection yet', () => {
    // The screen renders before the player clicks anything.
    const s = createCampaign({ seed: 45, recruits: 6 })
    expect(() => recruitmentModel(s, levelWith(3))).not.toThrow()
  })
})

/**
 * Ticket 054 — the memorial is the original's screen: a scoreboard, a roster
 * column and a hillside.
 *
 * `assets/mockups/boot-hill.jpg`. The layout is `src/ui`'s and untestable here;
 * what these pin are the three things the screen was given so that it would not
 * have to work them out inside a `div`.
 */
describe('the scoreboard and the column beside the hill', () => {
  it('HOME is every enemy this campaign has killed, the dead mens kills included', () => {
    /**
     * THE SUM THAT IS EASY TO GET WRONG. A dead man's kills count and he is NOT
     * on the roster to be counted — a total folded over `state.recruits` alone
     * would quietly shrink every time somebody died, telling the player his
     * campaign had killed fewer enemies than it had a mission ago.
     */
    const before = createCampaign({ seed: 61, recruits: 3 })
    const doomed = recruitsAvailable(before)[0]!
    // `fight` credits the dead man 2 kills and each survivor 1.
    const after = fight(before, 1, [doomed.id])
    const model = bootHillModel(after, promotionsBetween(before, after), before)
    expect(model.enemyKilled).toBe(4)
  })

  it('AWAY is the men in the ground, which is the hill itself', () => {
    const before = createCampaign({ seed: 62, recruits: 4 })
    const men = recruitsAvailable(before)
    const after = fight(before, 1, [men[0]!.id, men[1]!.id])
    const model = bootHillModel(after, promotionsBetween(before, after), before)
    expect(model.casualties).toBe(2)
    expect(model.casualties).toBe(model.graves.length)
  })

  it('the SQUAD column is who is still standing, and never a man on the hill', () => {
    /**
     * THE ONE ARRANGEMENT WHERE THE TWO COLUMNS CANNOT NAME THE SAME MAN TWICE.
     * The caller hands over the squad records it can still find on the LIVING
     * roster, so a man who fell this mission is a cross and a HEROES row and
     * nothing else.
     */
    const before = createCampaign({ seed: 63, recruits: 4 })
    const men = recruitsAvailable(before)
    const doomed = men[0]!
    const after = fight(before, 1, [doomed.id])
    const survivors = recruitsAvailable(after)
    const model = bootHillModel(after, promotionsBetween(before, after), before, survivors)
    expect(model.squad.map((m) => m.name)).not.toContain(doomed.name)
    expect(model.squad.map((m) => m.name)).toEqual(survivors.map((m) => m.name))
  })

  it('and each standing man carries his rank and his tally', () => {
    const before = createCampaign({ seed: 64, recruits: 2 })
    const after = fight(before, 1, [])
    const survivors = recruitsAvailable(after)
    const model = bootHillModel(after, promotionsBetween(before, after), before, survivors)
    expect(model.squad[0]).toEqual({
      name: survivors[0]!.name,
      rank: survivors[0]!.rank,
      kills: survivors[0]!.kills,
    })
  })

  it('a caller with no squad to name gets an empty column, not the whole roster', () => {
    // A reload, or a memorial reached before anybody deployed. Showing the
    // living roster instead would put men in the SQUAD column who never left
    // the beach.
    const s = createCampaign({ seed: 65, recruits: 5 })
    expect(bootHillModel(s, []).squad).toEqual([])
  })

  it('the squad column is a copy, not a window onto the roster', () => {
    // The same rule every model in this codebase follows: a screen must not be
    // able to reach into the campaign through the thing it was handed to draw.
    const s = createCampaign({ seed: 66, recruits: 3 })
    const roster = recruitsAvailable(s)
    const model = bootHillModel(s, [], undefined, roster)
    expect(model.squad).not.toBe(roster)
    expect(model.squad[0]).not.toBe(roster[0])
  })
})
