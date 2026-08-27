/**
 * The combat system (ticket 011): one pass per tick that decides who shoots
 * whom, and kills what the rounds hit.
 *
 * TWO PASSES, AND BOTH REASONS MATTER.
 *
 *   1. CORRECTNESS. `World.despawn` compacts the live array that `world.entities`
 *      hands out, so removing an entity from inside `for (const e of
 *      world.entities)` skips whichever entity slides into the vacated slot —
 *      silently, deterministically, and therefore invisibly to every determinism
 *      test. Ticket 005 documents this at length on the `entities` getter. The
 *      decision pass here never mutates, so there is nothing to skip.
 *   2. SIMULTANEITY. Every shot this tick is aimed at the SAME snapshot of the
 *      world. Two soldiers who see each other and are both off cooldown kill
 *      each other, exactly as in the original — rather than whichever holds the
 *      lower entity id winning every mutual ambush in the game because he was
 *      iterated first. Once a shot is decided the round is in the air: a shooter
 *      killed by an earlier round in the same volley does not get to recall it,
 *      which is why pass 2 needs no lookup of the shooter at all.
 *
 * DETERMINISM. Target choice is a pure function of world state: candidates are
 * scanned in `world.entities` order (spawn order, which ticket 005 guarantees is
 * stable), scored on a distance — squared, from the shooter, when he engages on
 * his own initiative; along the line of fire when he was commanded (011c) — and
 * ties are broken on the lower entity id. No `Set`/`Map` iteration order, no
 * `rng` draw, no float comparison whose result depends on traversal direction.
 */

import { clearFractionAlong, hasLineOfSight } from './los'
import {
  applyDamage,
  createCooldowns,
  hitChanceAt,
  inRange,
  markFired,
  readyToFire,
} from './resolution'
import { AIM_CORRIDOR_TILES, weaponForKind } from './weapons'
import { canFireFromTerrain } from '../level/terrain'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE, tileToWorld } from '../view/projection'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { TileCoord } from '../view/projection'
import type { Entity, SimSystem, Team, World } from '../world/world'
import type { WeaponSpec } from './weapons'

/** Knobs that are structural rather than balance. Feel lives in `weapons.ts`. */
export interface CombatOptions {
  /**
   * The traversal class sightlines are tested against. Infantry by default,
   * because that is what the game spawns; a turret with a raised firing position
   * would pass a different mask rather than a different grid.
   */
  readonly sightMask?: TraversalMask
  /**
   * The teams that engage anything in reach without being told (ticket 011a).
   *
   * BOTH TEAMS BY DEFAULT, which is exactly ticket 011's behaviour: every unit
   * auto-engages unless a caller says otherwise. The session is what opts the
   * player out, so a default that quietly changed would be a second, invisible
   * edit to a merged ticket rather than a decision anybody made.
   *
   * A unit on a team outside this list fires only while it holds a standing
   * order from `orderFire`.
   */
  readonly autoEngageTeams?: readonly Team[]
  /**
   * How a hit is decided (ticket 011b).
   *
   * `'certain'` IS THE DEFAULT, and that is what makes accuracy one ticket
   * rather than a rewrite of the suite. Twenty-three test files and a hundred
   * and thirty-odd assertion sites were written against a round that lands:
   * range and line of sight decide, and the shot connects. Under `'certain'` no
   * draw is taken from `world.rng` AT ALL — not "almost always hits", the same
   * code path as before this option existed — so a test that asserts a death, a
   * health drop or a shot count behaves exactly as it did.
   *
   * `'weapon'` reads `WeaponSpec.accuracy` and rolls. `createSession` passes it,
   * the way it already passes `autoEngageTeams: []` over this file's both-teams
   * default and for the same reason: ticket 011's contract is untouched, and the
   * session is what changes its mind about the game it is running.
   *
   * THIS IS NOT A FLAG TO BE REMOVED LATER. It is the seam that lets a combat
   * test say "a round that reaches him kills him" without also asserting a dice
   * roll, which is a different claim and has its own tests.
   */
  readonly hitPolicy?: 'certain' | 'weapon'
}

/**
 * The per-tick combat pass, with the fire-order API attached.
 *
 * A callable object rather than two separate things, exactly like `SquadSystem`:
 * it is registered with `world.addSystem`, which wants a plain `SimSystem`, and
 * the command layer needs somewhere to send fire orders. Splitting them would
 * mean handing callers two halves of one piece of state and trusting them to
 * keep the pair together.
 */
