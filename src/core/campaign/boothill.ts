/**
 * BOOT HILL, AS A VALUE (ticket 022).
 *
 * The only screen in the game that is about memory rather than about a choice.
 * Everything else shows the player something he can act on; this one shows him
 * a list of names he cannot do anything about, and that is why the campaign has
 * weight at all.
 *
 * IT ADDS NO CAMPAIGN STATE, and that is the test of the three tickets before
 * it. Ticket 019 already carved the stones — `DeadRecruit` carries `name`,
 * `rankAtDeath` and `diedOnLevel`, and a dead man's rank is RECORDED rather
 * than derived precisely so this screen can show what he was when he fell. If
 * anything here needed a new field, something upstream was wrong.
 *
 * BOTH EXPORTS ARE PURE SELECTORS RETURNING JSON. They cross into `src/ui`, so
 * they must be values rather than views onto live campaign state — the same
 * rule every model in `core/flow` is built on, and the reason `graves` is a
 * fresh array of fresh rows instead of `state.dead` handed out directly.
 */

import { recruitsAvailable } from './roster'
import { insigniaIndexOf, rankIndexFor } from './ranks'
import type { CampaignState } from './types'

/**
 * One promotion, as the screen announces it.
 *
 * BOTH RANKS, never just the new one. "Corporal Hayes" is a fact about the
 * roster; "Hayes: Private → Corporal" is the thing that happened this mission,
 * and the screen exists to report the second.
 *
 * NO ID. A promotion is a line of prose, not a handle — nothing on this screen
 * is clickable, and carrying an id would invite a later screen to treat the
 * announcement as a selectable roster entry.
 */
export interface Promotion {
  readonly name: string
  readonly from: string
  readonly to: string
}

/** One gravestone, as the hill inscribes it. */
export interface Grave {
  readonly name: string
  /** What he was WHEN HE FELL. Read back as written, never recomputed. */
  readonly rankAtDeath: string
  /**
   * Which badge to draw, or `null` for a rank this ladder no longer has.
   *
   * FOUND FROM `rankAtDeath`, NOT FROM HIS RECORD (ticket 062). The rest of this
   * interface's contract is that a stone is read back as carved; a badge
   * recomputed from `missionsSurvived` would be the one part of the inscription
   * that changed when a designer edited the table.
   *
   * `null` IS A REAL ANSWER AND THE SCREEN MUST DRAW NOTHING FOR IT. A save
   * written under the six-rung ladder can name a rank that no longer exists, and
   * a confident wrong badge on a memorial is worse than no badge at all.
   */
  readonly rankIndex: number | null
  /** Where he fell. Without it every stone on the hill reads the same. */
  readonly diedOnLevel: number
  /** How many he took with him — the difference between a casualty and a man. */
  readonly kills: number
}

/**
 * A living man, as the hill's side panel lists him (ticket 054).
 *
 * NAME, RANK AND HIS RECORD — the three things the original's SQUAD column
 * shows. It is not `SquadMember` from `selection.ts`, which carries no kills,
 * and not `Recruit`, which carries an id and a status the screen has no use for:
 * this is a row of a list, and handing a screen an id invites a later ticket to
 * make the row selectable and put a decision in a `div`.
 */
export interface Trooper {
  readonly name: string
  readonly rank: string
  /**
   * Which badge to draw (ticket 062).
   *
   * DERIVED, LIKE HIS RANK, AND FROM THE SAME CALL. A living man's record is
   * still changing, so both come off `missionsSurvived` — and they come off it
   * through one function rather than two, so the stripes and the title cannot
   * disagree. Never `null`: `rankIndexFor` always lands on a real rung.
   */
  readonly rankIndex: number
  readonly kills: number
}

