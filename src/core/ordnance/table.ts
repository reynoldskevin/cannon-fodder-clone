/**
 * THE ORDNANCE TUNING SURFACE (ticket 015).
 *
 * Everything that decides how a grenade or a rocket *feels* lives in this file,
 * as plain data, and nowhere else — exactly the bargain `combat/weapons.ts`
 * makes for the rifle, under exactly the same two rules:
 *
 *   - SPECS ARE DATA, NOT BEHAVIOUR. No functions, no getters, no derived
 *     fields. A row must survive a JSON round-trip unchanged, which is the whole
 *     reason a later ticket can load ordnance out of `level.json` (or a
 *     designer's spreadsheet) without a line of code changing. It is also why
 *     `falloff` is the NAME of a curve rather than the curve itself: the curve is
 *     behaviour and lives in `blast.ts`, the CHOICE of curve is data and lives
 *     here. Putting the function in the row is the obvious move and it silently
 *     ends the round-trip the moment anybody authors ordnance in level data.
 *   - TIME IS MEASURED IN TICKS, never seconds. The sim runs at the fixed
 *     timestep in `core/world/gameloop.ts` (60 Hz), and a fuse expressed in
 *     seconds would have to be converted somewhere — a rounding decision that
 *     then differs between two machines and breaks replay. Divide by 60 in your
 *     head.
 *
 * Speed is TILES PER TICK and gravity is TILES PER TICK SQUARED, for the same
 * reason: those are the units `ballistics.ts` integrates in, so no conversion
 * exists to get wrong.
 */

/**
 * How blast damage decays from the centre to the edge of the radius, named
 * rather than supplied. Resolved through `falloffAt` in `blast.ts`.
 *
 * A CLOSED union, unlike `Weapon` and `Entity.kind`: an unknown tile id or
 * weapon name degrades into "nothing special happens", whereas an unknown curve
 * has no sane fallback — silently substituting `linear` would retune every row
 * that misspelled it and report nothing.
 */
export type FalloffCurve = 'linear' | 'constant' | 'quadratic'

/**
 * How a projectile gets from the launcher to the aim point.
 *
 * `ballistic` ARCS OVER TERRAIN and is not clamped by cover at all — throwing
 * over a wall is the entire reason a grenade exists, and a wall check in flight
 * would turn every grenade into a short-range rocket. `flat` travels a straight
 * line at a constant speed and stops at the near face of the first solid tile.
 */
export type OrdnanceArc = 'ballistic' | 'flat'

/** One ordnance type's complete tuning. Nothing about *who* is carrying it. */
export interface OrdnanceSpec {
  /** The identifier `ExplosionEvent.ordnance` carries, and the table's own key. */
  readonly name: string

  /** See `OrdnanceArc`. Ballistic clears cover; flat is stopped by it. */
  readonly arc: OrdnanceArc

  /**
   * Travel speed in TILES PER TICK. At 60 Hz, 0.2 is twelve tiles a second.
   *
   * It decides flight time and nothing else — `T = ceil(distance / speed)` — so
   * lowering it gives the enemy time to walk out of the blast, which is what
   * makes a slow mortar a different weapon from a fast one rather than the same
   * weapon with a different animation.
   */
  readonly speedTilesPerTick: number

  /**
   * Ticks after launch at which the round goes off wherever it happens to be,
   * even in mid-air.
   *
   * A DEADLINE, NOT A DURATION. A round that arrives first detonates on impact;
   * this is only what happens when it does not. Cut it below a weapon's typical
   * flight time and you have built an airburst — a real and useful outcome, and
   * one the system reports at the height it actually occurred rather than
   * teleporting to the ground.
   */
  readonly fuseTicks: number

  /**
   * Blast radius in tiles. `TILE_WORLD_SIZE` is 1, so this is also world units.
   *
   * THE NUMBER PLAYERS ACTUALLY FEEL, because it decides how much aiming error
   * a throw forgives — and, with `damagesFriendlies`, how close your own squad
   * can stand. Nothing at or beyond it takes anything at all.
   */
  readonly blastRadiusTiles: number