export interface CombatSystem extends SimSystem {
  /**
   * Put these units on a standing order to fire at a TILE. Ids naming nothing
   * living are ignored; re-issuing replaces the aim point and touches no
   * cooldown, so dragging the pointer is not a rapid-fire exploit.
   *
   * The order stands until `ceaseFire` or the unit's death — a move order does
   * NOT clear it, because advancing while firing is the whole point.
   */
  orderFire(unitIds: readonly number[], target: TileCoord): void
  /** Take these units off their standing order. Unknown ids are ignored. */
  ceaseFire(unitIds: readonly number[]): void
  /** Whether this unit currently holds a standing fire order. */
  isFiring(unitId: number): boolean
  /**
   * The world-space point this unit's standing order is aimed at, or `undefined`
   * when it holds none (ticket 025a).
   *
   * EXPOSED RATHER THAN RECOMPUTED, and that is the whole reason it exists. The
   * renderer has to turn a firing soldier toward the point he is shooting at,
   * and it must be the point THIS SYSTEM is actually firing along. Deriving a
   * second answer from the pointer, or from the nearest enemy, is the
   * dual-source mistake ticket 012 spent a design section avoiding: two rules
   * agree until they don't, and when they diverge the man faces one way while
   * his rounds go another — which reads as a targeting bug and is really a
   * bookkeeping one. The same shape, for the same reason, as `AiSystem.targetOf`.
   *
   * It is the AIM, not the victim. The aim point is a DIRECTION (ticket 011c):
   * the round runs down that line to the weapon's full reach and hits the first
   * man on it, who may be nowhere near the click, so the two are routinely
   * several tiles apart and the shooter should face where the PLAYER pointed.
   *
   * A READ, AND ONLY A READ. Nothing about how a shot is aimed, chosen or
   * resolved changes because somebody asked this.
   */
  aimOf(unitId: number): { x: number; z: number } | undefined
}

/** Both teams, which is what `autoEngageTeams` defaults to. See `CombatOptions`. */
const ALL_TEAMS: readonly Team[] = ['player', 'enemy']

/**
 * A standing fire order: the point the player pointed at, in world units.
 *
 * WORLD UNITS AND NOTHING ELSE. It also carried the same point in TILE space
 * until ticket 011c, for the cover clamp to walk the grid to — but the clamp now
 * walks to the far end of the weapon's RANGE along this direction rather than to
 * the aim point itself, so that copy had become a second, unused answer that the
 * next reader would have had to check for agreement with the first.
 *
 * Mutated in place when the order is re-issued rather than replaced, so holding
 * the button and dragging leaves the order table's entries alone however many
 * units are selected. (`orderFire` still allocates the one `WorldPoint` that
 * `tileToWorld` returns, per call and not per unit.)
 */
interface FireOrder {
  worldX: number
  worldZ: number
}

/**
 * A shot decided in pass 1 and resolved in pass 2.
 *
 * Carries the endpoints by VALUE rather than by entity reference, for the
 * simultaneity reason above: by the time it resolves, either end may be gone,
 * and `ShotFired` must still report where the round came from and where it went.
 */
interface DecidedShot {
  shooterId: number
  /** `null` for a commanded shot that found nothing to hit — suppressing fire. */
  targetId: number | null
  spec: WeaponSpec
  originX: number
  originZ: number
  targetX: number
  targetZ: number
}

/**
 * Convert a world-space ground coordinate to a continuous TILE coordinate.
 *
 * The two spaces share a scale (`TILE_WORLD_SIZE` is 1) but NOT an origin: a
 * level is centred on the world origin, so world x = tile x - (n - 1) / 2. The
 * `+ n / 2` here is that inverse composed with `hasLineOfSight`'s flooring
 * convention — `floor(w + n / 2)` is `round(w + (n - 1) / 2)`, which is exactly
 * the tile `worldToTile` names.
 *
 * Not `worldToTile` itself, deliberately: that function CLAMPS to the grid,
 * which is right for pointer picking (you want the nearest legal tile) and wrong
 * here — a unit that has left the map would be teleported onto the edge and
 * handed a sightline it does not have. Unclamped, off-map falls out as an
 * off-map tile index, which `NavGrid.passable` already rejects.
 */
const worldToTileAxis = (world: number, tiles: number): number =>
  world / TILE_WORLD_SIZE + tiles / 2

/**
 * Build the per-tick combat pass over `grid`.
 *
 * A factory rather than a bare `SimSystem` because the cooldown table lives for
 * the whole mission and belongs to ONE world. Module-level mutable state here
 * would let two worlds share rate-of-fire bookkeeping, which is the determinism
 * failure that is hardest to reproduce: it depends on which test ran first.
 */