/** Everything the Boot Hill screen renders. JSON, like every other model. */
export interface BootHillModel {
  /** Every man who ever died, OLDEST FIRST. The hill grows; it never resets. */
  readonly graves: readonly Grave[]
  /**
   * The men available for the NEXT mission — the original's SQUAD column.
   *
   * THE LIVING ROSTER, NOT THE SURVIVORS OF THE LAST MISSION (ticket 056). It
   * was the survivors, and the bug that exposes is the ordinary case rather than
   * an edge one: level 1 sends two men, both die, and a player who still had six
   * recruits waiting was shown an empty column reading "Nobody came back". The
   * column answers "who have I got", and a man in reserve counts.
   *
   * NOBODY ON THE HILL IS EVER IN IT, and that falls out of the shape rather
   * than out of a check: it is `recruitsAvailable`, which reads the LIVING
   * roster, so a man who fell is a cross and a HEROES row and cannot be in both
   * columns.
   *
   * THE NEXT SQUAD IS NOT ASSIGNED YET AND THIS IS NOT A PREDICTION OF IT.
   * Assignment happens on the way out of this screen (`advanceFromBootHill` ->
   * `selectSquad`), and it takes `maxSquadFor(level)` men off the front of this
   * very list. Listing the first N here as though they were chosen would be a
   * second copy of that rule, in a screen that cannot be tested, disagreeing
   * with the real one the day a level changes its avatar count.
   */
  readonly squad: readonly Trooper[]
  /**
   * The scoreboard: enemy killed by this campaign, and men lost to it — the
   * original's HOME and AWAY, in its own arithmetic.
   *
   * TAKEN FROM `campaignSummary` AND NOT RECOMPUTED HERE. The Menu prints these
   * same two numbers when a campaign ends, and two spellings of "how many did we
   * kill" is how a memorial and a summary come to disagree about one campaign on
   * two screens the player sees a minute apart. The sum is not obvious either: a
   * dead man's kills count, and he is not on the roster to be counted.
   */
  readonly enemyKilled: number
  readonly casualties: number
  /** Earned by THIS mission only. Handed in — see `bootHillModel`. */
  readonly promotions: readonly Promotion[]
  /**
   * The tail of `graves` added by this mission, so the new stones stand out.
   * Empty when the model was built without a before-state — see `fallenSince`.
   */
  readonly fallenThisMission: readonly Grave[]
}

/**
 * The men whose rank rose across one mission.
 *
 * DERIVED BY COMPARING TWO STATES, NEVER RECORDED. Storing a "promoted this
 * mission" flag would be a second source of truth about a rank ticket 019
 * already derives from `missionsSurvived`, and the two would disagree the first
 * time somebody retuned `RANKS` — the flag would still be claiming a promotion
 * the ladder no longer grants. Comparing is exact and needs no new state.
 *
 * A DEAD MAN IS NEVER IN THE LIST, and it falls out of the shape rather than
 * out of a check: `recruitsAvailable` reads the LIVING roster, so a man who
 * fell this mission is simply absent from `after` and cannot be matched. That
 * matters because a posthumous promotion printed beside his own gravestone, on
 * the same screen, would read as a bug in the most conspicuous place the game
 * has — and `applyMissionReport` credits him no mission anyway.
 *
 * A MAN IN `after` WHO WAS NOT IN `before` IS NOT A PROMOTION. Auto-fill issues
 * men between missions (`selectSquad`), so the roster grows on its own; a naive
 * diff would announce every new recruit as having been promoted to Private.
 *
 * The comparison is by ID, not by name. Names are unique today, but ids are
 * unique BY CONSTRUCTION and never reused, which is the property this needs.
 */
export function promotionsBetween(
  before: CampaignState,
  after: CampaignState,
): readonly Promotion[] {
  const was = new Map(recruitsAvailable(before).map((man) => [man.id, man.rank]))
  const promotions: Promotion[] = []
  for (const man of recruitsAvailable(after)) {
    const from = was.get(man.id)
    // Absent from `before`: a new recruit, not a promotion. See above.
    if (from === undefined || from === man.rank) continue
    // Any difference is a rise: `missionsSurvived` only ever increases and
    // `rankFor` is monotonic in it, so there is no demotion to filter out. If
    // that ever stops being true, this is the line that has to say so.
    promotions.push({ name: man.name, from, to: man.rank })
  }
  return promotions
}