  /**
   * Damage at the exact centre, before falloff. `INFANTRY_HEALTH` is 1, so any
   * value above 1 kills a soldier outright at the centre and the interesting
   * question is how far out it stays above 1 under the declared curve.
   */
  readonly peakDamage: number

  /** Which curve carries `peakDamage` out to the edge. See `FalloffCurve`. */
  readonly falloff: FalloffCurve

  /**
   * Ticks a unit must wait between launches, enforced by `launch`.
   *
   * THE ONLY THING STOPPING A BARRAGE. Ammunition is ticket 016's; until it
   * lands this is the sole limit on how often a man can throw, and an
   * unenforced field would be a lie the HUD then repeats.
   */
  readonly cooldownTicks: number

  /**
   * Rounds consumed per launch. DECLARED HERE, SPENT IN TICKET 016, which owns
   * selection and finite ammo. Stated now because a later table loaded from
   * level data must not need a schema change to gain the field.
   */
  readonly ammoCost: number

  /**
   * Whether the blast damages the launcher's own team, including the launcher.
   *
   * FRIENDLY FIRE BECOMES REACHABLE HERE. `combat/system.ts` notes that the
   * rifle can never produce it, because target selection never picks your own
   * side; a blast does not select anybody. `true` is the faithful, dangerous
   * setting and is what makes standing behind the thrower matter.
   */
  readonly damagesFriendlies: boolean
}

/**
 * Downward acceleration applied to a `ballistic` arc, in TILES PER TICK SQUARED.
 *
 * NOT PHYSICS — SILHOUETTE. It is the only thing deciding how high a throw
 * climbs: apex is `g * T^2 / 8`, so at the grenade's speed a six-tile throw
 * (T = 30) peaks about two tiles up. RAISE IT and throws become steep lobs that
 * hang and are easy to walk out of; LOWER IT and a grenade skims the ground and
 * stops reading as a thrown object at all. It does not change where anything
 * lands — the arc is solved to return to zero height at the aim point whatever
 * this is — so it is purely how the throw looks and how long it is airborne
 * above head height.
 *
 * Lives on the tuning surface rather than in `ballistics.ts` for the reason the
 * header gives: `ballistics.ts` is mechanism and holds no constants.
 */
export const GRAVITY_TILES_PER_TICK_SQUARED = 0.02

/**
 * Every ordnance type the game ships with, keyed by `OrdnanceSpec.name`.
 *
 * A plain object rather than a `Map`, exactly as `WEAPONS` is: iteration order
 * over string keys is insertion order and therefore stable, whereas a `Map`
 * invites callers to assume an ordering the determinism guarantee never made.
 *
 * THE SYSTEM DOES NOT READ THIS DIRECTLY. `createOrdnanceSystem(grid, { table })`
 * takes the table as an option and defaults to this, so a caller can fly a row
 * that does not appear here — which is the only honest way to test the claim
 * that adding ordnance is adding a row. See `__tests__/extensibility.test.ts`.
 */
