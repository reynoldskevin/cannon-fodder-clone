/**
 * WHAT THE BRIEFING AND DEBRIEF SCREENS SAY, AS VALUES (ticket 020).
 *
 * `src/ui` has no tests and cannot have any: Vitest runs `environment: 'node'`
 * and there is no DOM to render into. So an acceptance criterion phrased as
 * "the Briefing shows the assigned squad" becomes unverifiable the moment the
 * deciding happens inside a `div`. Everything decided here is pulled out into
 * plain data and the screen becomes a loop over it — the same split ticket 014
 * made between `core/debug/layers.ts` and `ui/debug-panel.ts`.
 *
 * BOTH MODELS ARE JSON, no exceptions: they cross a module boundary into `ui`,
 * so they must be values rather than views onto live campaign state that changes
 * under the screen still holding it.
 */

import { foldMissionEntries, rankFor } from '../campaign'
import type { LevelData } from '../level/types'
import type { CampaignState, MissionOutcome, MissionReport, Recruit } from '../campaign'

/**
 * A man as a screen names him.
 *
 * NAME AND RANK, NEVER A COUNT. "3 soldiers" is a number; the campaign only
 * means anything because the men have names, and this is the shape both screens
 * read them from — which is also what makes the Debrief and Boot Hill agree
 * about who died.
 */
export interface FlowSoldier {
  readonly id: string
  readonly name: string
  readonly rank: string
}

/** Everything the Briefing screen renders. */
export interface BriefingModel {
  readonly levelName: string
  /** The level's objective `type` strings, in the order the level declares them. */
  readonly objectives: readonly string[]
  /** In assignment order. */
  readonly squad: readonly FlowSoldier[]
}

/** Everything the Debrief screen renders. */
export interface DebriefModel {
  readonly outcome: MissionOutcome
  readonly kills: number
  readonly casualties: readonly FlowSoldier[]
  readonly survivors: readonly FlowSoldier[]
}

const soldier = (man: Recruit): FlowSoldier => ({ id: man.id, name: man.name, rank: man.rank })

/**
 * What the player reads before risking his men.
 *
 * Objective order is the LEVEL AUTHOR'S and is preserved verbatim. Reordering
 * them for the briefing would make it disagree with the HUD that shows the same
 * list during play, and the player would be checking two lists against each
 * other instead of the map.
 */
export function briefingModel(level: LevelData, squad: readonly Recruit[]): BriefingModel {
  return {
    levelName: level.name,
    objectives: level.objectives.map((objective) => objective.type),
    squad: squad.map(soldier),
  }
}

/**
 * What came back, and who did not.
 *
 * `before` IS THE CAMPAIGN AS IT STOOD BEFORE THE REPORT WAS APPLIED, and the
 * argument order is the whole point: apply it first and the casualties are
 * already off the roster, so a Debrief built from the after-state names nobody —
 * a silent empty list of the dead, which reads as a clean mission rather than a
 * wiped squad.
 *
 * An entry naming nobody on the roster is SKIPPED — not rendered, not thrown on,
 * and its kills not counted. Ids come from an assignment map built at spawn and
 * a stale one is possible; crediting a ghost's kills would make the Debrief
 * report a squad total larger than the sum of every man's recorded kills, so
 * Boot Hill would carve one number where the results screen showed another.
 *
 * THE FOLD IS `core/campaign`'S, DELIBERATELY. `applyMissionReport` reads this
 * exact `MissionReport` to decide who goes on Boot Hill, and a second copy of
 * the rules here would be a second answer to "who died" that nothing compares —
 * a man listed among the survivors while his gravestone is being carved. The two
 * must stay in step, so they share one function rather than two loops that agree
 * today.
 */
export function debriefModel(before: CampaignState, report: MissionReport): DebriefModel {
  const roster = new Map(before.recruits.map((record) => [record.id, record]))
  const tallies = foldMissionEntries(report.entries, (id) => roster.has(id))
  const casualties: FlowSoldier[] = []
  const survivors: FlowSoldier[] = []
  let kills = 0

  for (const [recruitId, tally] of tallies) {
    const record = roster.get(recruitId)
    if (record === undefined) continue
    kills += tally.kills
    // Rank as he HELD it — the record is the pre-mission one, so nobody is
    // credited a promotion this mission earned and a dead man never one he
    // never reached.
    const man: FlowSoldier = { id: record.id, name: record.name, rank: rankFor(record.missionsSurvived) }
    if (tally.died) casualties.push(man)
    else survivors.push(man)
  }

  return { outcome: report.outcome, kills, casualties, survivors }
}