/**
 * What the Boot Hill screen draws.
 *
 * `promotions` IS PASSED IN RATHER THAN COMPUTED, and `previous` IS OPTIONAL.
 * Both are the same admission: what happened THIS MISSION is a difference
 * between two campaign states, and one state cannot answer it. Taking them as
 * arguments keeps the model memoryless — nothing stashed here to go stale — and
 * the caller that already holds the before-state (it is the same one that
 * called `applyMissionReport`) is the only one that needs to remember it. A
 * caller with no before-state, which is what a reload is, gets the answer that
 * case deserves: no promotions announced and no stone marked new.
 *
 * A COPY, NOT A WINDOW. `graves` is a fresh array of fresh rows carrying only
 * the four fields the screen was promised; handing back `state.dead` would let
 * a screen reach into the campaign through the memorial, and would leak
 * whatever the roster happens to store today into a `ui` module forever.
 */
export function bootHillModel(
  state: CampaignState,
  promotions: readonly Promotion[],
  previous?: CampaignState,
): BootHillModel {
  // Oldest first, which is `state.dead`'s own order: ticket 019's dead list is
  // append-only and never re-sorted, so insertion order IS chronological order.
  // Sorting by `diedOnLevel` instead would look equivalent and would reorder
  // the two men who fell on the same level, and shuffle a hill the moment a
  // player replays an earlier level.
  const graves = gravesOf(state)

  const totals = campaignSummary(state)

  return {
    graves,
    /**
     * READ OFF THE STATE, NOT PASSED IN (ticket 056). It was an argument while
     * it meant "the men who went on the last mission", which is knowledge only
     * the runner has. The living roster is not: it is `recruitsAvailable(state)`
     * and nothing else, so taking it as a parameter could only ever let a caller
     * hand over a different answer — which is exactly what happened, and how a
     * player with six men in reserve was told nobody came back.
     *
     * A FRESH ROW PER MAN, carrying only what the column prints. Handing back
     * the roster records would leak `id`, `status` and whatever ticket 019 adds
     * next into a screen that has no business with any of it.
     */
    squad: recruitsAvailable(state).map((man) => ({
      name: man.name,
      rank: man.rank,
      // OFF THE RECORD, like the rank beside it — see `Trooper.rankIndex`.
      rankIndex: rankIndexFor(man.missionsSurvived),
      kills: man.kills,
    })),
    enemyKilled: totals.kills,
    casualties: totals.casualties,
    promotions: [...promotions],
    fallenThisMission: fallenSince(graves, previous),
  }
}

/**
 * The hill's stones, oldest first — `state.dead`'s own order.
 *
 * ONE COPY OF THE MAPPING, shared by `bootHillModel` and `campaignSummary`. Two
 * spellings of "a `DeadRecruit` read as a `Grave`" would let the memorial and
 * the campaign summary disagree about the same man, on two screens the player
 * sees minutes apart.
 *
 * A FRESH ARRAY OF FRESH ROWS, never `state.dead` handed out: a model a screen
 * could mutate reaches into the campaign through the memorial, and would leak
 * whatever the roster happens to store today into `src/ui` forever.
 *
 * NOT SORTED. `state.dead` is append-only and never re-sorted, so insertion
 * order IS chronological order; sorting by `diedOnLevel` would look equivalent
 * and would reorder the two men who fell on the same level, and shuffle the hill
 * the moment a player replays an earlier one.
 */
