/**
 * THE COMBAT TUNING SURFACE (ticket 011).
 *
 * Every number that decides how a firefight *feels* lives in this file, as plain
 * data, and nowhere else. `los.ts`, `resolution.ts` and `system.ts` contain the
 * mechanism and not one magic constant between them, so retuning the game is
 * editing values here rather than reading three systems to find where the feel
 * is hiding.
 *
 * Two rules keep it that way and are worth stating, because both are easy to
 * erode by accident:
 *
 *   - SPECS ARE DATA, NOT BEHAVIOUR. No functions, no getters, no derived
 *     fields. A spec must survive a JSON round-trip unchanged, which is what
 *     lets a later ticket load weapon tables from the level document (or from a
 *     designer's spreadsheet) with no code change at all.
 *   - DAMAGE IS A VALUE, NOT A BOOLEAN. "Infantry die to one hit" is faithful to
 *     the original, but it is an *outcome* of a rifle round doing at least
 *     `INFANTRY_HEALTH` damage — never a `kill: true` flag or an `if (isInfantry)`
 *     in the hit path. That is the whole of the vehicles extension point: a jeep
 *     spawned with health 10000 already survives a rifle round today, and
 *     nothing in `resolution.ts` had to learn what a jeep is.
 *
 * TIME IS MEASURED IN TICKS, never seconds. The sim runs at the fixed timestep in
 * `core/world/gameloop.ts` (60 Hz), and a cooldown expressed in seconds would
 * have to be converted somewhere, which is a rounding decision that then differs
 * between two machines and breaks replay. Divide by 60 in your head.
 */

import type { Weapon } from '../world/events'
import type { Team } from '../world/world'

/**
 * One weapon's complete tuning. Everything a shot needs to know, and nothing
 * about *who* is holding it.
 */
export interface WeaponSpec {
  /** The identifier `ShotFired.weapon` carries, so FX and audio can key on it. */
  readonly name: Weapon

  /**
   * Health removed per hit.
   *
   * RAISE IT and nothing changes against infantry (they already die to one
   * round) but vehicles fall faster. LOWER IT below `INFANTRY_HEALTH` and the
   * game stops being Cannon Fodder: soldiers start trading several rounds each,
   * firefights become attritional, and the "one careless step and the mission is
   * over" tension that the whole design rests on disappears.
   */
  readonly damage: number

  /**
   * Ticks a unit must wait between shots. At 60 Hz this is the rate of fire.
   *
   * THE SINGLE MOST IMPORTANT FEEL NUMBER. Raise it and engagements become
   * deliberate — you can round a corner, see an enemy and still retreat. Lower
   * it and every sightline is instant death, including yours, because the enemy
   * uses the same table.
   *
   * EVERY VALUE IS AVAILABLE, which was not true until ticket 092. The rate
   * assertion in `resolution.test.ts` used to count a minute as
   * `floor(ticksInAMinute / cooldownTicks) + 1`, overcounting by one for any
   * cooldown that divided the minute exactly — so 30, 36, 40, 45 and 60 all
   * failed a test for reasons that had nothing to do with the game, and this
   * comment used to warn designers away from them. The arithmetic was the thing
   * that was wrong; it is `ceil` now, and the warning is gone rather than
   * reworded. A test in `enemy-weapon.test.ts` asserts it stays gone.
   */
  readonly cooldownTicks: number

  /**
   * Maximum engagement distance, in tiles. `TILE_WORLD_SIZE` is 1, so this is
   * also the distance in world units — see `core/view/projection`.
   *
   * KEEP IT INSIDE THE VISIBLE AREA. A weapon that outranges the camera means
   * units trade fire with things the player cannot see, which does not read as
   * being outmanoeuvred, it reads as dying to nothing. Raise it and the game
   * becomes a sniping duel fought off-screen; lower it and units walk into
   * knife range before anyone fires, which wastes the cover the levels contain.
   */
  readonly rangeTiles: number

