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
 *
 * `debriefModel` HAS NO SCREEN AS OF TICKET 040, AND IS KEPT ANYWAY. That ticket
 * removed the Debrief from the chart and said out loud what goes with it: the
 * post-mission summary. Boot Hill is its right home — a memorial that does not
 * name the men who just died is not doing its job — and folding it in is the
 * next ticket's, not something to smuggle into the one that moved the screens.
 * Deleting the fold in the meantime would throw away the one function that makes
 * the summary and `applyMissionReport` agree about who died.
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
  /**
   * The campaign position of this mission, ONE-BASED (ticket 040).
   *
   * The card reads "Mission 1", and the index it is derived from is zero-based —
   * which is the sort of off-by-one that ships, because "Mission 0" looks like a
   * placeholder rather than a bug. Converted here, once, so no screen has to
   * remember to add one.
   */
  readonly levelNumber: number
  /**
   * How many men are going in.
   *
   * ALWAYS `squad.length`, NEVER A SECOND OPINION ABOUT IT. The card reads "with
   * N soldiers you must…", and a card saying four over a three-man deployment
   * would be the game lying about the only number on the screen. It is a field
   * rather than left to the screen's own `squad.length` so that the count and
   * the list cannot be computed from two different places.
   */
  readonly soldierCount: number
  readonly levelName: string
  /** The level's objective `type` strings, in the order the level declares them. */
  readonly objectives: readonly string[]
  /** In assignment order. */
  readonly squad: readonly FlowSoldier[]
}

/** The post-mission summary, awaiting the Boot Hill screen that will show it. */
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
 *
 * `levelIndex` IS THE ZERO-BASED CAMPAIGN POSITION, and the +1 that makes it a
 * mission number happens exactly here (ticket 040). The runner derives that
 * index from `unlockedLevels` and indexes its level array with it, so handing
 * this function the one-based number instead would put the conversion at every
 * call site and leave one of them to get it wrong.
 *
 * IT DEFAULTS TO 0, WHICH IS "MISSION 1". A campaign that has not said where it
 * is up to is at its start, and that is the only answer a briefing with no
 * position can honestly give — the alternatives are `NaN` on the card, or a
 * required argument that every caller with nothing to say fills in with 0
 * anyway.
 */
export function briefingModel(
  level: LevelData,
  squad: readonly Recruit[],
  levelIndex = 0,
): BriefingModel {
  const men = squad.map(soldier)
  return {
    levelNumber: levelIndex + 1,
    // READ OFF THE LIST THIS MODEL IS ABOUT TO RETURN, not off `squad`: the two
    // are the same length today and would stay the same length only by accident
    // if a later ticket ever filtered `men`.
    soldierCount: men.length,
    levelName: level.name,
    objectives: level.objectives.map((objective) => objective.type),
    squad: men,
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
