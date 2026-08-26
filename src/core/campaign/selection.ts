/**
 * Who goes on the mission (ticket 021).
 *
 * THE CAP IS THE LEVEL'S OWN AVATAR SLOTS AND NOTHING ELSE. Declaring a second
 * maximum — a field on the level, a constant here — would let the two disagree,
 * and the loser is either an authored spawn point standing empty or a soldier
 * with nowhere to stand. `maxSquadFor` is therefore a one-line read of the level
 * document rather than a number anybody maintains.
 *
 * VALIDATED HERE, IN `core`, for the same reason ticket 020's screen models are:
 * `src/ui` has no tests and cannot have any, so a rule that lives inside a click
 * handler is a rule nothing checks. The Recruitment screen's whole job is to
 * draw `recruitmentModel` and hand the ids back.
 *
 * REFUSALS CARRY A REASON, exactly as `advance` does. The failure mode being
 * avoided is a Deploy button that silently does nothing; an exception would be
 * worse still, because the caller is a DOM event handler and a throw there takes
 * the frame with it.
 */

import { recruit, recruitsAvailable } from './roster'
import type { LevelData } from '../level/types'
import type { CampaignState } from './types'

/**
 * A man as the session receives him — id, name and rank, nothing else.
 *
 * The SAME three fields `core/flow`'s `FlowSoldier` carries, because the
 * Briefing screen draws the squad this function returns. It is not that type
 * imported: `core/flow` imports `core/campaign`, and importing back would make
 * the two mutually dependent for the sake of three strings.
 *
 * NO RECORD IN IT. `missionsSurvived` and `kills` change while the mission runs
 * and this value does not, so carrying them would be carrying a copy that goes
 * stale the moment the first round lands. The roster is where a record is read.
 */
export interface SquadMember {
  readonly id: string
  readonly name: string
  readonly rank: string
}

/** A refusal, or the squad plus the campaign that issued any new men. */
export type SquadSelection =
  | {
      readonly ok: true
      /** In the order chosen; the nth man stands on the nth avatar spawn. */
      readonly squad: readonly SquadMember[]
      /**
       * The campaign AFTER any auto-fill recruiting. Identical to the input when
       * nobody had to be issued — but it must be kept either way, because
       * ticket 019's name-uniqueness guarantee runs entirely through
       * `recruitsIssued`, and dropping this state reissues the same names next
       * mission. Two gravestones on Boot Hill would read the same thing.
       */
      readonly state: CampaignState
    }
  | { readonly ok: false; readonly reason: string }

/** One man as the Recruitment screen lists him: who he is and what he has done. */
export interface RecruitmentEntry {
  readonly id: string
  readonly name: string
  readonly rank: string
  readonly missionsSurvived: number
  readonly kills: number
}

/** Everything the Recruitment screen renders. JSON, like every other model. */
export interface RecruitmentModel {
  readonly maxSquad: number
  /** The living only, in roster order. Never the dead. */
  readonly available: readonly RecruitmentEntry[]
}

/**
 * How many men this level takes: however many avatar spawns it declares.
 *
 * A level with none takes nobody rather than crashing. Level documents are
 * hand-authored (and `tools/mapgen` emits them), so an empty `avatars` list is a
 * real mistake somebody can make, and answering 0 lets `selectSquad` refuse a
 * squad for it in the ordinary way instead of throwing out of a click handler.
 */
export function maxSquadFor(level: LevelData): number {
  return level.spawns.avatars.length
}

/**
 * Validate a selection, filling it out if the roster leaves no choice to make.
 *
 * EXACTLY THE LEVEL'S COUNT, NOT AT MOST. Over-selection puts a man nowhere and
 * under-selection leaves an authored spawn point empty — a hole in the level the
 * designer did not put there — so both are refused.
 *
 * WITH ONE EXCEPTION, AND IT IS THE ONE THAT KEEPS THE GAME PLAYABLE: when the
 * living roster is no larger than the squad the level wants, there is no choice
 * left to make — every living man is going — so a short selection is COMPLETED
 * rather than refused, recruiting whatever the roster still cannot supply. A
 * campaign whose squad was wiped has one man and a level wanting four; refusing
 * it would leave the player at a Recruitment screen with no button that works
 * and no way to get more men. When the roster is BIGGER than the squad the
 * player is genuinely choosing, and a short list is a half-made choice that must
 * be refused rather than finished on his behalf — auto-fill tops up, it never
 * overrules.
 *
 * A REFUSAL CHANGES NOTHING. Every check runs before a single man is recruited,
 * so a rejected selection cannot leave names issued against a campaign that
 * never deployed.
 */
