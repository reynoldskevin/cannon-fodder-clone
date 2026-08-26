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
  /** Where he fell. Without it every stone on the hill reads the same. */
  readonly diedOnLevel: number
  /** How many he took with him — the difference between a casualty and a man. */
  readonly kills: number
}

/** Everything the Boot Hill screen renders. JSON, like every other model. */
export interface BootHillModel {
  /** Every man who ever died, OLDEST FIRST. The hill grows; it never resets. */
  readonly graves: readonly Grave[]
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
  const graves: Grave[] = state.dead.map((fallen) => ({
    name: fallen.name,
    rankAtDeath: fallen.rankAtDeath,
    diedOnLevel: fallen.diedOnLevel,
    kills: fallen.kills,
  }))

  return { graves, promotions: [...promotions], fallenThisMission: fallenSince(graves, previous) }
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