export const ORDNANCE: Readonly<Record<string, OrdnanceSpec>> = {
  grenade: {
    name: 'grenade',
    // Thrown, so it clears the canopy and the low walls the levels are built
    // from. This is the whole point of the arc distinction.
    arc: 'ballistic',
    // Twelve tiles a second. A six-tile throw is half a second in the air —
    // long enough to see coming and short enough to be worth throwing.
    speedTilesPerTick: 0.2,
    // Two seconds, comfortably longer than any throw inside the rifle's range,
    // so a grenade normally detonates on impact and the fuse is the safety net.
    fuseTicks: 120,
    // Generous enough to forgive a tile of aiming error, tight enough that a
    // squad in loose formation does not lose three men to one careless throw.
    blastRadiusTiles: 2.5,
    // Four times `INFANTRY_HEALTH`, so under the linear curve the lethal circle
    // is the inner three quarters of the radius and the fringe wounds vehicles
    // rather than killing men outright.
    peakDamage: 4,
    falloff: 'linear',
    // A second and a half. Slower than the rifle by design: a grenade that
    // could be thrown at rifle cadence replaces the rifle.
    cooldownTicks: 90,
    ammoCost: 1,
    // The dangerous setting, and the faithful one. See `damagesFriendlies`.
    damagesFriendlies: true,
  },
  rocket: {
    name: 'rocket',
    // Direct fire: it hits the wall it was aimed through rather than arcing
    // over it, which is what makes it the answer to a bunker and not to a
    // trench.
    arc: 'flat',
    // Thirty tiles a second — fast enough to read as a rocket rather than a
    // thrown thing, and to arrive before the target can step aside.
    speedTilesPerTick: 0.5,
    fuseTicks: 180,
    /**
     * WIDER THAN THE GRENADE, WHICH IT WAS NOT UNTIL TICKET 071.
     *
     * The old row read radius 2 with peak 6, and the sentence that used to sit
     * here called it "tighter than the grenade: it is aimed, not lobbed". That
     * reasoning was about AIMING FORGIVENESS and quietly decided the KILL ZONE
     * as well — two different things that `blastRadiusTiles` happens to control
     * together. Measured, it made the heavier, slower, scarcer weapon clear FIVE
     * squares against the grenade's NINE: the thing you can throw every second
     * and a half killed more ground than the thing you carry two of.
     *
     * RADIUS IS NOT KILL ZONE, AND THE GAP IS BIGGER HERE THAN ANYWHERE. A man
     * dies where damage falls below `INFANTRY_HEALTH`, not where it reaches
     * zero, and a quadratic curve crosses that line early: the lethal radius is
     * `blastRadiusTiles * (1 - sqrt(INFANTRY_HEALTH / peakDamage))`, which for
     * these numbers is 4 * (1 - sqrt(1/12)) = 2.845 tiles. That is just past a
     * 5x5 block's corner at sqrt(8) = 2.828 and comfortably short of the next
     * ring at 3.0 — so the rocket kills exactly twenty-five squares.
     *
     * `kill-zone.test.ts` COUNTS THE BODIES rather than trusting that
     * arithmetic, and re-derives it from this row so the two cannot drift.
     */
    blastRadiusTiles: 4,
    /**
     * TWELVE, UP FROM SIX, AND IT IS THE RADIUS'S PARTNER RATHER THAN A SEPARATE
     * BUFF. Quadratic falloff collapses fast — at half the radius it is already
     * down to a quarter strength — so a lethal radius of 2.85 out of a 4-tile
     * blast is unreachable at peak 6 whatever the radius: pushing the radius out
     * far enough would give the rocket a wounding fringe most of a screen wide.
     * Raising the peak is what keeps the taper to 4 tiles.
     *
     * It also reads correctly: a rocket should hit harder at the point of impact
     * than a thrown grenade, and now does — 12 against 4.
     */
    peakDamage: 12,
    /**
     * STILL QUADRATIC, and the reason has changed. It used to be here to make
     * the rocket's killing "concentrated at the point of impact" — which is no
     * longer true, and was the whole of the inversion above. What the curve buys
     * now is the SHAPE OF THE FRINGE: past the kill zone the rocket's damage
     * drops away far faster than a linear curve would, so the twenty tiles of
     * ring around the 5x5 are scratched rather than nearly killed. It is also
     * what the vehicles extension point would feel, a tougher entity being the
     * only thing on the field that can survive inside the lethal radius and
     * therefore the only thing that can tell two curves apart.
     */
    falloff: 'quadratic',
    cooldownTicks: 150,
    ammoCost: 1,
    damagesFriendlies: true,
  },
}
