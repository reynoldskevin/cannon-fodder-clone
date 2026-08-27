import { describe, it, expect } from 'vitest'
import {
  applyMissionReport,
  bootHillModel,
  createCampaign,
  loadCampaign,
  recruitmentModel,
  recruitsAvailable,
  saveCampaign,
  RANKS,
  rankIndexFor,
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
    expect(bootHillModel(s).graves).toEqual([])
  })

  it('carves a stone for the man who fell', () => {
    const before = createCampaign({ seed: 2, recruits: 4 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [doomed.id])
    const graves = bootHillModel(after).graves
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
    const stone = bootHillModel(after).graves[0]
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
    expect(bootHillModel(after).graves[0]?.kills).toBeGreaterThan(0)
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
    const graves = bootHillModel(s).graves
    expect(graves.map((g) => g.name)).toEqual(fallen)
    expect(graves.map((g) => g.diedOnLevel)).toEqual([1, 2, 3, 4])
  })

  it('keeps two men who fell on the same level, both of them', () => {
    const before = createCampaign({ seed: 6, recruits: 5 })
    const men = recruitsAvailable(before).slice(0, 2)
    const after = fight(before, 2, men.map((m) => m.id))
    expect(bootHillModel(after).graves).toHaveLength(2)
  })

  it('marks the men who fell THIS mission, so the new stones stand out', () => {
    let s = createCampaign({ seed: 7, recruits: 6 })
    const first = recruitsAvailable(s)[0]!
    s = fight(s, 1, [first.id])
    const beforeSecond = s
    const second = recruitsAvailable(s)[0]!
    s = fight(s, 2, [second.id])
    const model = bootHillModel(s, beforeSecond)
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
    const model = bootHillModel(s, beforeRetry)
    expect(model.graves.map((g) => g.name)).toEqual([firstAttempt.name, secondAttempt.name])
    expect(model.fallenThisMission.map((g) => g.name)).toEqual([secondAttempt.name])
  })

  it('marks nobody when it has no previous state to compare against', () => {
    // What a RELOAD is: the campaign comes back and nothing fell this session,
    // so no stone is new. Marking the last mission's dead as fresh every time
    // the player reopened the tab would be the same lie in the other direction.
    let s = createCampaign({ seed: 72, recruits: 4 })
    s = fight(s, 1, [recruitsAvailable(s)[0]!.id])
    expect(bootHillModel(s).fallenThisMission).toEqual([])
  })

  it('a mission nobody lost marks nobody', () => {
    const before = createCampaign({ seed: 8, recruits: 4 })
    const after = fight(before, 1, [])
    expect(
      bootHillModel(after, before).fallenThisMission,
    ).toEqual([])
  })

  it('a wipe puts the whole squad on the hill at once', () => {
    const before = createCampaign({ seed: 9, recruits: 4 })
    const all = recruitsAvailable(before).map((m) => m.id)
    const after = fight(before, 3, all, 'failed')
    const model = bootHillModel(after, before)
    expect(model.graves).toHaveLength(4)
    expect(model.fallenThisMission).toHaveLength(4)
  })

  it('is a copy a screen can hold', () => {
    const before = createCampaign({ seed: 10, recruits: 3 })
    const after = fight(before, 1, [recruitsAvailable(before)[0]!.id])
    const model = bootHillModel(after)
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
    const stone = bootHillModel(after).graves[0]
    expect(Object.keys(stone ?? {}).sort()).toEqual([
      'diedOnLevel',
      'kills',
      'name',
      'rankAtDeath',
      // Ticket 062. The badge, found from `rankAtDeath` and nullable — see
      // `Grave.rankIndex`. Listed here because this case is a CLOSED list on
      // purpose: what a screen is handed is what a screen ends up depending on.
      'rankIndex',
    ])
  })
})

