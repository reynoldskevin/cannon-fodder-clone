import { describe, it, expect } from 'vitest'
import { briefingModel, debriefModel } from '../index'
import { createCampaign, recruitsAvailable } from '../../campaign'
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
    const { before, men, report } = played(1, 1, 0)
    const model = debriefModel(before, report)
    const dead = men[1]
    expect(model.casualties[0]?.rank).toBe(dead?.rank)
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
