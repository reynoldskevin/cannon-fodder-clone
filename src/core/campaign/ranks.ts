/**
 * THE PROMOTION TUNING SURFACE (ticket 019).
 *
 * The whole ladder is this file, as plain data, under the same two rules
 * `combat/weapons.ts` and `ordnance/table.ts` state for their tables:
 *
 *   - ROWS ARE DATA, NOT BEHAVIOUR. No functions, no derived fields. A row must
 *     survive a JSON round-trip unchanged, which is what lets a later ticket
 *     author the ladder in a campaign document instead of in code.
 *   - THE LADDER IS ORDERED AND STRICTLY RISING. `rankFor` walks it and takes
 *     the last row reached; two rows sharing a threshold would make one of them
 *     unreachable, and a row out of order would make every threshold below it a
 *     lie.
 *
 * PROMOTION IS BY SURVIVED VICTORIES ONLY — see `roster.ts`. Surviving a rout
 * is not a distinction, and a ladder that counted it would promote a squad for
 * losing repeatedly.
 *
 * RETUNING IS SAFE ACROSS SAVES precisely because rank is derived rather than
 * stored: lower a threshold here and every existing campaign's ranks move with
 * it, because the only thing on disk is the mission count they were earned by.
 */

/** One rung. `missionsRequired` is the count at which it is REACHED, inclusive. */
export interface Rank {
  readonly name: string
  /** Survived victories needed. The first row must be 0 — see below. */
  readonly missionsRequired: number
}

/**
 * The ladder, bottom first.
 *
 * The first row's threshold is 0 because a fresh recruit has to hold SOME rank:
 * a ladder that started at 1 would leave every new man rankless on the
 * recruitment screen, which is a blank where a name badge should be rather than
 * a design decision.
 *
 * The gaps widen deliberately. Early promotions land inside the first two or
 * three missions so the mechanic is legible before the player has lost anybody;
 * later ones are far enough apart that a Captain is a man who survived a
 * campaign, and seeing him die means something.
 */
const LADDER = [
  { name: 'Private', missionsRequired: 0 },
  { name: 'Corporal', missionsRequired: 2 },
  { name: 'Sergeant', missionsRequired: 5 },
  { name: 'Lieutenant', missionsRequired: 9 },
  { name: 'Captain', missionsRequired: 14 },
  { name: 'Major', missionsRequired: 20 },
] as const

/** The ladder as read-only data. Ordered, strictly rising, JSON-round-trippable. */
export const RANKS: readonly Rank[] = LADDER

/**
 * The rank a record of `missionsSurvived` earns.
 *
 * THE ONLY WAY A RANK IS EVER PRODUCED. Nothing stores one for a living man, so
 * a rank and the record behind it cannot drift apart.
 *
 * Tops out at the last rung rather than running off the end: a player who
 * outlasts the table gets the highest rank in it, not `undefined` rendered into
 * the HUD as "undefined".
 */
export function rankFor(missionsSurvived: number): string {
  // Typed `string` rather than inferred: `LADDER[0].name` is the literal
  // 'Private' under `as const`, and an inferred binding could then never be
  // reassigned to a higher rung.
  let earned: string = LADDER[0].name
  for (const rank of LADDER) {
    if (missionsSurvived >= rank.missionsRequired) earned = rank.name
  }
  return earned
}
