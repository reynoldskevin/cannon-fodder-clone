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
   * CONSTRAINED BY A TEST, and honestly so: the acceptance test asserts the rate
   * over a minute as `floor(3600 / cooldownTicks) + 1`, which overcounts by one
   * for any value that divides 3600 exactly (at 30 ticks a unit fires 120 times
   * in ticks 0..3599, and the formula expects 121). So a retune must avoid the
   * divisors of 3600 — 30, 36, 40, 45, 60 — or fix the formula in
   * `resolution.test.ts` first. Nothing about the game requires this; it is a
   * boundary artefact of how the rate is asserted, written down here because a
   * designer who tries 30 deserves to know why it fails.
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

/** The standard rifle. Every soldier on both sides carries one. */
export const RIFLE: Weapon = 'rifle'

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
 * How far from a commanded aim point a unit may be and still count as the thing
 * that was aimed at, in tiles (ticket 011a).
 *
 * A FEEL NUMBER, and it lives here for that reason: it decides who gets shot.
 * Without a bound, "shoot that patch of ground" would silently become "shoot
 * whoever is nearest that patch of ground", and a right-click on empty grass
 * next to a firefight would pick a man off across the field. RAISE IT and the
 * right-click becomes forgiving to the point of aiming itself; LOWER IT and a
 * click a pixel off a running man is suppressing fire into the dirt beside him.
 * Two tiles is generous enough to forgive the aim of a pointer on a moving
 * target and small enough that the man hit is one the player can see he pointed
 * at.
 *
 * Not a `WeaponSpec` field: it describes the POINTER, not the rifle, and every
 * weapon in the game is aimed with the same one. It becomes per-weapon the day
 * something is aimed differently — a mortar with a wide bracket, say — and
 * moving it into the spec then is a one-line change with this comment as the
 * reason it was ever outside.
 */
export const AIM_TOLERANCE_TILES = 2

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
    // who kills you was on screen when he did it.
    rangeTiles: 8,
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

/** The spec an entity of this kind fires with, or `null` if it is unarmed. */
export function weaponForKind(kind: string): WeaponSpec | null {
  const name = WEAPON_BY_KIND[kind]
  if (name === undefined) return null
  return WEAPONS[name] ?? null
}
