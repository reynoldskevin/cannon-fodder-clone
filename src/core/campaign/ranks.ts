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
 * The ladder, bottom first: SIXTEEN RUNGS, ONE MISSION APART (ticket 062).
 *
 * The first row's threshold is 0 because a fresh recruit has to hold SOME rank:
 * a ladder that started at 1 would leave every new man rankless on the
 * recruitment screen, which is a blank where a name badge should be rather than
 * a design decision.
 *
 * THE GAPS USED TO WIDEN AND NO LONGER DO. Six rungs at 0/2/5/9/14/20 made a
 * promotion rare on purpose — the argument was that a Captain should be a man
 * who survived a campaign. What it produced was a table whose top half nobody
 * ever saw: twenty survived victories is longer than the game is. The rule is
 * now the plainest one available, LIVE THROUGH A MISSION AND TAKE THE NEXT
 * RANK, so `missionsRequired` is simply the row's own index.
 *
 * THE LENGTH IS NO LONGER FREE. `rank-insignia-sheet.png` is an 8x2 grid of
 * sixteen badges in this order, so a seventeenth rung would be a rank with no
 * insignia and a fifteenth would leave one drawn for nobody. The tie is asserted
 * in `src/ui/__tests__/rank-insignia.test.ts`, which is the only file that can
 * see both the table and the sheet.
 *
 * EVERY NAME THE OLD SIX-RUNG LADDER COULD WRITE IS STILL HERE — Private,
 * Corporal, Sergeant, Lieutenant, Captain, Major — and still in that order. That
 * is not sentiment: a dead man's rank is RECORDED (`types.ts` argues why), so
 * those six strings are sitting in players' saved games and carved on their
 * existing gravestones. Dropping one would blank a badge on a live memorial.
 *
 * THE NAMES ARE MATCHED TO THE ARTWORK BY POSITION, and that is all the claim
 * being made. The sheet runs chevrons, then rockers, then shields, then bars,
 * then a leaf, an eagle and stars — a recognisable ascent — and these names run
 * alongside it. It is not a transcription of any real service's insignia and
 * should not be read as one.
 */
const LADDER = [
  { name: 'Private', missionsRequired: 0 },
  { name: 'Private First Class', missionsRequired: 1 },
  { name: 'Corporal', missionsRequired: 2 },
  { name: 'Sergeant', missionsRequired: 3 },
  { name: 'Staff Sergeant', missionsRequired: 4 },
  { name: 'Sergeant Major', missionsRequired: 5 },
  { name: 'Warrant Officer', missionsRequired: 6 },
  { name: 'Chief Warrant Officer', missionsRequired: 7 },
  { name: 'Master Warrant Officer', missionsRequired: 8 },
  { name: 'Second Lieutenant', missionsRequired: 9 },
  { name: 'Lieutenant', missionsRequired: 10 },
  { name: 'Captain', missionsRequired: 11 },
  { name: 'Major', missionsRequired: 12 },
  { name: 'Colonel', missionsRequired: 13 },
  { name: 'Brigadier', missionsRequired: 14 },
  { name: 'General', missionsRequired: 15 },
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
  // ONE ANSWER, NOT TWO. This used to walk the ladder itself; it now reads the
  // index, so the name a man is called and the badge he is drawn with cannot
  // come from two rules that agree today. See `rankIndexFor`.
  // Written out rather than asserted away: `noUncheckedIndexedAccess` is right
  // that an index is not a proof, even one this function just produced. The
  // fallback is the bottom rung, which is what an empty ladder would mean.
  return LADDER[rankIndexFor(missionsSurvived)]?.name ?? LADDER[0].name
}

/**
 * The RUNG a record of `missionsSurvived` earns, as a position in `RANKS`.
 *
 * THE BADGE NEEDS A NUMBER, NOT A NAME. `rank-insignia-sheet.png` is a grid and
 * the screen picks a cell out of it by index; going name → index would mean
 * searching the table for a string this function had just produced from it.
 *
 * IT IS THE FUNCTION `rankFor` IS BUILT ON rather than a sibling of it, which is
 * the whole point: two walks over the same ladder would be two answers to "what
 * is he", and the day they disagreed a Sergeant would be drawn wearing a
 * Corporal's stripes with nothing raised anywhere.
 *
 * A NONSENSE RECORD LANDS ON THE BOTTOM RUNG. `missionsSurvived` comes off a
 * save a stranger can edit, so `NaN` and negatives have to answer something —
 * and `NaN >= 0` is false, so the loop below simply never advances, which is
 * the bottom rung by construction rather than by a special case.
 *
 * IT TOPS OUT rather than running off the end: a man who outlasts the table
 * holds its highest rank, not `undefined` printed into the HUD as the word
 * "undefined". Sixteen rungs at one a mission make that a case a long campaign
 * actually reaches.
 */
export function rankIndexFor(missionsSurvived: number): number {
  let earned = 0
  for (const [i, rung] of LADDER.entries()) {
    if (missionsSurvived >= rung.missionsRequired) earned = i
  }
  return earned
}

/**
 * The rung a RECORDED rank names, or `null` if this ladder has no such rank.
 *
 * FOR THE DEAD, AND ONLY FOR THE DEAD. A living man's rank is derived from his
 * record, so his badge is `rankIndexFor` and there is nothing to look up. A dead
 * man's is RECORDED and never recomputed — `types.ts` argues it at length: his
 * record has stopped changing, so recomputing can only overwrite a fact with a
 * guess made under a newer table. His badge therefore has to be found from the
 * name carved on the stone.
 *
 * WHICH MEANS THE NAME MAY BE ONE THIS TABLE NO LONGER HAS. Saves written before
 * ticket 062 carry the six-rung ladder's names; every one of those six is still
 * in the table above, deliberately, but nothing guarantees that for a table
 * edited later.
 *
 * SO IT ANSWERS `null` AND NOT 0. Falling back to the first rung would pin a
 * private's single chevron on a dead Major — silently, on a memorial, which is
 * the worst screen in the game to be quietly wrong on. No badge is honest; a
 * confident wrong one is not.
 */
export function insigniaIndexOf(rankName: string): number | null {
  const index = LADDER.findIndex((rank) => rank.name === rankName)
  return index === -1 ? null : index
}
