/**
 * WHO IS STILL STANDING, IN THE CAMPAIGN'S OWN VOCABULARY (ticket 066).
 *
 * The squad panel lists men by NAME, which is a campaign fact; the simulation
 * knows only entity ids and has never heard of a recruit. `Session.assignment`
 * is the one place those two vocabularies meet — see the field's own note in
 * `index.ts`, and `__tests__/squad-assignment.test.ts`, which exists because a
 * mismatch across that join is the worst bug available: the game tells the truth
 * about the wrong people, and nothing inside either half can notice.
 *
 * THIS CROSSES THE SAME JOIN, so it is a named function with its own test rather
 * than four lines inlined into the render loop. It is handed a map KEYED by the
 * sim's ids and VALUED in the campaign's, and answers in values. Returning the
 * keys instead — the inversion that reads perfectly well — produces a set of
 * exactly the right SIZE containing exactly the wrong things, so the panel would
 * match no name at all and quietly go blank.
 *
 * ENGINE-FREE like the rest of `src/core`, and it does not take a `World`: the
 * liveness question arrives as a predicate, which is what lets the awkward cases
 * be pinned without standing a whole session up to reach them.
 */

/**
 * The recruit ids of the men whose entity is still alive.
 *
 * ADDITIVE, NEVER SUBTRACTIVE — a recruit stays on the roll while ANY entity
 * mapped to him lives. `selectSquad` guarantees one man per avatar slot so two
 * entities cannot share a recruit today; the cheap shape (start from every
 * recruit and delete on the first dead entity seen) is still the wrong one,
 * because the day something spawns a second body for a soldier it would report a
 * LIVING man dead, and the symptom is a name vanishing off the rail with the man
 * still on his feet.
 *
 * AN EMPTY ASSIGNMENT ANSWERS WITH AN EMPTY SET, which is not an edge case worth
 * a branch: `createSession` leaves `assignment` EMPTY, NEVER MISSING, when no
 * squad was given, and a mission run without a campaign behind it must not throw
 * its way out of the render loop.
 */
export function livingRecruitIds(
  assignment: ReadonlyMap<number, string>,
  isAlive: (entityId: number) => boolean,
): ReadonlySet<string> {
  const living = new Set<string>()
  for (const [entityId, recruitId] of assignment) {
    if (isAlive(entityId)) living.add(recruitId)
  }
  return living
}
