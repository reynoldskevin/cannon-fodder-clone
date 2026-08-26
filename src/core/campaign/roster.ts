/**
 * The campaign's pure state transitions (ticket 019).
 *
 * EVERY FUNCTION HERE RETURNS A NEW STATE. Nothing mutates the state it was
 * handed. A Debrief screen holding last mission's campaign would otherwise
 * watch it change underneath it, and the save model — "the caller flushes at a
 * mission boundary" — depends on the state it flushes being the one it read.
 *
 * PERMADEATH IS STRUCTURAL. There is no exported function that moves a man from
 * `dead` back to `recruits`, and there is no `status` setter to do it with:
 * status is derived from which list he is on. The only transition is
 * active -> dead, and it is idempotent, because one soldier really can be hit
 * by a grenade and a rifle round in the same tick and two entries must produce
 * one gravestone.
 *
 * NOTHING HERE CAN REACH A PORT. `saveCampaign` and `loadCampaign` are free
 * functions the caller invokes; the campaign never holds a port. That is what
 * makes "flushed only at mission boundaries, never mid-frame" a property of the
 * shape of the code rather than a promise somebody keeps.
 */

import type { SimEvent } from '../world/events'
import { issueNames } from './names'
import { rankFor } from './ranks'
import type {
  CampaignState,
  DeadRecruit,
  MissionReport,
  Recruit,
  RecruitRecord,
} from './types'

/**
 * How many men a campaign starts with when the caller does not say.
 *
 * More than a mission needs, because the point of a roster is choosing who goes
 * — a starting list the size of the squad makes the recruitment screen a
 * formality until the first casualty.
 */
export const DEFAULT_RECRUITS = 8

/**
 * The most men a campaign will ever hold at once.
 *
 * A CEILING, NOT A DESIGN TARGET. `recruit(state, count)` walks the shortfall,
 * so an unbounded `count` is an unbounded loop — `Math.floor(Infinity)` is
 * `Infinity`, and a caller reading a number out of a save or a text field can
 * hand one over. A hang is the one failure a test suite reports as a timeout
 * rather than a defect, and a UI that asks for too many men should get a full
 * roster rather than a dead tab. Raise it freely; it costs a name apiece.
 */
export const MAX_ROSTER = 64

/**
 * The highest level a campaign will ever unlock.
 *
 * `applyMissionReport` opens `levelId + 1`, and `levelId` comes from whatever
 * ran the mission, so ONE report naming level 9999 would otherwise hand the
 * player every level the game will ever ship. The bound means "no result of one
 * mission can unlock more of the campaign than exists"; it must stay at or
 * above the real level count, and a level list that outgrows it stops
 * progressing rather than misreporting.
 */
export const MAX_UNLOCKED_LEVELS = 32

/** Options for a new campaign. `seed` is the caller's, so `app/` owns seeding. */
export interface CreateCampaignOptions {
  readonly seed: number
  /** Starting roster size. Defaults to `DEFAULT_RECRUITS`. */
  readonly recruits?: number
}

/** Ids are stable, unique and NEVER REUSED — a dead man stays nameable. */
function recruitId(index: number): string {
  return `soldier-${index}`
}

/** A brand new campaign: nobody recruited, nobody dead, one level open. */
export function createCampaign(options: CreateCampaignOptions): CampaignState {
  const empty: CampaignState = {
    seed: options.seed,
    recruits: [],
    dead: [],
    // Exactly one. Unlocking two would let a fresh player skip the level the
    // whole tutorial value of the first mission depends on.
    unlockedLevels: 1,
    recruitsIssued: 0,
  }
  return recruit(empty, options.recruits ?? DEFAULT_RECRUITS)
}

/**
 * Top the AVAILABLE roster up to `count` men, recruiting only the shortfall.
 *
 * Topping up rather than adding is what the recruitment screen actually wants:
 * "bring me back to eight" after losing three is one call whose result does not
 * depend on how many times it was made. Note the shortfall is measured against
 * the living only — the dead are gone, and counting them would quietly stop
 * replacing casualties.
 */
