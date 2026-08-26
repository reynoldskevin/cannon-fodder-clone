/**
 * THE ENEMY ARCHETYPE TABLE (ticket 018).
 *
 * `tuning.ts` holds ONE set of numbers for the whole map — how far *an* enemy
 * sees, how long *an* enemy stays interested. That is a difficulty dial, not a
 * cast list: a sniper and a conscript could not differ, because there was
 * nowhere to say how. This file is where they differ, keyed by `Entity.kind`,
 * and `tuning.ts` keeps its old job as the fallback an unknown kind gets.
 *
 * TWO TUNING SURFACES, AND DELIBERATELY SO. The WEAPON a kind carries stays in
 * `combat/weapons.ts`'s `WEAPON_BY_KIND`, where it already lives. Folding both
 * into one row here would put `core/combat` — the lower layer, which knows
 * nothing of the AI — behind `core/ai`, and an inverted dependency is a much
 * worse thing to own than a second table. What keeps the two honest is a test:
 * every key here must name a kind `weaponForKind` can arm. ADDING A ROW HERE
 * THEREFORE MEANS ADDING ITS WEAPON ROW THERE, and the suite says so out loud —
 * without that assertion these two tables are exactly the duplication this
 * codebase keeps refusing to accept, and the symptom is a soldier who patrols,
 * sees, alerts, pursues and cannot fire.
 *
 * SPECS ARE DATA, NOT BEHAVIOUR — the rule `combat/weapons.ts` states and
 * `ordnance/table.ts` repeats. No functions, no getters, no derived fields: a
 * row must survive a JSON round-trip unchanged, which is what lets a later
 * ticket read a garrison's profile straight out of `level.json` with no code
 * change at all. A getter here would vanish on the way through `JSON.parse` and
 * take a level's difficulty with it.
 *
 * TIME IS IN TICKS, never seconds, for the replay reason `tuning.ts` gives.
 */

/**
 * One enemy kind's complete behaviour tuning. Everything the state machine asks
 * about a unit, and nothing about the rifle it holds.
 */
export interface ArchetypeSpec {
  /**
   * The `Entity.kind` this row describes, repeated inside the row.
   *
   * Redundant against the key, and worth it: a spec handed around on its own —
   * to the debug overlay, to a save file, to a test — would otherwise be a bag
   * of numbers that cannot say who it belongs to. A test pins the two together
   * so the redundancy cannot rot.
   */
  readonly name: string
  /** How far this kind can SEE, in tiles. See `DEFAULT_SIGHT_RANGE_TILES`. */
  readonly sightRangeTiles: number
  /** How far gunfire reaches it, in tiles. See `DEFAULT_ALERT_RADIUS_TILES`. */
  readonly alertRadiusTiles: number
  /** How long it chases a position it can no longer see, in ticks. */
  readonly pursueTimeoutTicks: number
  /** How long it investigates gunfire it heard, in ticks. */
  readonly alertTimeoutTicks: number
  /**
   * How far from its post this kind will be drawn before it gives up, as a
   * MULTIPLE OF ITS OWN SIGHT RANGE.
   *
   * The one genuinely new knob, and the reason it is a multiplier rather than a
   * distance: a fanatic and a garrison guard should read differently without
   * either needing new code, and a leash stated in tiles would have to be
   * retuned by hand every time the sight range moved. RAISE IT and a patrol
   * abandons its beat to follow a man across the map, which is what makes a
   * fanatic feel fanatical and also what empties a compound the player was
   * supposed to have to fight through. LOWER IT toward zero and a guard will not
   * step off his own waypoint, so flanking his post costs nothing.
   *
   * Only a unit with a patrol route has a post to be leashed to; a routeless
   * enemy — which is every enemy in the game today — is bounded by
   * `pursueTimeoutTicks` alone, exactly as it was before this ticket.
   */
  readonly aggression: number
  /**
   * How long this kind takes to open fire after ACQUIRING a target, in ticks.
   * See `DEFAULT_REACTION_TICKS`.
   *
   * The knob that says how ready a kind was for the fight. A man walking a beat
   * has to bring the rifle up; a man already lying behind it does not. LOWER IT
   * and the kind kills a squad that walks into the open before the player can
   * order it back out; RAISE IT and he stands there long enough to read as
   * broken rather than as deliberate.
   *
   * Gates the fire order only — never the halt, the leash or the post — and it
   * is paid ONCE PER UNBROKEN CONTACT: the clock starts when he raises his rifle
   * at a man he was not already engaging, and runs again only after the machine
   * has put him back to `idle`. A man who re-aims at a nearer attacker
   * mid-firefight is not surprised by his second opponent, and a target
   * flickering across the edge of his weapon's range — which drops him to
   * `pursue` and straight back — is not a fresh contact either. A count that
   * restarted on either would leave a soldier switching and waiting forever
   * without ever firing. `system.ts`'s `Memory.armedTargetId` is where the rule
   * lives.
   */
  readonly reactionTicks: number
}

/**
 * The kind every level in the game spawns today, and the kind a spawn point
 * that names no `type` gets (`World.DEFAULT_KIND`).
 *
 * Exported so the fallback is nameable rather than a string literal repeated in
 * three files.
 */