  /**
   * How likely a round is to land, as a function of how far it has to travel
   * (ticket 011b).
   *
   * WHY THIS EXISTS AT ALL. Before it, `resolution.ts` checked team, range and
   * line of sight and the round landed — so with `INFANTRY_HEALTH` at 1 any
   * sightline was an execution, and no cover, manoeuvre or reaction changed the
   * outcome. The complaint was never that men die too easily; it is that they
   * die INEVITABLY, which is why this is a probability and not a health raise.
   *
   * IT FALLS OFF WITH RANGE, and that is the decision worth making. A flat
   * chance would make a shot at one tile as unreliable as one at eight, which
   * reads as the soldiers being incompetent rather than the distance being long.
   * Falling off makes closing worth doing, makes backing out of the envelope a
   * real option, and answers the reported symptom directly: an enemy who has
   * just reached the edge of his range mostly misses.
   *
   * Interpolated LINEARLY between the two ends and clamped outside them — see
   * `hitChanceAt` in `resolution.ts`. Linear because nothing yet argues for a
   * curve; if something ever does, `ordnance/table.ts`'s `falloff` is the
   * pattern to copy — a string naming a curve, never a function in a spec,
   * because a spec must survive the JSON round trip this file promises.
   */
  readonly accuracy: {
    /** Hit chance at zero distance. */
    readonly pointBlank: number
    /** Hit chance at exactly `rangeTiles`. */
    readonly maxRange: number
  }
}

/** The standard rifle. Every soldier in the PLAYER'S squad carries one. */
export const RIFLE: Weapon = 'rifle'

/**
 * What the other side carries (ticket 036). The same rifle in silhouette — same
 * damage, same accuracy curve — but slower to fire and shorter ranged.
 *
 * A SEPARATE ROW RATHER THAN A MODIFIER APPLIED TO `RIFLE`. `ShotFired.weapon`
 * carries this identifier, so FX and audio COULD tell an incoming round from an
 * outgoing one without being told which team fired it; a multiplier living in
 * the shooting path would be invisible to them and would also be behaviour
 * hiding in a file that promises to be data.
 *
 * Nothing reads `event.weapon` yet — tickets 025 and 027 are the first that
 * will. Stated as a property this makes available, not as one anything uses.
 */
export const ENEMY_RIFLE: Weapon = 'enemy-rifle'

/**
 * How far the enemy's rifle reaches ON THE DEFAULT DIFFICULTY, as a fraction of
 * the squad's.
 *
 * THE ENEMY'S RANGE IS DERIVED FROM THE PLAYER'S, NOT TYPED AS A SECOND NUMBER.
 * A hardcoded 6.4 beside an 8 is two values that agree today and nothing that
 * makes them agree tomorrow; expressed as a fraction, a later retune of
 * `RIFLE_RANGE_TILES` carries the relationship with it.
 *
 * RAISE IT toward 1 and the standoff band closes: at 1 the two sides hold the
 * same reach and backing off stops being an answer to being engaged. LOWER IT
 * and the band widens until the squad can stand outside the envelope and kill a
 * garrison that never gets to reply — free kills, and a level that stops asking
 * anything of the player.
 *
 * 0.8 leaves 1.6 tiles of band at the current 8-tile rifle: wide enough that a
 * step or two of retreat is a real decision, narrow enough that it takes
 * deliberate movement rather than happening by accident.
 *
 * AND CLOSING THE BAND IS WHAT `hard` IS (tickets 092, 093). Ticket 092 removed
 * this fraction outright and shipped the closed band as the default; 093 put the
 * default back and made 092's enemy the `hard` row below. So the value here is
 * the NORMAL game, and `ENEMY_RIFLE_HARD` is the same weapon with the handicap
 * lifted.
 */
export const ENEMY_RANGE_FRACTION = 0.8

/**
 * The squad rifle's reach, in tiles, hoisted out of the rows below so the
 * enemy's can be written as a multiple of it rather than as a literal.
 *
 * The reasoning about the VALUE lives on `WeaponSpec.rangeTiles` and on the row
 * itself — this constant exists only so that the rows read from one place.
 */
const RIFLE_RANGE_TILES = 8

