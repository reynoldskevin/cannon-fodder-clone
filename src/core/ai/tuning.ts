/**
 * THE BEHAVIOUR TUNING SURFACE (ticket 012).
 *
 * Every number that decides how an enemy *behaves* lives in this file, as plain
 * data, and nowhere else. `system.ts` holds the mechanism — the state machine,
 * the target scan, the orders it issues — and not one magic constant between
 * them, exactly as `combat/weapons.ts` holds the feel of a firefight and
 * `combat/system.ts` holds none of it.
 *
 * Two rules keep it that way, and both are easy to erode by accident:
 *
 *   - THESE ARE DATA, NOT BEHAVIOUR. No functions, no getters, no derived
 *     fields. Every value here survives a JSON round-trip unchanged, which is
 *     what lets a later ticket read an enemy profile out of the level document
 *     (a jumpy garrison, a sleepy patrol) with no code change at all.
 *   - RANGES ARE NOT WEAPON RANGES. Nothing here says how far a rifle shoots;
 *     that is `WEAPONS[...].rangeTiles`, and the machine asks the weapon table
 *     for it. A second number meaning "how far can he shoot" would be one a
 *     retune in `weapons.ts` silently stopped agreeing with.
 *
 * TIME IS MEASURED IN TICKS, never seconds — the same replay reason
 * `combat/weapons.ts` gives. The sim runs at the fixed timestep in
 * `core/world/gameloop.ts` (60 Hz), and a timeout expressed in seconds would
 * have to be converted somewhere, which is a rounding decision that differs
 * between two machines and breaks replay. Divide by 60 in your head.
 */

/**
 * How far an enemy can SEE, in tiles.
 *
 * Deliberately LONGER than the rifle's eight, and that gap is what `pursue`
 * exists to cross: a man who notices you at twelve tiles and walks four to get a
 * shot is reacting to you, where one whose sight and range were equal would only
 * ever appear to fire the instant he could. RAISE IT and the whole map wakes up
 * at once — every enemy on screen converges the moment the first player unit is
 * spotted, which is a rout rather than a firefight. LOWER IT below the weapon's
 * range and enemies get shot by men they are not allowed to have noticed.
 */
export const DEFAULT_SIGHT_RANGE_TILES = 12

/**
 * How far the sound of a shot carries, in tiles.
 *
 * A little further than sight, on purpose: gunfire is the one thing that reaches
 * a man who cannot see the fight, and it is what turns a level into something
 * that reacts rather than a set of independent turrets. RAISE IT and every
 * firefight pulls the whole map toward it, so stealth stops existing and the
 * first shot decides the mission. LOWER IT to nothing and flanking a position
 * has no cost, because the garrison next door never looks up.
 */
export const DEFAULT_ALERT_RADIUS_TILES = 14

/**
 * How long an enemy will chase a position it can no longer see, in ticks.
 *
 * Five seconds. It is the ONLY thing that ends a pursuit whose destination
 * cannot be reached — a last-known position on the far side of a locked
 * compound, or one the man is walled out of — and without it that soldier walks
 * into geometry for the rest of the mission. RAISE IT and enemies become
 * relentless, following a memory long after any player would have judged the
 * trail cold; LOWER IT toward zero and breaking line of sight for a single tick
 * is enough to be forgotten, which is what makes a stealth game trivial.
 */
export const DEFAULT_PURSUE_TIMEOUT_TICKS = 300

/**
 * How long an enemy will investigate gunfire it heard, in ticks.
 *
 * The same five seconds, and the same job: an alert whose destination is
 * unreachable has to end somehow. Kept equal to the pursue timeout because
 * nothing yet argues they should differ — the day a design wants a garrison that
 * investigates briefly but pursues doggedly, this is the number that moves.
 */
export const DEFAULT_ALERT_TIMEOUT_TICKS = 300

/**
 * How long an enemy takes to open fire after ACQUIRING a target, in ticks.
 *
 * Paid once per unbroken contact rather than on every entry into `engage`; the
 * rule and the reason are in `system.ts`'s `Memory.armedTargetId`.
 *
 * Three quarters of a second (ticket 012a). Without it an enemy issues his fire
 * order on the same tick he enters `engage`, so the first thing the player
 * learns about being spotted is a man falling over: the reaction and the
 * consequence arrive together and there is nothing to react to. This is the beat
 * between the two — he raises his rifle, and the player answers that rather than
 * a casualty. RAISE IT much past a second and the enemy is comic, standing about
 * while a squad walks onto him; LOWER IT toward zero and the complaint above
 * comes straight back.
 *
 * IT HOLDS FIRE AND NOTHING ELSE. The halt on entering `engage` is unaffected,
 * and so are sight, hearing, the leash and both timeouts — a delay that also
 * moved a man would be a retune of engagement distance wearing this name.
 *
 * A FIXED COUNT, NOT A ROLL. Ticks, like every other timeout in this file, for
 * the replay reason at the top: a delay drawn from the rng would make a mission
 * at one seed depend on how many men had engaged before.
 */
export const DEFAULT_REACTION_TICKS = 45

/**
 * How close an enemy walks before he stops and shoots, as a FRACTION OF HIS OWN
 * WEAPON RANGE (ticket 037).
 *
 * A FRACTION AND NOT A DISTANCE, which is the one thing that keeps this file's
 * second rule — "ranges are not weapon ranges" — intact. Nothing here says how
 * far a rifle shoots; this says what part of whatever it reaches he wants to be
 * inside, and the machine multiplies it by the number the weapon table gives.
 * A halt distance in tiles would be a second "how far can he shoot" that a
 * retune in `weapons.ts` silently stopped agreeing with, and it would need
 * retuning by hand every time a weapon moved.
 *
 * Three fifths, matching the rifleman's row for the reason `archetypes.ts`
 * gives: these values are the FALLBACK FOR AN UNKNOWN KIND, and the shipped kind
 * every level spawns must not behave differently from it by accident. RAISE IT
 * toward 1 and enemies open fire from the far edge of their envelope, where the
 * accuracy curve is at its worst — 1 is exactly the halt-at-maximum-range
 * behaviour this ticket replaced. LOWER IT and they walk further with their
 * rifles down before firing: more accurate when they arrive, and further inside
 * the squad's own reach on the way.
 *
 * ENTRY ONLY. `engage` is left on the FULL weapon range, never on this fraction;
 * the two thresholds and the reason there must be two are in `system.ts`.
 */
export const DEFAULT_CLOSE_TO_FRACTION = 0.6

/**
 * How close to its destination a man must be to have ARRIVED, in tiles.
 *
 * Under one tile, because the squad system walks a unit onto the CENTRE of its
 * ordered tile and stops: anything at or above a tile would call the errand
 * finished while he was still a tile short of it, and the man would give up
 * standing next to the thing he went to look at. Anything much tighter risks the
 * opposite — a unit whose final approach is nudged off-centre by the separation
 * push never quite qualifies, and stands on the spot until the timeout retires
 * him.
 */
export const DEFAULT_ARRIVAL_TILES = 0.75
