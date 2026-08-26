import { describe, it, expect } from 'vitest'
import { briefingModel, debriefModel } from '../index'
import { applyMissionReport, createCampaign, recruitsAvailable, RANKS } from '../../campaign'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import type { CampaignState } from '../../campaign'
import type { LevelData } from '../../level/types'

/**
 * Ticket 020 — what the Briefing and Debrief screens say.
 *
 * WHY THIS IS A MODEL AND NOT A SCREEN. `src/ui` has no tests, and cannot have
 * any: vitest runs under `environment: 'node'` and there is no DOM to render
 * into. So an acceptance criterion phrased as "Briefing shows the assigned
 * squad" is unverifiable the moment the deciding happens inside a `div`. The
 * decision is pulled out here — the same split ticket 014 made between
 * `core/debug/layers.ts` and `ui/debug-panel.ts`, and ticket 016 made for the
 * ordnance selector — and the screen becomes a loop over a value.
 *
 * `debriefModel` is handed the campaign as it stood BEFORE the mission was
 * recorded, because the men it has to name are dead by the time it is applied
 * and a dead man is off the roster.
 */

const level = (): LevelData => ({
  ...asciiLevel(`
    ....................
    ....................
    ....................
  `),
  name: 'Jungle Approach',
  objectives: [{ type: 'kill_all' }, { type: 'collect_chests', count: 2 }],
})

const squadOf = (state: CampaignState, n: number) => recruitsAvailable(state).slice(0, n)

describe('the Briefing', () => {
  it('names the level', () => {
    const s = createCampaign({ seed: 1, recruits: 4 })
    expect(briefingModel(level(), squadOf(s, 3)).levelName).toBe('Jungle Approach')
  })

  it('lists the objectives, in the order the level declares them', () => {
    // Order is the level author's, and reordering them on screen would make a
    // briefing disagree with the HUD that shows the same list during play.
    const s = createCampaign({ seed: 1, recruits: 4 })
    expect(briefingModel(level(), squadOf(s, 3)).objectives).toEqual(['kill_all', 'collect_chests'])
  })

  it('names the men going in, with their ranks', () => {
    /**
     * THE POINT OF THE SCREEN. A briefing that listed "3 soldiers" would be a
     * number; the campaign only means anything because the men have names, and
     * this is where the player reads them before risking them.
     */
    const s = createCampaign({ seed: 2, recruits: 5 })
    const squad = squadOf(s, 3)
    const model = briefingModel(level(), squad)
    expect(model.squad.map((m) => m.name)).toEqual(squad.map((m) => m.name))
    expect(model.squad.map((m) => m.rank)).toEqual(squad.map((m) => m.rank))
  })

  it('keeps the squad in the order it was assigned', () => {
    const s = createCampaign({ seed: 3, recruits: 6 })
    const squad = squadOf(s, 4)
    expect(briefingModel(level(), squad).squad.map((m) => m.id)).toEqual(squad.map((m) => m.id))
  })

  it('an empty squad is a briefing, not a crash', () => {
    // Reachable: a campaign whose roster was wiped and not yet reinforced.
    expect(() => briefingModel(level(), [])).not.toThrow()
    expect(briefingModel(level(), []).squad).toEqual([])
  })

  it('a level with no name still briefs', () => {
    const nameless = { ...level(), name: '' }
    expect(() => briefingModel(nameless, [])).not.toThrow()
  })

  it('is data, and survives a JSON round-trip', () => {
    // It crosses into `src/ui`, so it must be a value rather than a view onto
    // live state that changes under the screen holding it.
    const s = createCampaign({ seed: 4, recruits: 3 })
    const model = briefingModel(level(), squadOf(s, 2))
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })

  it('is a copy, not a window onto the caller`s arrays', () => {
    /**
     * The round-trip above cannot see this: comparing a model to ITSELF
     * round-tripped is true of any JSON-safe value, aliased or not. Handing back
     * the caller's own array is the allocation win somebody reaches for, and it
     * has already been caught three times in this codebase — the tracer buffer,
     * the ordnance system and the chest snapshot.
     */
    const s = createCampaign({ seed: 6, recruits: 4 })
    const squad = [...squadOf(s, 3)]
    const doc = level()
    const model = briefingModel(doc, squad)
    expect(model.squad).not.toBe(squad)
    expect(model.objectives).not.toBe(doc.objectives)
    squad.length = 0
    expect(model.squad).toHaveLength(3)
  })
})