/**
 * Health an infantryman has.
 *
 * ONE. Health is a scale, not a binary — a jeep spawns with 5 and a bunker could
 * spawn with 500 — but on this scale a soldier is worth exactly one rifle round,
 * which is what "faithful to the original's lethality" means in numbers.
 *
 * RAISE IT and every soldier becomes a damage sponge; the tension of the whole
 * game is that a single careless step ends a man, and no amount of animation
 * polish substitutes for it.
 *
 * Must agree with `DEFAULT_HEALTH` in `core/world/world.ts`, which is what a
 * spawn that names no health gets — and every soldier spawn does exactly that.
 * Stated here rather than imported from there because `world` is the layer
 * beneath `combat` and cannot depend upward on this file, and because "is a
 * rifle round lethal?" must be answerable by reading the tuning surface alone.
 */
export const INFANTRY_HEALTH = 1

/**
 * HOW WIDE THE LINE OF FIRE IS: the greatest PERPENDICULAR distance, in tiles, a
 * man may stand from the ray a commanded round travels along and still be the
 * thing it hits (ticket 011c).
 *
 * A HALF-WIDTH, not a width. The corridor is `2 * AIM_CORRIDOR_TILES` tiles
 * across, centred on the line, because the forgiveness is the same on both sides
 * of it.
 *
 * IT REPLACED `AIM_TOLERANCE_TILES`, AND THE RENAME WAS THE POINT. That number
 * was a radius around the aim POINT: a click had to land within two tiles of a
 * man to hit him, so a click into the gap between two enemies, or at the ground
 * behind one, hit nobody. Aiming is a DIRECTION (ticket 011c), so the same
 * forgiveness is rotated — a disc around the click becomes a corridor along the
 * line of fire. Keeping the old name would have left every comment naming it
 * describing the wrong shape.
 *
 * A FEEL NUMBER, and it lives here for that reason: it decides who gets shot.
 * A soldier occupies about a tile, so a HALF-WIDTH of 1.5 forgives a pointer
 * that is off by about a man and a half. RAISE IT and "vaguely forwards"
 * becomes a guaranteed hit and the rifle starts aiming itself; LOWER IT and a
 * click a pixel off a running man is suppressing fire into the dirt beside him.
 *
 * WIDENED FROM 0.75 TO 1.5 BY TICKET 036, BECAUSE THE CORRIDOR IS A COST ONLY
 * ONE SIDE PAYS. A candidate outside it is not a miss — it is a round that never
 * existed, with no accuracy roll at all. `ai/system.ts`'s `shootAt` commands
 * fire at the target's TILE CENTRE, so the machine is always exactly on-line and
 * never pays this; the player's squad fires only where the player points and
 * pays it on every order. At 0.75 that was an angular tolerance of ±5.4° at
 * eight tiles, which is why the squad read as missing constantly while the enemy
 * did not. 1.5 is ±10.6° at the same distance.
 *
 * 1.5 IS ALSO A DECLARED CEILING, not a value with room above it:
 * `__tests__/line-of-fire.test.ts` asserts `<= 1.5` with the reason "narrow
 * enough that vaguely forwards is not a guaranteed hit". A retune upward has to
 * move that assertion and argue with it, which is where that argument belongs.
 *
 * IT MUST STAY ABOVE HALF A TILE, AND THAT FLOOR IS NOT ABOUT THE POINTER AT
 * ALL. `ai/system.ts`'s `shootAt` commands fire at the target's TILE, which
 * `orderFire` turns into that tile's CENTRE — so the man the machine explicitly
 * selected stands wherever he happens to be walking inside that tile, up to half
 * a tile off its centre on each axis, and therefore that far or further
 * perpendicular to the line the machine itself drew. Tune this below ~0.5 and
 * every enemy in the game becomes unable to hit the man he chose: the
 * auto-commanded path stops working on both sides of the firefight while the
 * player's own pointer still feels fine, which is the kind of break that reads
 * as "the AI got dumber" rather than as a tuning change. A test in
 * `__tests__/line-of-fire.test.ts` asserts `> 0.5` with that reason attached, so
 * a retune meets the constraint rather than discovering it.
 *
 * Not a `WeaponSpec` field: it describes the POINTER, not the rifle, and every
 * weapon in the game is aimed with the same one. It becomes per-weapon the day
 * something is aimed differently — a mortar with a wide bracket, say — and
 * moving it into the spec then is a one-line change with this comment as the
 * reason it was ever outside.
 */