export function recruit(state: CampaignState, count: number): CampaignState {
  // Clamped BEFORE the subtraction, so `Infinity` becomes a full roster and
  // `NaN` becomes no shortfall at all rather than a loop with no end. See
  // `MAX_ROSTER`: the caller of this is a UI, and a UI hands over what it read.
  const wanted = Number.isFinite(count) ? Math.min(Math.floor(count), MAX_ROSTER) : 0
  const shortfall = wanted - state.recruits.length
  if (shortfall <= 0) return state

  // Names and ids both key off `recruitsIssued`, which only ever rises, so no
  // name or id is ever handed out twice in the life of a campaign.
  const names = issueNames(state.seed, state.recruitsIssued, shortfall)
  const joined: RecruitRecord[] = names.map((name, offset) => ({
    id: recruitId(state.recruitsIssued + offset),
    name,
    missionsSurvived: 0,
    kills: 0,
  }))

  return {
    ...state,
    recruits: [...state.recruits, ...joined],
    recruitsIssued: state.recruitsIssued + shortfall,
  }
}

/**
 * The living roster, with `rank` and `status` computed on read.
 *
 * THIS IS THE ONLY PLACE A LIVING MAN'S RANK EXISTS. Storing it would let a
 * retune of `RANKS` leave every save carrying ranks that no longer match the
 * record that earned them, with nothing to report the drift.
 */
export function recruitsAvailable(state: CampaignState): readonly Recruit[] {
  return state.recruits.map((record) => ({
    id: record.id,
    name: record.name,
    rank: rankFor(record.missionsSurvived),
    missionsSurvived: record.missionsSurvived,
    kills: record.kills,
    status: 'active' as const,
  }))
}

/** What one mission did to one man, once his duplicate entries are folded together. */
interface Tally {
  kills: number
  died: boolean
}

/**
 * Record a mission against the campaign.
 *
 * The half that knows about ranks and the dead list; `missionReport` is the
 * half that knows about events. Four rules, each of which a test pins:
 *
 *   - A REPORT NAMING SOMEBODY NOT ON THE LIVING ROSTER CHANGES NOTHING. That
 *     covers a stale id, a man who died last mission, and a second report for
 *     the mission that killed him — one gravestone, and no posthumous promotion.
 *   - DEATH BEATS SURVIVAL when a man is reported as both. A report that
 *     contradicts itself has to resolve one way, and resolving it towards
 *     survival would resurrect somebody.
 *   - KILLS COUNT WHATEVER HAPPENED. He fired and the round landed; the
 *     gravestone reading "3 kills" is the point of the screen.
 *   - PROMOTION IS FOR SURVIVED VICTORIES ONLY, and unlocks follow the same
 *     rule, so grinding a defeat advances nothing.
 */
export function applyMissionReport(state: CampaignState, report: MissionReport): CampaignState {
  const living = new Set(state.recruits.map((r) => r.id))

  // Fold the entries first: one man can appear twice in a single report, and
  // every rule below has to see him once.
  const tallies = new Map<string, Tally>()
  for (const entry of report.entries) {
    if (!living.has(entry.recruitId)) continue
    const tally = tallies.get(entry.recruitId) ?? { kills: 0, died: false }
    // NEGATIVE AND NON-FINITE COUNTS ARE DROPPED, and the negative case is a
    // round-trip contradiction rather than a nit: `persistence.ts` rejects any
    // record with a negative count, so a campaign that recorded one could never
    // be read back and the player's whole save would be discarded as damaged on
    // the next launch. A state this module produces must survive its own load.
    tally.kills += Number.isFinite(entry.kills) && entry.kills > 0 ? entry.kills : 0
    if (!entry.survived) tally.died = true
    tallies.set(entry.recruitId, tally)
  }

  const survivors: RecruitRecord[] = []
  const fallen: DeadRecruit[] = []
  const victory = report.outcome === 'complete'

  for (const record of state.recruits) {
    const tally = tallies.get(record.id)
    if (tally === undefined) {
      // Not on this mission at all. He keeps his record exactly as it was —
      // including no promotion, because he did not survive anything.
      survivors.push(record)
      continue
    }
    const kills = record.kills + tally.kills
    if (tally.died) {
      fallen.push({
        id: record.id,
        name: record.name,
        // A dead man survives no further missions, so his rank is frozen here
        // and `rankAtDeath` is simply what his record already earns. They are
        // written out rather than derived on read because Boot Hill must not
        // re-inscribe a stone when a designer retunes the ladder.
        rank: rankFor(record.missionsSurvived),
        rankAtDeath: rankFor(record.missionsSurvived),
        missionsSurvived: record.missionsSurvived,
        kills,
        status: 'dead',
        diedOnLevel: report.levelId,
      })
      continue
    }
    survivors.push({
      ...record,
      kills,
      missionsSurvived: record.missionsSurvived + (victory ? 1 : 0),
    })
  }

  return {
    ...state,
    recruits: survivors,
    dead: [...state.dead, ...fallen],
    // Bounded by `MAX_UNLOCKED_LEVELS`, because `levelId` arrives from
    // whoever ran the mission: one report naming level 9999 must not hand over
    // the entire campaign. A non-finite id unlocks nothing at all.
    unlockedLevels: victory ? unlockAfter(state.unlockedLevels, report.levelId) : state.unlockedLevels,
  }
}