describe('promotion still happens — it is only the announcement that went', () => {
  /**
   * Ticket 063 removed the PROMOTIONS box, and with it `promotionsBetween` and
   * the `Promotion` type, which existed only to feed it. This block replaces the
   * eight cases that went with them, and it exists to hold the line the removal
   * could most plausibly have crossed: the box is gone, PROMOTION IS NOT.
   *
   * WHY THE OLD CASES COULD NOT SIMPLY BE KEPT: every one of them called
   * `promotionsBetween`, which no longer exists. What they were really asserting
   * — that a survived mission raises a man's rank, that a dead man is never
   * promoted, and that a defeat promotes nobody — is a property of
   * `applyMissionReport` and `rankFor`, and is asserted here against those
   * directly. That is a better place for it: it was only ever observable through
   * the announcement by accident.
   */

  /** Survive `n` winning missions with everybody alive. */
  const veteranise = (state: CampaignState, n: number): CampaignState => {
    let s = state
    for (let i = 0; i < n; i += 1) s = fight(s, 1, [])
    return s
  }

  it('a survived mission still raises a man one rung', () => {
    const before = createCampaign({ seed: 21, recruits: 3 })
    const man = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [])
    const same = recruitsAvailable(after).find((m) => m.id === man.id)
    expect({ from: man.rank, to: same?.rank }).toEqual({
      from: RANKS[0]?.name,
      to: RANKS[1]?.name,
    })
  })

  it('and goes on raising him, one rung a mission', () => {
    let s = createCampaign({ seed: 22, recruits: 3 })
    const id = recruitsAvailable(s)[0]!.id
    const climb: string[] = []
    for (let mission = 0; mission < 5; mission += 1) {
      climb.push(recruitsAvailable(s).find((m) => m.id === id)?.rank ?? '')
      s = fight(s, 1, [])
    }
    expect(climb).toEqual(RANKS.slice(0, 5).map((r) => r.name))
  })

  it('a defeat still promotes nobody', () => {
    /**
     * PROMOTION IS BY SURVIVED VICTORIES ONLY, and a ladder that counted a rout
     * would promote a squad for losing repeatedly. This was one of the removed
     * cases and is the one most worth keeping: it is a rule about
     * `applyMissionReport`, and the announcement was only ever how it was seen.
     */
    const before = veteranise(createCampaign({ seed: 27, recruits: 3 }), 2)
    const ranksBefore = recruitsAvailable(before).map((m) => m.rank)
    const after = fight(before, 2, [], 'failed')
    expect(recruitsAvailable(after).map((m) => m.rank)).toEqual(ranksBefore)
  })

  it('and a man who died is not promoted on his way to the grave', () => {
    /**
     * He did not survive the mission, so he is credited nothing — and the stone
     * carries the rank he actually held. A posthumous promotion carved on a
     * gravestone would be a bug in the most conspicuous place the game has.
     */
    const before = veteranise(createCampaign({ seed: 25, recruits: 3 }), 2)
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 2, [doomed.id])
    const stone = bootHillModel(after).graves.find((g) => g.name === doomed.name)
    expect(stone?.rankAtDeath).toBe(doomed.rank)
  })

  it('and his squadmates who lived are still promoted', () => {
    // The control: a mission with a casualty still raises the survivors.
    const before = veteranise(createCampaign({ seed: 26, recruits: 4 }), 1)
    const doomed = recruitsAvailable(before)[0]!
    const survivor = recruitsAvailable(before)[1]!
    const after = fight(before, 2, [doomed.id])
    const same = recruitsAvailable(after).find((m) => m.id === survivor.id)
    expect(same?.rank).not.toBe(survivor.rank)
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
    const before = bootHillModel(s)
    saveCampaign(port, s)
    const reloaded = loadCampaign(port)
    expect(reloaded.notice).toBeNull()
    expect(bootHillModel(reloaded.state)).toEqual(before)
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
    const stone = bootHillModel(loadCampaign(port).state).graves[0]
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
    const model = bootHillModel(after, before)
    expect(model.enemyKilled).toBe(4)
  })

  it('AWAY is the men in the ground, which is the hill itself', () => {
    const before = createCampaign({ seed: 62, recruits: 4 })
    const men = recruitsAvailable(before)
    const after = fight(before, 1, [men[0]!.id, men[1]!.id])
    const model = bootHillModel(after, before)
    expect(model.casualties).toBe(2)
    expect(model.casualties).toBe(model.graves.length)
  })

  it('the SQUAD column is every man still alive, not the survivors of the mission', () => {
    /**
     * TICKET 056, AND IT IS THE ORDINARY CASE RATHER THAN AN EDGE ONE. Level 1
     * sends two men. Both die. Built from the men who DEPLOYED, the column was
     * empty — "Nobody came back" — while six recruits stood waiting for the next
     * mission. The column answers "who have I got", and a man in reserve counts.
     */
    const before = createCampaign({ seed: 63, recruits: 8 })
    const men = recruitsAvailable(before)
    const after = fight(before, 1, [men[0]!.id, men[1]!.id])
    const model = bootHillModel(after, before)
    expect(model.squad).toHaveLength(6)
    expect(model.graves).toHaveLength(2)
  })

  it('and never a man who is on the hill', () => {
    // It falls out of `recruitsAvailable` reading the LIVING roster rather than
    // out of a check: a man who fell is a cross and a HEROES row and nothing
    // else, so the two columns cannot name him twice.
    const before = createCampaign({ seed: 64, recruits: 4 })
    const doomed = recruitsAvailable(before)[0]!
    const after = fight(before, 1, [doomed.id])
    const model = bootHillModel(after, before)
    expect(model.squad.map((m) => m.name)).not.toContain(doomed.name)
    expect(model.graves.map((g) => g.name)).toContain(doomed.name)
  })

  it('and each man carries his rank and his tally', () => {
    const before = createCampaign({ seed: 65, recruits: 2 })
    const after = fight(before, 1, [])
    const living = recruitsAvailable(after)
    const model = bootHillModel(after, before)
    expect(model.squad[0]).toEqual({
      name: living[0]!.name,
      rank: living[0]!.rank,
      // Ticket 062: derived from the same record his rank is.
      rankIndex: rankIndexFor(living[0]!.missionsSurvived),
      kills: living[0]!.kills,
    })
  })

  it('an empty column means the campaign has no men left at all', () => {
    // The only way to empty it now, and it is terminal rather than routine.
    const before = createCampaign({ seed: 66, recruits: 2 })
    const men = recruitsAvailable(before)
    const after = fight(before, 1, [men[0]!.id, men[1]!.id])
    expect(bootHillModel(after, before).squad).toEqual([])
  })

  it('the squad column is a copy, not a window onto the roster', () => {
    // The same rule every model in this codebase follows: a screen must not be
    // able to reach into the campaign through the thing it was handed to draw.
    const s = createCampaign({ seed: 67, recruits: 3 })
    const roster = recruitsAvailable(s)
    const model = bootHillModel(s)
    expect(model.squad[0]).not.toBe(roster[0])
    expect(model.squad.map((m) => m.name)).toEqual(roster.map((m) => m.name))
  })
})