export const AIM_CORRIDOR_TILES = 1.5

/**
 * The enemy rifle as the game ships — the row `hard` is a delta from.
 *
 * HOISTED OUT OF `WEAPONS` so `ENEMY_RIFLE_HARD` can spread it. Reading it back
 * out of the table would be `WEAPONS[ENEMY_RIFLE]`, which is `WeaponSpec |
 * undefined` under `noUncheckedIndexedAccess` and would need an assertion to
 * silence — an assertion about a lookup that is a compile-time certainty here
 * and would stay silent if the row were ever renamed.
 */
const ENEMY_RIFLE_NORMAL: WeaponSpec = {
    name: ENEMY_RIFLE,
    // IDENTICAL TO THE SQUAD'S. Lethality is not the lever this ticket pulls —
    // one careless step still ends a man on either side, and dropping it below
    // `INFANTRY_HEALTH` would make enemy fire something the player can stand in.
    damage: INFANTRY_HEALTH,
    // ~1.30 rounds a second against the squad's ~1.88, and still the larger half
    // of the difficulty swing ticket 036 introduced. RAISE IT and the enemy
    // becomes a target rather than a threat; LOWER IT toward 32 and three
    // converging enemies again kill a four-man squad faster than the player can
    // react to the first shot, which is the report that produced this row.
    //
    // 46, DOWN FROM 52 (ticket 075). A deliberate step back toward the squad's
    // rate, taken together with the reaction beat in `ai/tuning.ts`, because the
    // enemy was too easy. 13% more fire, not a different weapon.
    //
    // FASTER THAN THIS IS `hard` (tickets 092, 093), not a retune of this row.
    cooldownTicks: 46,
    // 6.4 tiles, DERIVED and never typed: 8 × 0.8. The 1.6 tiles this leaves
    // between the two reaches is the standoff band — the distance at which the
    // squad can fire and the enemy cannot — and it exists only because the two
    // sides hold different weapons.
    //
    // The multiplication happens ONCE, here, at module construction. What lands
    // in the table is a plain number, so the row still survives the JSON round
    // trip this file promises; a getter would not, and is what the "specs are
    // data" rule at the top forbids.
    rangeTiles: RIFLE_RANGE_TILES * ENEMY_RANGE_FRACTION,
    accuracy: {
      // THE SAME CURVE AS THE SQUAD'S, DELIBERATELY UNCHANGED. The endpoints are
      // relative to each weapon's OWN `rangeTiles`, so shortening the range has
      // already steepened the falloff in real terms: at 6.4 tiles this man is at
      // his worst instead of partway down the curve. Moving the endpoints as
      // well would be two changes explaining one outcome, and nothing could then
      // say which of them produced it.
      pointBlank: 0.9,
      maxRange: 0.25,
    },
  }

/**
 * Every weapon in the game, keyed by the identifier `ShotFired` carries.
 *
 * A plain object rather than a `Map`: iteration order over string keys is
 * insertion order and therefore stable, whereas a `Map` invites callers to
 * assume an ordering the sim's determinism guarantee has not promised.
 */
export const WEAPONS: Readonly<Record<Weapon, WeaponSpec>> = {
  [RIFLE]: {
    name: RIFLE,
    // Exactly lethal to infantry, and no more. Overkill damage is invisible
    // against soldiers but silently doubles the rifle's effect on the vehicles
    // that arrive later, so the honest value is the one the design states.
    damage: INFANTRY_HEALTH,
    // ~1.9 rounds a second. Fast enough that a soldier caught in the open dies
    // in the time it takes to react, slow enough that a two-second dash across
    // a sightline is survivable — which is what makes flanking worth doing.
    cooldownTicks: 32,
    // Eight tiles. The camera shows appreciably more than this, so a soldier
    // who kills you was on screen when he did it. Named, because the enemy rows
    // below are written against it.
    rangeTiles: RIFLE_RANGE_TILES,
    accuracy: {
      // NINE IN TEN AT ARM'S LENGTH. An enemy who has walked into your squad's
      // faces must still be lethal — the original's tension is that one careless
      // step ends a man, and a rifle that missed half its shots at one tile
      // would make firefights comic and `kill_all` missions interminable.
      pointBlank: 0.9,
      // ONE IN FOUR AT EIGHT TILES, which is the whole ticket in one number:
      // roughly four rounds — measured 3.67, about 1.8 seconds at this
      // cooldown — before the man at the far edge of the envelope falls, so
      // the player reacts to being SHOT AT rather than to being dead. Raise
      // it much past a third and
      // reaching maximum range stops being a survivable answer to being engaged;
      // drop it toward zero and enemies at range become scenery.
      maxRange: 0.25,
    },
  },
  [ENEMY_RIFLE]: ENEMY_RIFLE_NORMAL,
}