export function selectSquad(
  state: CampaignState,
  level: LevelData,
  chosenIds: readonly string[],
): SquadSelection {
  const wanted = maxSquadFor(level)
  const living = recruitsAvailable(state)
  const byId = new Map(living.map((man) => [man.id, man]))

  if (chosenIds.length > wanted) {
    return {
      ok: false,
      reason: `This level has ${wanted} landing positions; ${chosenIds.length} men were selected.`,
    }
  }

  const chosen: SquadMember[] = []
  const seen = new Set<string>()
  for (const id of chosenIds) {
    if (seen.has(id)) {
      // A click-to-toggle roster produces this the first time anybody
      // double-clicks. Left alone it would put one soldier on two spawn points
      // and leave a third empty, which reads as the game losing a man.
      return { ok: false, reason: `The same soldier was selected twice (${id}).` }
    }
    seen.add(id)
    const man = byId.get(id)
    if (man === undefined) {
      // The dead are named separately, because "he is not on the roster" and
      // "he was buried last mission" are different things to tell a player, and
      // only one of them means the screen is showing him something stale.
      const buried = state.dead.find((fallen) => fallen.id === id)
      if (buried !== undefined) {
        return { ok: false, reason: `${buried.name} was killed in action and cannot deploy.` }
      }
      return { ok: false, reason: `No soldier on the roster has the id ${id}.` }
    }
    chosen.push({ id: man.id, name: man.name, rank: man.rank })
  }

  if (chosen.length === wanted) return { ok: true, squad: chosen, state }

  // Short, and the roster still holds men he did not pick: that is a half-made
  // choice, not an impossible one. See the exception above.
  if (living.length > wanted) {
    return {
      ok: false,
      reason: `This level needs ${wanted} men; only ${chosen.length} were selected.`,
    }
  }

  return autoFill(state, chosen, seen, wanted)
}

/**
 * Complete a short squad: the unchosen living first, then newly recruited men.
 *
 * THE PLAYER'S OWN PICKS COME FIRST AND IN HIS ORDER. Order decides who stands
 * on which spawn point, so a squad that appended his veteran behind two
 * strangers would silently move him off the flank he was placed on.
 *
 * The dead cannot be reached from here at all: `recruitsAvailable` is the living
 * roster, and there is no path from `state.dead` into it.
 */
function autoFill(
  state: CampaignState,
  chosen: readonly SquadMember[],
  taken: ReadonlySet<string>,
  wanted: number,
): SquadSelection {
  const squad: SquadMember[] = [...chosen]
  for (const man of recruitsAvailable(state)) {
    if (squad.length >= wanted) break
    if (taken.has(man.id)) continue
    squad.push({ id: man.id, name: man.name, rank: man.rank })
  }
  if (squad.length === wanted) return { ok: true, squad, state }

  // Still short, so the shortfall has to be enlisted. `recruit` tops the roster
  // up TO a count rather than adding to it, hence the addition here: the men
  // already on it are keeping their places.
  const shortfall = wanted - squad.length
  const topped = recruit(state, state.recruits.length + shortfall)
  for (const man of recruitsAvailable(topped)) {
    if (squad.length >= wanted) break
    if (taken.has(man.id)) continue
    if (squad.some((member) => member.id === man.id)) continue
    squad.push({ id: man.id, name: man.name, rank: man.rank })
  }

  if (squad.length !== wanted) {
    // Reachable only at `MAX_ROSTER`, which `recruit` clamps to: a campaign
    // holding 64 men cannot enlist a 65th. Refused with a reason rather than
    // deploying a short squad, because a level with an empty spawn point is the
    // failure this whole function exists to prevent.
    return {
      ok: false,
      reason: `The roster is full and cannot field the ${wanted} men this level needs.`,
    }
  }
  return { ok: true, squad, state: topped }
}

/**
 * What the Recruitment screen draws.
 *
 * A COPY, NOT A WINDOW. It crosses into `src/ui`, and a screen holding a view
 * onto live campaign state would watch it change underneath it — the same rule
 * every model in `core/flow` is built on.
 *
 * The dead never appear, which `recruitsAvailable` already guarantees by reading
 * the living list; the screen a player picks a squad on is the last place a man
 * he buried last mission should be offered to him.
 */
export function recruitmentModel(state: CampaignState, level: LevelData): RecruitmentModel {
  return {
    maxSquad: maxSquadFor(level),
    available: recruitsAvailable(state).map((man) => ({
      id: man.id,
      name: man.name,
      rank: man.rank,
      missionsSurvived: man.missionsSurvived,
      kills: man.kills,
    })),
  }
}