describe('the badge beside each name (ticket 062)', () => {
  /**
   * THE MODEL CARRIES AN INDEX, NOT A URL AND NOT A CELL. Boot Hill is a `div`
   * with no tests, so "which badge" is decided here and the screen only draws
   * it — the same split every other field on this model is built on.
   */

  it('a living man`s badge is derived, like his rank', () => {
    const s = createCampaign({ seed: 70, recruits: 4 })
    const model = bootHillModel(s)
    for (const man of model.squad) {
      expect({ rank: man.rank, badge: RANKS[man.rankIndex]?.name }).toEqual({
        rank: man.rank,
        badge: man.rank,
      })
    }
  })

  it('and it climbs as he survives missions', () => {
    /**
     * ONE RUNG PER MISSION IS THE WHOLE TICKET, seen from the screen. A badge
     * that never moved would be the failure a player would actually notice, and
     * it is invisible to every assertion about `rank` alone if the two were
     * computed apart.
     */
    let s = createCampaign({ seed: 71, recruits: 4 })
    const seen: number[] = []
    for (let mission = 0; mission < 5; mission += 1) {
      const first = bootHillModel(s).squad[0]
      if (first !== undefined) seen.push(first.rankIndex)
      s = fight(s, 1, [])
    }
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  it('and a grave`s badge comes from the rank CARVED on it', () => {
    /**
     * NOT FROM HIS MISSION COUNT. `types.ts` argues at length that a dead man's
     * rank is recorded and never recomputed — his record has stopped changing,
     * so recomputing can only overwrite a fact with a guess made under a newer
     * table. The badge has to obey the same rule or the stone would say one
     * thing in words and another in metal.
     */
    let s = createCampaign({ seed: 72, recruits: 4 })
    for (let mission = 0; mission < 3; mission += 1) s = fight(s, 1, [])
    const veteran = recruitsAvailable(s)[0]!
    const after = fight(s, 2, [veteran.id])
    const stone = bootHillModel(after).graves.find((g) => g.name === veteran.name)
    expect(stone?.rankAtDeath).toBe(veteran.rank)
    expect(RANKS[stone?.rankIndex ?? -1]?.name).toBe(veteran.rank)
  })

  it('and a stone carved under a ladder that no longer has that rank gets NO badge', () => {
    /**
     * THE MIGRATION CASE, AND THE REASON THE FIELD IS NULLABLE. A save written
     * before this ticket can name a rank the table no longer has. Falling back
     * to index 0 would pin a private's single chevron on a dead Major —
     * silently, on a memorial. `null` means the screen draws nothing.
     *
     * Built by hand rather than through `fight`, because there is no way to make
     * today's ladder write yesterday's name.
     */
    const s = createCampaign({ seed: 73, recruits: 2 })
    const doomed = recruitsAvailable(s)[0]!
    const legacy: CampaignState = {
      ...s,
      recruits: s.recruits.filter((r) => r.id !== doomed.id),
      dead: [
        {
          id: doomed.id,
          name: doomed.name,
          missionsSurvived: 3,
          kills: 1,
          rank: 'Field Marshal',
          status: 'dead',
          diedOnLevel: 2,
          rankAtDeath: 'Field Marshal',
        },
      ],
    }
    const stone = bootHillModel(legacy).graves[0]
    // The words are untouched — the stone still says what it always said.
    expect(stone?.rankAtDeath).toBe('Field Marshal')
    // Only the badge is withheld.
    expect(stone?.rankIndex).toBeNull()
  })
})

describe('and the model no longer carries what the box needed (ticket 063)', () => {
  it('has no promotions field at all', () => {
    /**
     * A CLOSED LIST, for the reason the grave's own key check gives: what a
     * screen is handed is what a screen ends up depending on. A `promotions: []`
     * left behind after the box went would be a field nothing writes, nothing
     * reads and nothing removes — and the next person to open this file would
     * have to work out which of those it was.
     */
    const s = createCampaign({ seed: 80, recruits: 3 })
    const after = fight(s, 1, [recruitsAvailable(s)[0]!.id])
    expect(Object.keys(bootHillModel(after, s)).sort()).toEqual([
      'casualties',
      'enemyKilled',
      'fallenThisMission',
      'graves',
      'squad',
    ])
  })

  it('and still marks this mission`s stones as fresh, which is what `previous` is FOR', () => {
    /**
     * THE THING MOST AT RISK IN THIS REMOVAL. `previous` was the THIRD argument
     * and the promotions list was the second; dropping the middle one means
     * every call site shifts, and a caller that passed its before-state into the
     * wrong slot would silently stop marking fresh graves — the screen would
     * still render, every stone weathered, and nothing would raise.
     */
    const before = createCampaign({ seed: 81, recruits: 4 })
    const first = recruitsAvailable(before)[0]!
    const afterFirst = fight(before, 1, [first.id])
    const second = recruitsAvailable(afterFirst)[0]!
    const afterSecond = fight(afterFirst, 2, [second.id])

    const model = bootHillModel(afterSecond, afterFirst)
    expect(model.graves).toHaveLength(2)
    // Only the man who fell on THIS mission is fresh.
    expect(model.fallenThisMission.map((g) => g.name)).toEqual([second.name])
  })

  it('and a model built with no before-state marks nothing fresh', () => {
    // What a reload is. Unchanged by this ticket, and asserted because the
    // argument it depends on just moved position.
    const before = createCampaign({ seed: 82, recruits: 3 })
    const after = fight(before, 1, [recruitsAvailable(before)[0]!.id])
    expect(bootHillModel(after).fallenThisMission).toEqual([])
  })
})
