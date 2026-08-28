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
 * The rifle's reach, in tiles. BOTH rows read it, which is the whole reason it
 * is hoisted out of them.
 *
 * THERE USED TO BE A FRACTION HERE (ticket 036's `ENEMY_RANGE_FRACTION = 0.8`),
 * giving the enemy 6.4 tiles against the squad's 8 and opening a 1.6-tile band
 * in which the player could fire and the enemy could not. Ticket 092 closed it:
 * the two sides reach equally again, and the only handicap the enemy still
 * carries is his rate of fire.
 *
 * THE FRACTION WAS DELETED RATHER THAN SET TO 1, and that is not a style point.
 * A constant multiplying by one is not a fraction; it is a public export
 * announcing a handicap that no longer exists, and the next person to reach for
 * it finds a lever wired to nothing. What the derivation was actually FOR —
 * that a retune of the rifle carries both rows with it rather than leaving two
 * numbers that agree today — survives intact, because both rows still name this
 * constant.
 *
 * RAISE IT and the firefight moves outward for both sides at once; LOWER IT and
 * units walk into knife range before anyone fires. The reasoning about the value
 * lives on `WeaponSpec.rangeTiles`.
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
    // who kills you was on screen when he did it. Named, because the enemy row
    // below reads the same constant.
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
  [ENEMY_RIFLE]: {
    name: ENEMY_RIFLE,
    // IDENTICAL TO THE SQUAD'S. Lethality is not the lever this ticket pulls —
    // one careless step still ends a man on either side, and dropping it below
    // `INFANTRY_HEALTH` would make enemy fire something the player can stand in.
    damage: INFANTRY_HEALTH,
    // ~1.50 rounds a second against the squad's ~1.88 — four for every five.
    //
    // AND IT IS NOW THE ONLY THING SEPARATING THE TWO ROWS. Ticket 036 handed
    // the enemy two handicaps at once, a shorter reach and a slower rate; 092
    // returned the reach, so this number carries the whole difference alone.
    // RAISE IT and he becomes a target rather than a threat; LOWER IT to 32 and
    // the two sides are identical, which is the configuration that measured
    // unbeatable — three converging enemies killing a four-man squad in 1.7
    // seconds, faster than the player could react to the first round.
    //
    // 40, DOWN FROM 46 (ticket 092), which was down from 52 (ticket 075). The
    // trend is deliberate and it is running out of room: 32 is the floor, and
    // it is not a value this row can take while `enemy-weapon.test.ts` still
    // asserts he is the slower shot.
    //
    // 40 DIVIDES THE MINUTE, WHICH USED TO DISQUALIFY IT. See
    // `WeaponSpec.cooldownTicks` — the rate assertion overcounted by one for
    // exactly those values, and 092 fixed the arithmetic rather than picking a
    // number that dodged it.
    cooldownTicks: 40,
    // THE SAME EIGHT TILES AS THE SQUAD'S, from the same constant. Ticket 036
    // wrote this as `RIFLE_RANGE_TILES * ENEMY_RANGE_FRACTION` for 6.4; the
    // fraction is gone (see `RIFLE_RANGE_TILES`) and the constant is not,
    // because the reason for naming it — one retune moving both rows — never
    // depended on the two values differing.
    //
    // What lands in the table is still a plain number, so the row survives the
    // JSON round trip this file promises. A getter would not, and is what the
    // "specs are data" rule at the top forbids.
    rangeTiles: RIFLE_RANGE_TILES,
    accuracy: {
      // THE SAME CURVE AS THE SQUAD'S, DELIBERATELY UNCHANGED — and with the
      // reach now equal too, identical in real terms as well as in its
      // endpoints, where under ticket 036 the shorter range made it effectively
      // steeper. Moving the endpoints as well would be two changes explaining
      // one outcome, and nothing could then say which produced it.
      pointBlank: 0.9,
      maxRange: 0.25,
    },
  },
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

/** The spec an entity of this kind fires with, or `null` if it is unarmed. */
export function weaponForKind(kind: string): WeaponSpec | null {
  const name = WEAPON_BY_KIND[kind]
  if (name === undefined) return null
  return WEAPONS[name] ?? null
}

/**
 * The spec an entity of this kind, on this team, fires with — or `null` if it is
 * unarmed (ticket 036).
 *
 * THE SEAM THE WHOLE TICKET NEEDED. Both sides spawn as `kind: 'rifleman'`, so
 * before this there was no property by which the enemy could be given a worse
 * weapon at all.
 *
 * A kind the team does not override falls through to `weaponForKind`, and a kind
 * neither table names is UNARMED on both teams — the default that stops a parked
 * jeep returning fire, preserved here because an override table that fell
 * through to SOMETHING rather than to nothing would arm every piece of scenery
 * on one side of the map.
 */
export function weaponFor(kind: string, team: Team): WeaponSpec | null {
  const override = WEAPON_BY_TEAM[team][kind]
  if (override === undefined) return weaponForKind(kind)
  return WEAPONS[override] ?? null
}