describe('the Debrief', () => {
  const played = (survivors: number, casualties: number, kills: number) => {
    const before = createCampaign({ seed: 9, recruits: survivors + casualties })
    const men = recruitsAvailable(before)
    const entries = men.map((m, i) => ({
      recruitId: m.id,
      survived: i < survivors,
      kills: i === 0 ? kills : 0,
    }))
    return { before, men, report: { levelId: 2, outcome: 'complete' as const, entries } }
  }

  it('reports the outcome', () => {
    const { before, report } = played(2, 1, 0)
    expect(debriefModel(before, report).outcome).toBe('complete')
    expect(debriefModel(before, { ...report, outcome: 'failed' }).outcome).toBe('failed')
  })

  it('counts the kills the squad made between them', () => {
    const { before, report } = played(2, 1, 5)
    expect(debriefModel(before, report).kills).toBe(5)
  })

  it('names the casualties', () => {
    /**
     * NAMED, NOT COUNTED. "2 casualties" is a statistic; "Corporal Vasquez and
     * Private Pike did not return" is the reason anybody cares about the next
     * mission. It is also what Boot Hill will carve, so the two screens must
     * agree about who died.
     */
    const { before, men, report } = played(2, 2, 0)
    const model = debriefModel(before, report)
    const fallen = men.slice(2).map((m) => m.name).sort()
    expect(model.casualties.map((c) => c.name).sort()).toEqual(fallen)
  })

  it('gives each casualty the rank he held, not the one he would have earned', () => {
    /**
     * ONE MISSION SHORT OF THE SECOND RUNG, deliberately. The first draft used
     * fresh recruits, and with the ladder starting at 0 and 2 both `rankFor(0)`
     * and `rankFor(1)` answer 'Private' — so an implementation crediting
     * `missionsSurvived + 1`, the exact mistake this test is named for, passed.
     * A man who has survived ONE mission is the only place a one-mission
     * overshoot is visible.
     */
    const step = RANKS[1]?.missionsRequired ?? 2
    let s = createCampaign({ seed: 31, recruits: 2 })
    const men = recruitsAvailable(s)
    for (let i = 0; i < step - 1; i += 1) {
      s = applyMissionReport(s, {
        levelId: 1,
        outcome: 'complete',
        entries: men.map((m) => ({ recruitId: m.id, survived: true, kills: 0 })),
      })
    }
    const veteran = recruitsAvailable(s)[0]!
    expect(veteran.missionsSurvived).toBe(step - 1)
    const model = debriefModel(s, {
      levelId: 2,
      outcome: 'complete',
      entries: [{ recruitId: veteran.id, survived: false, kills: 0 }],
    })
    expect(model.casualties[0]?.rank).toBe(veteran.rank)
    expect(model.casualties[0]?.rank).not.toBe(RANKS[1]?.name)
  })

  it('names the survivors too', () => {
    const { before, men, report } = played(2, 1, 0)
    expect(debriefModel(before, report).survivors.map((s) => s.name).sort()).toEqual(
      men.slice(0, 2).map((m) => m.name).sort(),
    )
  })

  it('a mission where everybody lived has no casualties', () => {
    const { before, report } = played(3, 0, 2)
    expect(debriefModel(before, report).casualties).toEqual([])
  })

  it('a mission where nobody lived has no survivors', () => {
    const { before, report } = played(0, 3, 1)
    const model = debriefModel(before, report)
    expect(model.survivors).toEqual([])
    expect(model.casualties).toHaveLength(3)
  })

  it('counts a dead man`s kills — he still fired them', () => {
    const { before, report } = played(0, 2, 4)
    expect(debriefModel(before, report).kills).toBe(4)
  })

  it('ignores a report naming somebody who was never on the roster', () => {
    // Ids come from an assignment map built at spawn; a stale one is possible.
    const { before, report } = played(1, 1, 0)
    const stray = { ...report, entries: [...report.entries, { recruitId: 'ghost', survived: false, kills: 3 }] }
    expect(() => debriefModel(before, stray)).not.toThrow()
    expect(debriefModel(before, stray).casualties.every((c) => c.name.length > 0)).toBe(true)
  })

  it('and does not count a ghost`s kills toward the squad total', () => {
    /**
     * The Debrief is a VIEW of what the campaign will keep. `applyMissionReport`
     * skips an unknown id before its kill tally, so those kills reach no man's
     * record — and a Debrief that counted them would report a squad total
     * exceeding the sum of every soldier's kills, with nobody you could point at
     * to explain the difference. Boot Hill would then carve one number where the
     * Debrief showed another.
     */
    const { before, report } = played(2, 0, 4)
    const stray = {
      ...report,
      entries: [...report.entries, { recruitId: 'ghost', survived: true, kills: 99 }],
    }
    expect(debriefModel(before, stray).kills).toBe(4)
  })

  it('folds a man named twice into one outcome, and death wins', () => {
    /**
     * `applyMissionReport` already does this — its own comment says two entities
     * could in principle carry the same recruit id, and it resolves
     * death-beats-survival. `debriefModel` reads the SAME `MissionReport` and
     * must reach the same answer, or the Debrief lists a man among the survivors
     * AND among the dead while Boot Hill carves him once. This file's own
     * docstring promises the two screens agree about who died.
     */
    const before = createCampaign({ seed: 51, recruits: 3 })
    const man = recruitsAvailable(before)[0]!
    const model = debriefModel(before, {
      levelId: 1,
      outcome: 'complete',
      entries: [
        { recruitId: man.id, survived: true, kills: 1 },
        { recruitId: man.id, survived: false, kills: 0 },
      ],
    })
    expect(model.casualties.map((c) => c.name)).toEqual([man.name])
    expect(model.survivors.map((s) => s.name)).not.toContain(man.name)
  })

  it('never reports a kill count that is not a number', () => {
    // `applyMissionReport` drops a non-finite or negative count; a Debrief that
    // summed them raw would render "NaN kills" over a campaign that recorded
    // zero. Same report, two screens, two answers.
    const before = createCampaign({ seed: 52, recruits: 2 })
    const men = recruitsAvailable(before)
    const model = debriefModel(before, {
      levelId: 1,
      outcome: 'complete',
      entries: [
        { recruitId: men[0]!.id, survived: true, kills: Number.NaN },
        { recruitId: men[1]!.id, survived: true, kills: -3 },
      ],
    })
    expect(Number.isFinite(model.kills)).toBe(true)
    expect(model.kills).toBe(0)
  })

  it('is data, and survives a JSON round-trip', () => {
    const { before, report } = played(2, 1, 3)
    const model = debriefModel(before, report)
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })

  it('reads the campaign as it stood BEFORE the mission was recorded', () => {
    /**
     * The ordering trap. Apply the report first and the casualties are already
     * off the roster, so a Debrief built from the AFTER state can name nobody —
     * it would report a silent, empty list of the dead, which reads as a clean
     * mission rather than a wiped squad.
     */
    const { before, report } = played(1, 2, 0)
    expect(debriefModel(before, report).casualties).toHaveLength(2)
  })
})