/**
 * Which weapon an entity archetype carries, by `Entity.kind`.
 *
 * A kind absent from this table is UNARMED — it can be shot at and killed, but
 * it never fires. That default is deliberate: scenery, wreckage and the
 * transport vehicles the architecture anticipates all pass through `entities`,
 * and a table that armed everything by default would have a parked jeep
 * returning fire.
 */
export const WEAPON_BY_KIND: Readonly<Record<string, Weapon>> = {
  rifleman: RIFLE,
  // THE SAME RIFLE, DELIBERATELY. The sniper archetype (ticket 018,
  // `core/ai/archetypes.ts`) differs in what he NOTICES, not in what he fires:
  // a longer-ranged weapon would be a new row in `WEAPONS` and a retune of the
  // firefight, which is a decision for a ticket that is about weapons. He is
  // here at all because an archetype whose kind cannot hold a weapon is a
  // soldier who sees, alerts and pursues and then cannot shoot — and a test in
  // `core/ai/__tests__/archetypes.test.ts` asserts this table and that one name
  // the same kinds, precisely so this row cannot be forgotten.
  sniper: RIFLE,
}

/**
 * Where a team disagrees with `WEAPON_BY_KIND` about what a kind carries
 * (ticket 036). A team with no entry here, or a kind absent from its entry,
 * falls through to `WEAPON_BY_KIND` — so this table states DIFFERENCES only and
 * the default arming keeps its meaning for everyone.
 *
 * ARMED BY TEAM AND NOT BY A NEW KIND, and that was the decision. Levels 1 and 2
 * spawn eighteen enemies between them and not one names a `type`, so a
 * kind-based split would mean re-authoring every level — including 3–5, which
 * are not imported yet — and a level that forgot would silently arm its garrison
 * with the player's rifle. Team is the one property every spawn in the game
 * already carries and cannot omit.
 *
 * EVERY ARMED KIND MUST APPEAR IN THE ENEMY ROW. `sniper` is here for the same
 * reason it is in `WEAPON_BY_KIND`: an override that listed `rifleman` alone
 * would leave enemy snipers holding the PLAYER'S rifle, outranging and
 * outshooting the line infantry standing beside them, and nothing would say so.
 */
export const WEAPON_BY_TEAM: Readonly<Record<Team, Readonly<Record<string, Weapon>>>> = {
  player: {},
  enemy: {
    rifleman: ENEMY_RIFLE,
    sniper: ENEMY_RIFLE,
  },
}

/**
 * How hard the enemy fights (ticket 093).
 *
 * TWO NAMED SETTINGS RATHER THAN A NUMBER, because a scalar invites arithmetic
 * on tuning values — `rangeTiles * multiplier` for an arbitrary multiplier —
 * and nobody would ever have measured the result. These are two authored rows,
 * each defensible on its own.
 *
 * `normal` IS WHAT THE GAME SHIPS AS. Ticket 092 raised the enemy for everybody
 * and the difficulty was the honest home for it: the reported problem was never
 * that the default was too easy, it was that there was no way to ask for more.
 */
export type Difficulty = 'normal' | 'hard'