/**
 * What a won mission on `levelId` leaves unlocked.
 *
 * `Math.max` rather than `+= 1`: replaying a level already beaten must not
 * unlock a second one, which is the progression bug that lets a player skip a
 * level by grinding the first.
 */
function unlockAfter(unlocked: number, levelId: number): number {
  if (!Number.isFinite(levelId)) return unlocked
  return Math.min(Math.max(unlocked, Math.floor(levelId) + 1), MAX_UNLOCKED_LEVELS)
}

/**
 * Read a finished mission off the event stream.
 *
 * The half that knows about `UnitDied` and `killerId`; it touches no campaign
 * state at all, which is what lets attribution be tested without a roster and
 * the ladder be tested without an event stream.
 *
 * `assignment` maps the SIM'S entity ids to campaign recruit ids — the sim has
 * never heard of a recruit, and it must not have to.
 */
export function missionReport(
  events: readonly SimEvent[],
  assignment: ReadonlyMap<number, string>,
  levelId: number,
): MissionReport {
  const kills = new Map<string, number>()
  const dead = new Set<string>()
  // An absent `MissionComplete` is a mission still running, a crash, or a
  // truncated stream. None of those is a victory, so the default is the
  // conservative one: nobody is promoted and no level opens on a stream that
  // never said the mission was won.
  let outcome: MissionReport['outcome'] = 'failed'

  for (const event of events) {
    if (event.type === 'MissionComplete') {
      outcome = 'complete'
      continue
    }
    if (event.type === 'MissionFailed') {
      outcome = 'failed'
      continue
    }
    if (event.type !== 'UnitDied') continue

    const victim = assignment.get(event.id)
    if (victim !== undefined && event.team === 'player') dead.add(victim)

    // Friendly fire has been reachable since ticket 015 — a grenade does not
    // ask whose side anyone is on — so scoring only ENEMY deaths is a live
    // guard, not a hypothetical one. Blowing up your own corporal is not a
    // kill, and counting it would put the campaign's best marksman on Boot
    // Hill's promotion list for it.
    if (event.team !== 'enemy' || event.killerId === null) continue
    const killer = assignment.get(event.killerId)
    // An unassigned killer is another enemy: their friendly fire is not the
    // player's achievement.
    if (killer === undefined) continue
    kills.set(killer, (kills.get(killer) ?? 0) + 1)
  }

  // EVERY ASSIGNED MAN GETS A LINE, including the ones nothing happened to.
  // A report that only listed the men who were touched would leave a quiet
  // mission promoting nobody.
  // Through a `Set` because two entities could in principle carry the same
  // recruit id, and a man listed twice would be counted twice by the fold in
  // `applyMissionReport` that exists to stop exactly that.
  const entries = [...new Set(assignment.values())].map((id) => ({
    recruitId: id,
    survived: !dead.has(id),
    kills: kills.get(id) ?? 0,
  }))

  return { levelId, outcome, entries }
}