export const DEFAULT_ARCHETYPE_NAME = 'rifleman'

/**
 * Every enemy archetype, keyed by `Entity.kind`.
 *
 * A plain object rather than a `Map`, matching `WEAPONS`: string-keyed
 * iteration order is insertion order and therefore stable, where a `Map` invites
 * callers to assume an ordering the sim's determinism guarantee never promised.
 */
export const ARCHETYPES: Readonly<Record<string, ArchetypeSpec>> = {
  /**
   * The line infantryman. Level 1 spawns three of him and nothing else.
   *
   * EVERY NUMBER HERE IS THE SYSTEM DEFAULT, COPIED DELIBERATELY. This ticket
   * introduced per-unit stats; it must not retune a shipped level by a tile on
   * the way past. The day this row and `tuning.ts` disagree, one of the two is a
   * decision nobody made — which is why a test compares them rather than trusting
   * this comment. Import them rather than restate them? No: `tuning.ts`'s values
   * are the FALLBACK FOR AN UNKNOWN KIND, and binding the rifleman to them would
   * mean a designer could not give him his own eyes without changing what
   * "unknown" means for everybody else.
   */
  [DEFAULT_ARCHETYPE_NAME]: {
    name: DEFAULT_ARCHETYPE_NAME,
    sightRangeTiles: 12,
    alertRadiusTiles: 14,
    pursueTimeoutTicks: 300,
    alertTimeoutTicks: 300,
    // Twelve tiles of leash at his sight range: far enough to chase a man round
    // a corner, short enough that he goes back to his beat rather than crossing
    // the level. The neutral value, and the one every later row is read against.
    aggression: 1,
    // Three quarters of a second, and equal to `DEFAULT_REACTION_TICKS` like
    // every other number in this row — see the note above it.
    //
    // CHOSEN ON REASONING AND MEASUREMENT, NOT ON PLAY. Measured end to end over
    // forty seeds with ticket 011b's accuracy in place: an enemy who starts two
    // tiles away now takes 0.75s to fire his first round and 0.95s to land a
    // killing one, where before both were frame zero; at nine tiles it is 1.08s
    // and 2.51s against a third of a second. That is a beat a player can act
    // inside, which is what this number is for.
    //
    // What has NOT happened is somebody sitting down and playing it. The band
    // the tests hold this to is [20, 75], and 30 and 60 are the neighbours worth
    // trying first — 30 for a game that feels too slow, 60 if enemies read as
    // standing about. Say which was played, in this comment, when one is.
    reactionTicks: 45,
  },
  /**
   * The marksman. Sees half again as far as the line infantryman and is happy
   * to stay where he is.
   *
   * WHY A SECOND ROW SHIPS AT ALL. A table with one row is a constant with
   * extra steps: "five levels feel different without five sets of code" is a
   * claim about VARIATION, and it is demonstrated by a row that varies. This is
   * also the only thing that can tell a caller's table apart from a merge of it
   * — `rifleman` equals `tuning.ts` by design, so a caller who replaces the
   * table and a caller who merges over it get identical behaviour out of that
   * row, and only a row that genuinely differs can show the difference.
   *
   * HE DIFFERS IN ONE THING AND IS OTHERWISE THE INFANTRYMAN. Eighteen tiles of
   * sight against twelve: he opens the engagement, because he notices the squad
   * crossing ground the rifleman would have let pass. He does NOT outrange it —
   * the weapon table gives him the same rifle, and "how far can he shoot" is a
   * decision for a ticket about weapons, not one about eyes.
   *
   * His HEARING is the standard fourteen on purpose. Moving two numbers at once
   * would make it impossible to say which one produced the behaviour a designer
   * is looking at, and there is nothing about a marksman that says he has
   * better ears.
   *
   * He gives up a chase in half the time (150 ticks, two and a half seconds)
   * and will not be drawn more than half his sight from his post
   * (`aggression: 0.5`, so nine tiles). Both say the same thing about him: his
   * advantage is the position he is already standing in, and a sniper who
   * abandons it to follow a man round a corner has thrown away the only thing
   * that made him worth placing there. RAISE either and he becomes a rifleman
   * with better eyes, which is a waste of a row.
   */
  sniper: {
    name: 'sniper',
    sightRangeTiles: 18,
    alertRadiusTiles: 14,
    pursueTimeoutTicks: 150,
    alertTimeoutTicks: 300,
    aggression: 0.5,
    // A third of a second against the rifleman's three quarters, and it is the
    // second thing that says what he is for: he is already in position looking
    // down the sightline, so there is no rifle to bring up. A marksman SLOWER
    // off the mark than a conscript would be a row stating the opposite of what
    // ticket 018 placed him for.
    reactionTicks: 20,
  },
}

/**
 * The archetype for a kind, or `undefined` if nothing has heard of it.
 *
 * NOT A THROW AND NOT A SILENT DEFAULT. The caller decides what an unknown kind
 * falls back to — for the AI that is the system options, which is precisely what
 * keeps every level authored before this ticket behaving as it did. A default
 * substituted here would make "this level names an archetype the build does not
 * have" indistinguishable from "this level names the standard one".
 */
export function archetypeFor(kind: string): ArchetypeSpec | undefined {
  return ARCHETYPES[kind]
}
