/**
 * The campaign's data contract (ticket 019).
 *
 * THIS IS THE ONLY STATE IN THE GAME THAT OUTLIVES A MISSION. Everything else
 * is rebuilt from `level.json` on the next load; a dead soldier is gone because
 * this state says so and for no other reason. Two consequences run through
 * every shape below and are contracts rather than preferences:
 *
 *   - EVERY FIELD IS JSON. No `Map`, no `Set`, no function, no cycle. A port
 *     backed by a browser store can only hold a string, and a field that does
 *     not survive `JSON.parse(JSON.stringify(x))` surfaces not as an error but
 *     as a campaign that quietly lost a man.
 *   - RANK IS NEVER STORED AS AN INDEPENDENTLY MUTABLE FIELD. It is computed
 *     from `missionsSurvived` on read (`rankFor`), so the two cannot disagree.
 *     Stored separately, a retune of the ladder leaves every existing save
 *     carrying ranks that no longer match the record they were earned by — and
 *     nothing would report it.
 */

/**
 * Which list a man is on, spelled out for the presentation layers that render
 * him. It is DERIVED from list membership (`recruits` vs `dead`) and never the
 * other way round: a status field that decided membership would make
 * resurrection one careless assignment away, and permadeath here is structural
 * rather than a rule somebody remembers.
 */
export type RecruitStatus = 'active' | 'dead'

/** One soldier, as the rest of the game reads him. `rank` is computed on read. */
export interface Recruit {
  /** Unique for the life of the campaign and NEVER reused, so a dead man can
   * still be named by a report that credits him a kill he did not live to see. */
  readonly id: string
  /** Distinct within the campaign, dead men included. See `names.ts`. */
  readonly name: string
  /** Derived from `missionsSurvived`. Never assign to it. */
  readonly rank: string
  readonly missionsSurvived: number
  readonly kills: number
  readonly status: RecruitStatus
}

/**
 * A gravestone. Boot Hill is a list of these, which is why `diedOnLevel`,
 * `rank` and `rankAtDeath` are RECORDED here and read back exactly as written,
 * never recomputed: the ladder is a tuning surface, and a stone that changed
 * its inscription when a designer edited a table would be worse than no stone
 * at all.
 *
 * THE DIVIDING LINE, stated once so nothing has to guess it: a LIVING man's
 * rank is DERIVED (`recruitsAvailable` computes it) because his record is still
 * changing and the two must never drift apart. A DEAD man's is RECORDED,
 * because his record never changes again — there is nothing left for it to
 * drift from, and the only thing recomputation can do is overwrite a fact with
 * a guess made under a newer table.
 */
export interface DeadRecruit extends Recruit {
  readonly status: 'dead'
  /** The level he fell on. Without it every stone on Boot Hill reads the same. */
  readonly diedOnLevel: number
  /** The rank he held when he fell, never one he never reached. */
  readonly rankAtDeath: string
}

/**
 * What the campaign actually stores for a living man.
 *
 * DELIBERATELY NARROWER THAN `Recruit`: no `rank`, no `status`. Those are the
 * two fields that could contradict the record, so they are not in the record —
 * `recruitsAvailable` computes them. This is the mechanism behind the promise
 * above, not a space optimisation.
 */
export interface RecruitRecord {
  readonly id: string
  readonly name: string
  readonly missionsSurvived: number
  readonly kills: number
}

/**
 * The whole campaign, and the whole save file.
 *
 * `seed` rides along because a returning player must get HIS squad back:
 * recruitment draws names from a seeded stream, and a campaign that reloaded
 * without its seed would hand him a set of strangers wearing his save file.
 *
 * `recruitsIssued` is how many men have EVER been recruited, dead ones
 * included. It only ever rises, which is what makes "a name is never reissued"
 * true after the pool is exhausted as well as before.
 */
export interface CampaignState {
  readonly seed: number
  readonly recruits: readonly RecruitRecord[]
  readonly dead: readonly DeadRecruit[]
  /** Highest level the player may start. A fresh campaign has exactly one. */
  readonly unlockedLevels: number
  readonly recruitsIssued: number
}

/** Won or lost. An unfinished mission is reported as `failed`, never as a win. */
export type MissionOutcome = 'complete' | 'failed'

/** What one assigned man did in one mission. */
export interface MissionEntry {
  readonly recruitId: string
  readonly survived: boolean
  readonly kills: number
}

/**
 * A mission, read off the event stream and not yet recorded against anybody.
 *
 * The split between producing this (`missionReport`) and applying it
 * (`applyMissionReport`) is the point of the pair: the promotion ladder can be
 * tested without an event stream, and kill attribution can be tested without a
 * roster. Fused, every test of either needs both.
 */
export interface MissionReport {
  readonly levelId: number
  readonly outcome: MissionOutcome
  readonly entries: readonly MissionEntry[]
}

/**
 * The seam between the campaign and whatever remembers it.
 *
 * `unknown` IN BOTH DIRECTIONS, ON PURPOSE. What comes back off a disk is not a
 * `CampaignState` until it has been checked, and typing it as one is how
 * corrupt data becomes a crash three frames later somewhere else. Both methods
 * may throw — a browser store throws on the ACCESS itself in private browsing,
 * and on a full quota when writing — and `loadCampaign`/`saveCampaign` survive
 * that, so an implementation is not required to be defensive on their behalf.
 */
export interface PersistencePort {
  load(): unknown
  save(state: unknown): void
}

/**
 * The result of a save.
 *
 * A FAILED WRITE IS THE ONE LOSS PATH THIS MODULE EXISTS TO PREVENT, so it is
 * reported rather than merely swallowed. A store that refuses writes (private
 * browsing, a full quota) otherwise drops every save in silence while the
 * player is told on each launch that their campaign was damaged — the same
 * "they will not find out until they go looking for men who no longer exist"
 * failure the loader guards against, arriving through the write door.
 *
 * Reporting is NOT throwing. Losing the save is bad; losing the session the
 * player just spent ten minutes on is worse, so the caller is handed a notice
 * and decides what to show.
 */
export interface SaveResult {
  readonly saved: boolean
  /** `null` on success; otherwise a line a human can read. */
  readonly notice: string | null
}

/**
 * The result of a load. `notice` is `null` on a clean load AND on a first run,
 * and otherwise a short line a human can read.
 *
 * A DISCARDED SAVE MUST BE VISIBLE. Silently starting a fresh campaign over
 * somebody's twelve dead soldiers is the worst outcome available here — worse
 * than refusing to start, because they will not find out until they go looking
 * for men who no longer exist.
 */
export interface LoadedCampaign {
  readonly state: CampaignState
  readonly notice: string | null
}