/**
 * The enemy rifle on `hard`: the squad's reach, and six ticks off the cooldown
 * (tickets 092, 093).
 *
 * SPREAD FROM THE NORMAL ROW AND OVERRIDING TWO FIELDS, deliberately. Written
 * as four fresh literals, a later retune of `damage` or of the accuracy curve
 * would land on one difficulty and not the other, and nothing would say so —
 * the hard player would be fighting a DIFFERENT weapon rather than a harder
 * one. This way the two rows can only ever differ in reach and rate, and a test
 * in `enemy-weapon.test.ts` pins exactly that.
 *
 * THE NAME IS UNCHANGED, which is the other half of the decision. `Weapon` is
 * `string` — an open enum — and `ShotFired.weapon` carries it to FX and audio.
 * A second identifier would make every one of those consumers responsible for
 * knowing about difficulty, and being an open enum, nothing would fail to
 * compile when one forgot. A hard round sounds and looks exactly like a normal
 * one, because it IS one; it simply comes from further away and more often.
 *
 * 40 DIVIDES A MINUTE EXACTLY AND THAT IS FINE NOW. `WeaponSpec.cooldownTicks`
 * records why it once was not, and why nothing in this file should go back to
 * naming the tick count of a minute as a value to steer around.
 */
const ENEMY_RIFLE_HARD: WeaponSpec = {
  ...ENEMY_RIFLE_NORMAL,
  rangeTiles: RIFLE_RANGE_TILES,
  cooldownTicks: 40,
}

/**
 * The weapon table each difficulty answers from.
 *
 * A WHOLE TABLE PER DIFFICULTY rather than a patch applied at lookup time, so
 * `weaponFor` stays a read and every row is inspectable as data — the same
 * reason `WEAPONS` is a plain object. `hard` spreads `WEAPONS` and replaces one
 * row, so a weapon added to the game arrives on both difficulties automatically
 * and cannot be forgotten on one.
 */
const WEAPONS_BY_DIFFICULTY: Readonly<Record<Difficulty, Readonly<Record<Weapon, WeaponSpec>>>> = {
  normal: WEAPONS,
  hard: { ...WEAPONS, [ENEMY_RIFLE]: ENEMY_RIFLE_HARD },
}

/** The spec an entity of this kind fires with, or `null` if it is unarmed. */
export function weaponForKind(kind: string): WeaponSpec | null {
  const name = WEAPON_BY_KIND[kind]
  if (name === undefined) return null
  return WEAPONS[name] ?? null
}

/**
 * The spec an entity of this kind, on this team, at this difficulty, fires with
 * — or `null` if it is unarmed (tickets 036, 093).
 *
 * THE SEAM THE WHOLE OF 036 NEEDED. Both sides spawn as `kind: 'rifleman'`, so
 * before it there was no property by which the enemy could be given a different
 * weapon at all.
 *
 * A kind the team does not override falls through to `weaponForKind`, and a kind
 * neither table names is UNARMED on every team and every difficulty — the
 * default that stops a parked jeep returning fire, preserved here because an
 * override table that fell through to SOMETHING rather than to nothing would arm
 * every piece of scenery on one side of the map.
 *
 * THE DIFFICULTY IS AN ARGUMENT WITH A `normal` DEFAULT, NOT MODULE STATE
 * SOMETHING SETS AT BOOT (ticket 093). A mutable module-level difficulty would
 * be global state in the one layer whose determinism guarantee is why replays
 * work, and `main.ts` already builds more than one session in a page — the
 * campaign runner makes a fresh one per mission, and two of them would fight
 * over it. The default is what keeps every call site written before 093, and
 * every test in the repo that names no difficulty, a test of the shipped game.
 *
 * BOTH SYSTEMS THAT CALL THIS MUST BE HANDED THE SAME VALUE. `combat/system.ts`
 * asks whether a round reaches; `ai/system.ts` asks where to stop walking. Hand
 * the difficulty to one and not the other and the enemy closes for one range and
 * shoots at another — each system internally consistent and wrong about its
 * partner, which no unit test of either can see. `createSession` resolves it
 * once and `session/__tests__/difficulty.test.ts` is what holds them together.
 */
export function weaponFor(
  kind: string,
  team: Team,
  difficulty: Difficulty = 'normal',
): WeaponSpec | null {
  const table = WEAPONS_BY_DIFFICULTY[difficulty]
  const override = WEAPON_BY_TEAM[team][kind]
  if (override !== undefined) return table[override] ?? null
  const byKind = WEAPON_BY_KIND[kind]
  if (byKind === undefined) return null
  return table[byKind] ?? null
}