export function createCombatSystem(grid: NavGrid, options: CombatOptions = {}): CombatSystem {
  const sightMask = options.sightMask ?? INFANTRY
  const autoEngageTeams = options.autoEngageTeams ?? ALL_TEAMS
  const hitPolicy = options.hitPolicy ?? 'certain'
  const cooldowns = createCooldowns()

  /**
   * The level's extent, so aim points can be converted with the shared
   * `tileToWorld` rather than a second copy of its arithmetic. The grid is baked
   * from the level, so it always agrees with it.
   */
  const levelSize = { w: grid.w, h: grid.h }

  /**
   * `AIM_CORRIDOR_TILES` in WORLD units, squared, so the corridor test is a
   * comparison against a squared perpendicular distance and costs no `sqrt`.
   */
  const aimCorridorSq = (AIM_CORRIDOR_TILES * TILE_WORLD_SIZE) ** 2

  /**
   * Standing fire orders, by unit id.
   *
   * Read by keyed lookup in the decision pass, so its iteration order cannot
   * reach a simulation result. It IS iterated once a tick to bury orders whose
   * owner has died, which only ever deletes entries and therefore decides
   * nothing.
   */
  const orders = new Map<number, FireOrder>()

  /**
   * The world this system was last ticked with, or `null` before its first tick.
   *
   * `orderFire` uses it to drop ids that name nothing living, exactly as
   * `SquadSystem.order` does and for the same reason: the system is handed a
   * grid, not a world, so an order given before the very first tick is accepted
   * as written and swept on the tick that follows it.
   */
  let attached: World | null = null

  /**
   * The decision buffer, reused across ticks and never shrunk.
   *
   * This runs 60 times a second for the length of a mission, so a fresh array of
   * decision objects per tick is precisely the steady-state garbage ticket 005's
   * tick contract rules out. It settles at the largest volley the mission ever
   * fired, which is bounded by the entity count.
   */
  const decided: DecidedShot[] = []
  let decidedCount = 0

  /**
   * FIRE DISCIPLINE: damage already committed to each target THIS TICK.
   *
   * Without it, a squad that all sees the same nearest enemy puts its whole
   * volley into one man — five of the six rounds land on a corpse, the other
   * five enemies are untouched, and everybody sits on cooldown for half a
   * second having achieved one kill. That is not a rounding error in the feel,
   * it is the difference between a squad and a mob.
   *
   * A soldier therefore skips a candidate that this tick's decisions have
   * already committed enough damage to kill, and takes the next nearest. It is
   * bookkeeping, not omniscience: the shooter is reacting to his own side's
   * fire, which is what "check your target" means.
   *
   * One `Map`, cleared each tick rather than reallocated. It is read by id
   * lookup and never iterated, so its iteration order — the one thing about a
   * `Map` that determinism cannot rely on — never influences a decision.
   *
   * IT STILL ASSUMES EVERY ROUND LANDS, AND THAT IS DELIBERATE (ticket 011b).
   * The accuracy roll happens in pass 2, so this is a RECORD of what was aimed
   * rather than a PREDICTION of what will connect: a volley aimed at one soldier
   * may spread as though he were already dead, and then miss. That reads as a
   * squad that concentrated sensibly and got unlucky, which is the thing
   * accuracy exists to make possible. Do not "fix" it by rolling here — see the
   * pass 2 comment for what rolling in pass 1 would cost.
   */
  const committed = new Map<number, number>()

  /**
   * Whether `candidate` is a thing `shooter` is willing to shoot at all.
   *
   * Shared by both selection rules below so the two can never drift on WHO is a
   * legal target while differing — as they must — on WHICH of them is chosen.
   *
   * TARGET SELECTION NEVER PICKS YOUR OWN TEAM.
   *
   * Which means FRIENDLY FIRE IS UNREACHABLE FROM GAMEPLAY AS SHIPPED, and
   * saying so is worth more than implying otherwise: the rifle is hitscan and
   * damages only the entity it was aimed at, so a round whose line happens to
   * cross a friendly harms nobody — including now, when the round has a line and
   * a friendly may be standing squarely on it. `applyDamage` nonetheless detects
   * and attributes friendly fire correctly (see `resolution.ts`), which is what
   * the acceptance tests exercise directly. It becomes reachable the moment
   * ordnance lands in ticket 015 — a grenade damages everything in a radius and
   * does not ask whose side they are on.
   *
   * MAKING THE ROUND HIT THE FIRST *ANYBODY* IS OUT OF SCOPE, AND DELIBERATELY
   * SO (ticket 011c). It is defensible and faithful to the original, but it is a
   * change to how the game PLAYS — every enemy volley would become a hazard to
   * the enemy line too — rather than to how it is AIMED, which is all 011c is.
   */
  function engageable(shooter: Entity, candidate: Entity): boolean {
    if (candidate.team === shooter.team) return false
    // Already dead as far as this tick is concerned — see `committed`.
    if ((committed.get(candidate.id) ?? 0) >= candidate.health) return false
    return true
  }

  /**
   * The best target for a shooter engaging on his OWN INITIATIVE, or `null`.
   *
   * NEAREST VISIBLE ENEMY, MEASURED FROM THE SHOOTER. Nearest because it is both
   * the most immediate threat and the shot most likely to connect, and because
   * any cleverer rule (weakest, most dangerous) reads as psychic to a player who
   * cannot see the numbers it is reasoning about.
   *
   * TICKET 011'S RULE, UNCHANGED BY 011c. An auto-engaging unit has no aim point,
   * so there is no ray to rank anybody along; the corridor rule below applies to
   * commanded fire and to nothing else.
   *
   * The LOS raycast is done LAST, after team, range and the distance comparison
   * have all been passed. It walks a tile at a time and is by far the most
   * expensive test here; almost every candidate is eliminated by a subtraction
   * and a multiply instead.
   */
  function pickNearest(world: World, shooter: Entity, spec: WeaponSpec): Entity | null {
    const sx = worldToTileAxis(shooter.x, grid.w)
    const sz = worldToTileAxis(shooter.z, grid.h)
    // Maximum range converted from tiles to WORLD units here, at the one place
    // the two spaces meet. `inRange` is unit-agnostic on purpose, and today
    // `TILE_WORLD_SIZE` is 1 so this multiply changes nothing — but omitting it
    // would leave this the only place the scale factor is not applied while
    // `worldToTileAxis` does apply it. A later change to the tile size would
    // then keep sightlines correct and make maximum range silently wrong by
    // exactly that factor, which is the half-applied-constant bug.
    const rangeWorld = spec.rangeTiles * TILE_WORLD_SIZE
    let best: Entity | null = null
    let bestDistanceSq = 0
    const candidates = world.entities
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      if (!engageable(shooter, candidate)) continue
      if (!inRange(shooter.x, shooter.z, candidate.x, candidate.z, rangeWorld)) continue

      const dx = candidate.x - shooter.x
      const dz = candidate.z - shooter.z
      const distanceSq = dx * dx + dz * dz
      if (best !== null) {
        if (distanceSq > bestDistanceSq) continue
        // Equal range is common — a squad advancing abreast — and without an
        // explicit tie-break the winner would be whichever the scan reached
        // first, which is stable today only by accident of spawn order. Lower
        // id wins, which is a fact about the world rather than about the loop.
        if (distanceSq === bestDistanceSq && candidate.id >= best.id) continue
      }

      const tx = worldToTileAxis(candidate.x, grid.w)
      const tz = worldToTileAxis(candidate.z, grid.h)
      if (!hasLineOfSight(grid, { x: sx, y: sz }, { x: tx, y: tz }, sightMask)) continue

      best = candidate
      bestDistanceSq = distanceSq
    }
    return best
  }

  /**
   * The first man along a COMMANDED round's line of fire, or `null`.
   *
   * THE WHOLE OF TICKET 011c. Aiming supplies a DIRECTION, not a destination, so
   * candidates are ranked by how far DOWN THE RAY they stand and the smallest
   * wins. Before this, they were ranked by nearness to the aim POINT within a
   * two-tile disc, which meant a click into the gap between two enemies, or at
   * the ground behind one, hit nobody at all — while ticket 011a's tracer was
   * already being drawn the full length of this very ray. That was two answers
   * to one question; this removes the second one.
   *
   * A man qualifies when all three hold:
   *   - FORWARD of the muzzle (`along >= 0`). Projecting onto the infinite LINE
   *     rather than the forward RAY would let a man standing behind the shooter
   *     be "on it" — a soldier shooting over his own shoulder.
   *   - within `reachWorld` along the ray — see the caller for what shortens it.
   *   - within `AIM_CORRIDOR_TILES` PERPENDICULAR of the line. A mathematical
   *     ray has no width and would hit nothing.
   *
   * `direction` MUST BE A UNIT VECTOR: both the projection and the cross product
   * below are lengths only because it is, and a caller that passed the raw
   * aim-point delta would scale the corridor by the distance of the click —
   * silently making a far click forgiving and a near one impossible. The caller
   * normalises, and refuses the zero-length case rather than dividing by it.
   */
  function pickAlongRay(
    world: World,
    shooter: Entity,
    directionX: number,
    directionZ: number,
    reachWorld: number,
  ): Entity | null {
    const sx = worldToTileAxis(shooter.x, grid.w)
    const sz = worldToTileAxis(shooter.z, grid.h)
    let best: Entity | null = null
    let bestAlong = 0
    const candidates = world.entities
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      if (!engageable(shooter, candidate)) continue

      const dx = candidate.x - shooter.x
      const dz = candidate.z - shooter.z
      // Distance along the ray, which is BOTH the range test and the ranking.
      // The euclidean `inRange` that `pickNearest` uses is deliberately not
      // applied here: the round travels down the corridor, so what bounds it is
      // how far it has flown, not how far the man is off to one side.
      const along = dx * directionX + dz * directionZ
      if (along < 0 || along > reachWorld) continue
      // Perpendicular offset, as the 2-D cross product with a unit direction.
      // Squared so no `sqrt` is paid on a test run per candidate per commanded
      // shooter per tick.
      const across = dx * directionZ - dz * directionX
      if (across * across > aimCorridorSq) continue
      if (best !== null) {
        if (along > bestAlong) continue
        // Two men abreast of each other across the corridor are exactly as far
        // down the line as one another. LOWER ID WINS — the tie-break the rest
        // of the sim uses.
        //
        // NOTHING TODAY CAN TELL THIS FROM "whichever the scan reached first",
        // and claiming otherwise would be a fiction: ids are handed out
        // monotonically and `World.despawn` compacts in place preserving order,
        // so scan order IS id order and the two rules cannot disagree. Relaxing
        // this to `>=`, which resolves ties by scan position instead, leaves the
        // whole suite green. It is written out explicitly anyway, because that
        // agreement is a property of `world.entities` and not of this loop: the
        // day anything reorders that array — a spatial index, a sort, a pooled
        // slot reused out of order — the comparison is what keeps the answer the
        // id and not the array position.
        if (along === bestAlong && candidate.id >= best.id) continue
      }

      // LOAD-BEARING FOR "CAN THIS PARTICULAR MAN BE SEEN FROM THE MUZZLE", and
      // it is the only test that asks. A candidate stands up to a corridor's
      // half-width OFF the centre line, so his own sightline can be blocked by
      // cover that line misses entirely — delete this and a man tucked behind a
      // tree beside the line of fire becomes shootable through it.
      //
      // NOT REDUNDANT WITH THE CALLER'S `clearFractionAlong`, which asks the
      // other question — how far the ROUND gets before it meets cover — and is
      // what stops a man who has a clear diagonal sightline of his own from
      // being hit by a round that struck a wall three tiles short of him.
      //
      // Done LAST because it walks a tile at a time and is by far the most
      // expensive test here; almost every candidate is eliminated above by a
      // subtraction and a multiply instead.
      const tx = worldToTileAxis(candidate.x, grid.w)
      const tz = worldToTileAxis(candidate.z, grid.h)
      if (!hasLineOfSight(grid, { x: sx, y: sz }, { x: tx, y: tz }, sightMask)) continue

      best = candidate
      bestAlong = along
    }
    return best
  }

  /**
   * Give a standing fire order. See `CombatSystem.orderFire`.
   *
   * The aim point is converted to world units once, here, rather than on every
   * tick the order stands: an order is issued at pointer rate and read at tick
   * rate, and the conversion is the same answer every time.
   */
  function orderFire(unitIds: readonly number[], target: TileCoord): void {
    const point = tileToWorld(target.x, target.y, levelSize)
    for (const id of unitIds) {
      // Unknown and dead ids are dropped rather than throwing, for the reason
      // `SquadSystem.order` gives: the command layer is ordering a selection
      // that a round may have edited between the click and the order arriving.
      if (attached !== null && !attached.isAlive(id)) continue
      const existing = orders.get(id)
      if (existing !== undefined) {
        // Re-aimed in place. Nothing here touches the cooldown, which is what
        // stops dragging the pointer from becoming rapid fire.
        existing.worldX = point.x
        existing.worldZ = point.z
        continue
      }
      orders.set(id, { worldX: point.x, worldZ: point.z })
    }
  }

  function ceaseFire(unitIds: readonly number[]): void {
    for (const id of unitIds) orders.delete(id)
  }

  const isFiring = (unitId: number): boolean => orders.has(unitId)

  /**
   * See `CombatSystem.aimOf`.
   *
   * A fresh point per call rather than the live `FireOrder`, which is mutated in
   * place when the order is re-aimed: a caller holding the order itself would
   * watch its aim point change under it, and could write to it. It needs no
   * liveness check of its own — the tick sweep above deletes the orders of the
   * dead, so a despawned unit answers `undefined` from the next tick on.
   */
  function aimOf(unitId: number): { x: number; z: number } | undefined {
    const order = orders.get(unitId)
    if (order === undefined) return undefined
    return { x: order.worldX, z: order.worldZ }
  }

  function combatSystem(world: World): void {
    attached = world
    const tick = world.tickCount

    // Bury the orders of the dead. An id is never reused, so a leaked order
    // could never be inherited by a live unit — but it would keep `isFiring`
    // answering true about a man who is gone, and the table would grow by one
    // per casualty for the length of the mission.
    //
    // Walked LIVE, not over a copy of the keys. Deleting the entry a `Map`
    // iterator is standing on is defined behaviour — the walk continues from the
    // next entry — so the snapshot bought nothing but an array per tick, for
    // every tick in which anybody was under a standing order. Iterating a `Map`
    // is safe here at all only because this loop DELETES and decides nothing.
    for (const id of orders.keys()) {
      if (!world.isAlive(id)) orders.delete(id)
    }

    // ---- Pass 1: decide. Read-only; mutates nothing in the world. ----------
    decidedCount = 0
    committed.clear()
    // Live entities that could ever hold a cooldown entry. Counted here rather
    // than derived from `world.entityCount` — see the housekeeping note below.
    let armedCount = 0
    world.forEachEntity((shooter) => {
      const spec = weaponForKind(shooter.kind)
      // Unarmed kinds — vehicles, wreckage, anything not in `WEAPON_BY_KIND` —
      // can be shot at and killed but never shoot. Checked before the cooldown
      // so an unarmed entity never enters the cooldown table at all.
      if (spec === null) return
      armedCount += 1
      // A MAN IN THE WATER HOLDS HIS FIRE (ticket 007b), and this is the one
      // place that decides it. Every route to a trigger arrives here — the
      // player's standing order, the AI's `orderFire`, auto-engage — so the rule
      // is enforced once instead of in three places that would drift; and it
      // applies to both teams, which is the point: an enemy who wades in to
      // flank cannot shoot while he does it either.
      //
      // The question is about the SHOOTER'S OWN TILE and nothing else. Shooting
      // AT a swimmer is unaffected — being unable to shoot back is the whole
      // risk of crossing.
      //
      // BEFORE THE COOLDOWN CHECK, AND THAT IS LOAD-BEARING. Nothing here calls
      // `markFired`, so a man who holds fire for a four-second crossing spends
      // nothing and comes out of the river ready on the tick he lands. A gate
      // placed after `markFired` would make the rule a punishment rather than a
      // restriction.
      //
      // He returns with NO `ShotFired` AT ALL, rather than one with `hit: false`.
      // A miss is a round that was fired and went somewhere; this man never
      // pulled the trigger. An emitted miss would still draw a tracer, still
      // make a report and still be heard by every enemy in the alert radius — so
      // a man wading across would broadcast his position while doing no harm,
      // which is the opposite of what this rule is for.
      //
      // THE AI IS DELIBERATELY NOT TAUGHT THIS. A swimming enemy still enters
      // `engage` and still issues a fire order, and combat simply declines to
      // fire it: he is a man trying to shoot and failing, which is the honest
      // reading. If you find `core/ai` cheerfully ordering fire from the middle
      // of a river, that is this decision and not a bug — the alternative is a
      // fourth module with an opinion about water.
      //
      // `core/ordnance` NOW ENFORCES THE SAME RULE AT ITS OWN LAUNCH SEAM, and
      // this comment used to say the opposite on purpose. Ticket 007b argued
      // that a man could plausibly throw a grenade while wading, so the rifle
      // went quiet and the grenade did not. Ticket 041 reversed that on the
      // strength of how deep the man is now DRAWN — reasoned, not watched;
      // nobody has run this build. He is drawn
      // `view/submersion.ts`'s `SUBMERSION_FRACTION` — 70% — under the surface,
      // which is chest-deep in a current, and a man in that position with a
      // rifle he cannot fire is not lobbing anything either. It also read as a
      // bug rather than as two rules: one tile, one man, one button held, and
      // half of what he carries works.
      //
      // The gate is duplicated rather than shared because the two systems have
      // no seam in common — combat is handed a world and a grid here, ordnance
      // is handed a grid and attaches a world later — but both call the ONE
      // predicate, `canFireFromTerrain`, so the rule itself exists once.
      const shooterTile =
        world.level.terrain[Math.floor(worldToTileAxis(shooter.z, grid.h))]?.[
          Math.floor(worldToTileAxis(shooter.x, grid.w))
        ]
      // An off-map shooter reads as `undefined` and may fire — the neutral
      // answer, matching `canFireFromTerrain`'s own answer for a tile id this
      // build cannot name.
      if (shooterTile !== undefined && !canFireFromTerrain(shooterTile)) return
      if (!readyToFire(cooldowns, shooter.id, tick)) return

      const order = orders.get(shooter.id)
      let target: Entity | null
      // Where the round is reported as going. A shot that found a target goes to
      // the target; a commanded one that found none goes as far down the ordered
      // line as it can, which is what makes suppressing fire draw a tracer at
      // all. See the commanded branch below for what "as far as it can" means.
      let aimX: number
      let aimZ: number

      if (order === undefined) {
        // No standing order: only a team inside the auto-engage policy shoots.
        if (!autoEngageTeams.includes(shooter.team)) return
        target = pickNearest(world, shooter, spec)
        if (target === null) return
        aimX = target.x
        aimZ = target.z
      } else {
        // A COMMANDED SHOT ALWAYS LEAVES THE RIFLE, subject only to the cooldown
        // above. What the aim point decides is its DIRECTION; what bounds it is
        // the weapon's range and the first cover on that line.
        //
        // THE ALTERNATIVE WAS SILENCE, and it was wrong twice over. Refusing an
        // aim point with no clear line to it meant right-clicking a tree — the
        // most ordinary click there is on a jungle map — produced no shot, no
        // event and no sound, while `applyCommand` had already accepted the
        // order: the command layer said yes and the simulation quietly said no.
        // Firing regardless but reporting the aim point meant an eight-tile
        // rifle drawing an eighteen-tile tracer at a man it could not reach.
        //
        // So the round goes where a round could actually go: as far along the
        // line the player pointed as the weapon carries, stopping at the near
        // face of whatever it meets first. Aiming past the reach still fires
        // only the reach; aiming at or through cover fires into the cover.
        // Neither is silence, and neither draws the eighteen-tile tracer. The
        // clamp is measured from the shooter's TILE CENTRE, so it is accurate to
        // under a tile rather than exact — see the cover clamp below.
        //
        // TARGET SELECTION NOW COMES FROM THIS SAME RAY (ticket 011c), which is
        // the whole of that ticket. It used to come from a disc around the aim
        // POINT while the endpoint above came from the line — so the game drew
        // the right tracer and then damaged somebody chosen by a different rule,
        // and the two agreed only most of the time. One ray, one answer: the
        // reported endpoint is either the man the round stopped in or the point
        // it reached, and the tracer and the damage cannot disagree.
        const dx = order.worldX - shooter.x
        const dz = order.worldZ - shooter.z
        const distance = Math.hypot(dx, dz)
        if (distance === 0) {
          // ORDERED ONTO HIS OWN TILE: a zero-length aim is not a direction, so
          // there is no line to be on and nobody is hit. Guarded rather than
          // divided through, because `dx / 0` is the `NaN` that would fail every
          // comparison in `pickAlongRay` — which reads as "nobody is in the
          // corridor" only until somebody flips one of those comparisons round.
          // The round collapses to the muzzle, exactly as before 011c.
          target = null
          aimX = shooter.x
          aimZ = shooter.z
        } else {
          const directionX = dx / distance
          const directionZ = dz / distance
          // THE ROUND CARRIES ITS OWN RANGE, NOT THE DISTANCE TO THE CLICK
          // (ticket 011c). A click two tiles ahead fires the full eight; before
          // this, `reach` started at "the whole way to the aim point" and could
          // only be shortened, so a short click fired short and hit nothing that
          // stood past it. The distance of a click is not something anybody aims.
          const rangeWorld = spec.rangeTiles * TILE_WORLD_SIZE
          // Measured on the ray between TILE CENTRES, which is the same
          // flooring `hasLineOfSight` does and the only space the grid walk
          // exists in. A shooter standing off-centre therefore has his cover
          // sampled from the middle of his tile rather than from the muzzle —
          // an error under one tile, on a tracer, in the direction he is
          // already pointing. Solving it properly means a second raycast in
          // continuous space, which is a different module and buys a
          // difference nobody can see.
          const sx = worldToTileAxis(shooter.x, grid.w)
          const sz = worldToTileAxis(shooter.z, grid.h)
          // LOAD-BEARING FOR "HOW FAR DOES THE ROUND GET", and that is the only
          // question it answers. It stops the ray at the near face of the first
          // cover on it, and it is the SOLE answer for what `ShotFired` reports
          // — delete it and an eight-tile rifle draws its tracer straight
          // through a wall. Since 011c it bounds selection too, which is belt
          // and braces against the per-candidate `hasLineOfSight` for a man
          // squarely behind that wall, but not only that: a man off to one side
          // of the wall may have a clear sightline of his own, and this is what
          // says the round never got as far as him. Neither test replaces the
          // other — see the note in `pickAlongRay`.
          const clear = clearFractionAlong(
            grid,
            { x: sx, y: sz },
            {
              x: worldToTileAxis(shooter.x + directionX * rangeWorld, grid.w),
              y: worldToTileAxis(shooter.z + directionZ * rangeWorld, grid.h),
            },
            sightMask,
          )
          const reachWorld = rangeWorld * clear
          target = pickAlongRay(world, shooter, directionX, directionZ, reachWorld)
          if (target !== null) {
            // The man the round stopped in. A shot that found a target needs no
            // clamp at all: being inside the reach computed above is what put
            // him in the running.
            aimX = target.x
            aimZ = target.z
          } else {
            // Suppressing fire: as far along the line the player pointed as the
            // weapon carries, stopping at the near face of whatever it meets.
            aimX = shooter.x + directionX * reachWorld
            aimZ = shooter.z + directionZ * reachWorld
          }
        }
      }

      const slot = decided[decidedCount]
      if (slot === undefined) {
        decided.push({
          shooterId: shooter.id,
          targetId: target === null ? null : target.id,
          spec,
          originX: shooter.x,
          originZ: shooter.z,
          targetX: aimX,
          targetZ: aimZ,
        })
      } else {
        slot.shooterId = shooter.id
        slot.targetId = target === null ? null : target.id
        slot.spec = spec
        slot.originX = shooter.x
        slot.originZ = shooter.z
        slot.targetX = aimX
        slot.targetZ = aimZ
      }
      decidedCount += 1
      if (target !== null) {
        committed.set(target.id, (committed.get(target.id) ?? 0) + spec.damage)
      }
    })

    // ---- Pass 2: resolve. Every shot was aimed at the snapshot above. ------
    for (let i = 0; i < decidedCount; i += 1) {
      const shot = decided[i]
      if (shot === undefined) continue
      markFired(cooldowns, shot.shooterId, tick, shot.spec)
      /**
       * THE ACCURACY ROLL, AND IT BELONGS HERE RATHER THAN IN PASS 1 (011b).
       *
       * Pass 1 decides WHO IS AIMED AT. Roll there and the rng starts deciding
       * that too: a predicted miss would free the shooter to skip the man and
       * pick somebody else, and target selection would become a function of the
       * random stream — a far larger behavioural change than "the round
       * sometimes goes wide", and one that would make `committed` a prediction
       * instead of a record. Here, the target is already chosen and the only
       * question left is whether the round connects.
       *
       * THE DRAW IS SPENT ONLY ON A SHOT THAT IS ACTUALLY RESOLVED, never
       * speculatively and never per candidate considered. A draw taken on a tick
       * where nobody fired advances the stream and desynchronises every later
       * shot in the mission — invisible until two replays of one seed diverge
       * minutes apart. `decided` is filled in `world.forEachEntity` order, which
       * is spawn order with ties on the lower id, so the draws are ordered by a
       * fact about the world rather than by `Map` iteration.
       *
       * A suppressing round draws nothing: there is no target to hit or miss, so
       * there is no question to answer and no draw to spend answering it.
       */
      let hit = shot.targetId !== null
      if (hit && hitPolicy === 'weapon') {
        // Measured muzzle to victim. For a shot that found a target these are
        // the target's own coordinates (see pass 1), so this is the distance
        // `inRange` already admitted, converted to the tiles the curve is
        // expressed in.
        const dx = shot.targetX - shot.originX
        const dz = shot.targetZ - shot.originZ
        const distanceTiles = Math.hypot(dx, dz) / TILE_WORLD_SIZE
        hit = world.rng.next() < hitChanceAt(shot.spec, distanceTiles)
      }
      // `ShotFired` BEFORE the death it causes: FX plays the muzzle flash and
      // the tracer from this event and the fall from `UnitDied`. Reversed, the
      // soldier drops before the shot is fired. Both endpoints ride on the
      // event so FX never has to look up an entity that may already be gone.
      //
      // A MISS IS EMITTED TOO. The report, the tracer and every enemy's reaction
      // to being shot at hang off this event, so a miss that stayed silent would
      // be a soldier not shooting and a garrison that stopped investigating
      // gunfire the moment rounds started going wide.
      world.emit({
        type: 'ShotFired',
        shooterId: shot.shooterId,
        targetId: shot.targetId,
        weapon: shot.spec.name,
        originX: shot.originX,
        originZ: shot.originZ,
        targetX: shot.targetX,
        targetZ: shot.targetZ,
        hit,
      })
      // Hitscan: the round lands the tick it is fired. Travel time is an FX
      // concern — the tracer is interpolated between the endpoints above — not a
      // sim one. A projectile entity would add a second thing that can be
      // orphaned mid-flight for no change in outcome. `applyDamage` is a no-op
      // against a target an earlier round in this volley already killed, so
      // concentrated fire cannot produce two deaths from one soldier.
      //
      // A null target is suppressing fire: the round was aimed at a position,
      // and there is nothing there to damage. A missed round is the same story
      // told by the roll above — it left the rifle and went somewhere else.
      if (hit && shot.targetId !== null) {
        applyDamage(world, shot.targetId, shot.spec.damage, shot.shooterId)
      }
    }

    // ---- Housekeeping ------------------------------------------------------
    // Cooldown state is keyed by an id that is never reused, so an entry for a
    // dead soldier can never be reclaimed by a live one. Left untended the table
    // grows by one per soldier who ever fired and never shrinks, which over a
    // campaign is a leak.
    //
    // Compared against the ARMED count, not `world.entityCount`: only armed
    // units ever enter the table, so a thousand scenery props would otherwise
    // mask any number of dead shooters and the sweep would never run at all.
    //
    // BE HONEST ABOUT WHAT THIS GUARANTEES. It is a cheap trigger, not a proof
    // of cleanliness: a dead shooter's entry can still be masked by a live armed
    // unit that has not fired yet, and it then survives until the counts cross.
    // What it does bound is the size of the table — at most one entry per unit
    // that has ever fired, which is what makes the worst case a lingering entry
    // rather than unbounded growth. Exactness would cost a walk of the table
    // every tick to reclaim bytes nothing is waiting on.
    if (cooldowns.size > armedCount) {
      for (const id of [...cooldowns.readyAt.keys()]) {
        if (!world.isAlive(id)) cooldowns.forget(id)
      }
    }
  }

  return Object.assign(combatSystem, { orderFire, ceaseFire, isFiring, aimOf })
}
