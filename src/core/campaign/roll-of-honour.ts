/**
 * THE MEMORIAL'S FOLD (ticket 073): the campaign's dead, grouped by the mission
 * that took them, newest mission first.
 *
 * IT IS HERE AND NOT IN `menu.ts` BECAUSE `menu.ts` CANNOT BE TESTED. Vitest
 * runs `environment: 'node'`, every file in `src/ui` calls `document` on its
 * first line, and a grouping rule written inside the renderer would be verified
 * by looking at the screen and in no other way. `bootHillModel` next door made
 * the same trade for the same reason.
 *
 * A SELECTOR OVER `CampaignSummary.fallen`, NOT A SECOND READ OF THE STATE.
 * `campaignSummary` already folds the roster and the dead into one shape, and
 * the Menu prints its totals two lines above this list; a grouping that went
 * back to `CampaignState` could disagree with the numbers directly over it about
 * the very same men. Taking the summary's own array is what makes that
 * impossible rather than merely unlikely.
 */

import type { Grave } from './boothill'

/**
 * One man on the roll.
 *
 * A NARROWER ROW THAN `Grave`, deliberately. `fresh` and `plot` are Boot Hill's
 * — which stone to animate and where to plant it — and mean nothing on a screen
 * that shows a whole campaign at once. Handing the `Grave` straight through
 * would leak both into `src/ui` and make every field Boot Hill adds next a field
 * the memorial silently depends on.
 */
export interface FallenMan {
  readonly name: string
  /** The rank on the stone, not the rank he would have reached. */
  readonly rankAtDeath: string
  /**
   * Which badge to draw, or `null` for a stone carved under an older ladder.
   *
   * CARRIED THROUGH RATHER THAN RECOMPUTED. `insigniaIndexOf` already answered
   * this when the grave was read; asking again here would be a second place the
   * rank ladder is consulted, and the two would part on the day it changes.
   */
  readonly rankIndex: number | null
  readonly kills: number
}

/** Every man one mission cost. */
export interface MissionRoll {
  /** The level number, as the player counts them. */
  readonly level: number
  /**
   * The men who fell on it, in the order the campaign recorded them.
   *
   * NOT REVERSED. See `rollOfHonour` — the inversion is between missions and
   * stops at the mission boundary.
   */
  readonly dead: readonly FallenMan[]
}

/**
 * Group the fallen by mission, newest mission first.
 *
 * THE INVERSION IS THE POINT. `state.dead` is append-only, so the flat list runs
 * oldest first and the men the player has just lost were at the BOTTOM of the
 * old end screen, behind every mission he had already grieved over. The last
 * mission is the one he remembers, so it opens the roll.
 *
 * IT STOPS AT THE MISSION BOUNDARY. Within one level, `state.dead`'s order is
 * the order the deaths were REPORTED, and men who fell in the same firefight
 * fell at the same time — reversing that too would be reversing an arbitrary
 * order and presenting the result as recency.
 *
 * A LEVEL IS ONE GROUP EVEN IF IT WAS PLAYED TWICE, which is why this is a map
 * keyed on the level rather than a single pass that starts a new group whenever
 * `diedOnLevel` changes. Replaying an earlier level appends to the same array,
 * so the flat list interleaves — 2, 1, 2 — and the one-pass fold would print
 * Mission 2 twice with Mission 1 wedged between them.
 *
 * SORTED BY LEVEL, NOT BY WHERE THE LEVEL LAST APPEARS. Those agree on a
 * campaign played straight through and part company the moment one is replayed,
 * and "the mission with the highest number" is the one a player reading a
 * memorial means by "the latest".
 */
export function rollOfHonour(fallen: readonly Grave[]): readonly MissionRoll[] {
  // Insertion-ordered, so the men inside each group keep the order they arrived
  // in without a second sort that would have to be stable to be correct.
  const byLevel = new Map<number, FallenMan[]>()

  for (const grave of fallen) {
    const men = byLevel.get(grave.diedOnLevel)
    // A FRESH ROW, never the `Grave` itself: a screen that mutated one would be
    // writing into the campaign's own record of who died.
    const man: FallenMan = {
      name: grave.name,
      rankAtDeath: grave.rankAtDeath,
      rankIndex: grave.rankIndex,
      kills: grave.kills,
    }
    if (men === undefined) byLevel.set(grave.diedOnLevel, [man])
    else men.push(man)
  }

  // A level with no casualties never became a key, so it is absent rather than
  // present and empty — the roll is a list of losses, not a list of levels.
  return [...byLevel.entries()]
    .sort(([a], [b]) => b - a)
    .map(([level, dead]) => ({ level, dead }))
}