function gravesOf(state: CampaignState): Grave[] {
  return state.dead.map((fallen) => ({
    name: fallen.name,
    rankAtDeath: fallen.rankAtDeath,
    // FROM THE INSCRIPTION, NOT FROM THE RECORD. See `Grave.rankIndex`.
    rankIndex: insigniaIndexOf(fallen.rankAtDeath),
    diedOnLevel: fallen.diedOnLevel,
    kills: fallen.kills,
  }))
}

/**
 * What the campaign added up to, for the Menu to show when it is over
 * (ticket 024).
 *
 * A PURE SELECTOR AND NO NEW STATE, for the same reason `bootHillModel` is one:
 * the screen is a `div` with no tests, so a rule inside it is a rule nothing
 * checks. Everything here is already in `CampaignState`; nothing is recorded.
 */
export interface CampaignSummary {
  /**
   * How many levels have been BEATEN — one less than `unlockedLevels`.
   *
   * NOT `unlockedLevels`, which is a count that starts at ONE: a fresh campaign
   * has one level open and none beaten. Reporting it raw would tell a player who
   * has finished nothing that he has finished one.
   */
  readonly levelsCompleted: number
  readonly casualties: number
  /** Every kill the campaign ever scored — the living AND the dead. */
  readonly kills: number
  /** Everyone who fell, oldest first — the same order Boot Hill uses. */
  readonly fallen: readonly Grave[]
}

export function campaignSummary(state: CampaignState): CampaignSummary {
  /**
   * THE LIVING AND THE DEAD, ADDED TOGETHER. The obvious implementation sums
   * over the roster, and a dead man is not on it — he killed three and then
   * fell, and a total that forgot him would tell the player he did less than he
   * did while Boot Hill carries the number on his stone.
   */
  const kills =
    state.recruits.reduce((total, man) => total + man.kills, 0) +
    state.dead.reduce((total, man) => total + man.kills, 0)

  return {
    // FLOORED AND FLOORED AT ZERO, because `parseState` checks `unlockedLevels`
    // for a lower bound only: `{"unlockedLevels": 1.5}` loads clean with no
    // notice, and "0.5 levels completed" is a sentence no screen should print.
    levelsCompleted: Math.max(0, Math.floor(state.unlockedLevels) - 1),
    casualties: state.dead.length,
    kills,
    fallen: gravesOf(state),
  }
}

/**
 * The stones cut by this mission: the graves added since `previous`.
 *
 * EXACT, BY COUNTING. `state.dead` is append-only and never re-sorted, so the
 * men who fell since `previous` are precisely the entries past its length.
 * There is no heuristic left in it and still no new campaign state — the
 * before-state is a value the caller already holds, because it is the same one
 * it handed to `applyMissionReport`.
 *
 * THIS REPLACED AN INFERENCE, and the reason is worth keeping. The first
 * version read the trailing run of graves sharing the last one's
 * `diedOnLevel` — one mission's fallen are appended as a block and all carry the
 * same level. A REPLAYED LEVEL DEFEATS IT: lose a man on level 3, retry level 3,
 * lose another, and the two blocks merge into one run, so the previous
 * attempt's dead are marked freshly fallen again. That is not an exotic case,
 * it is what retrying a mission you lost men on looks like, and it is wrong on
 * the one screen whose entire job is remembering who died when. Measured, then
 * replaced.
 *
 * NO `previous` MEANS NOBODY IS MARKED, and that is the correct answer rather
 * than a degraded fallback: the case it models is a RELOAD, where the campaign
 * comes back off disk and nothing fell this session, so no stone is new.
 * Marking the last mission's dead as fresh every time the player reopened the
 * tab would be the same lie in the other direction.
 */
function fallenSince(graves: readonly Grave[], previous?: CampaignState): readonly Grave[] {
  if (previous === undefined) return []
  // `slice` past the end is `[]`, so a caller who hands over a LATER state by
  // mistake marks nobody rather than throwing or producing a negative window.
  return graves.slice(previous.dead.length)
}
