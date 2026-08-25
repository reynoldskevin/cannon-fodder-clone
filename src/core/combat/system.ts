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
 * stable), scored on squared distance, and ties are broken on the lower entity
 * id. No `Set`/`Map` iteration order, no `rng` draw, no float comparison whose
 * result depends on traversal direction.
 */

import { clearFractionAlong, hasLineOfSight } from './los'
import { applyDamage, createCooldowns, inRange, markFired, readyToFire } from './resolution'
import { AIM_TOLERANCE_TILES, weaponForKind } from './weapons'
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
}

/** Both teams, which is what `autoEngageTeams` defaults to. See `CombatOptions`. */
const ALL_TEAMS: readonly Team[] = ['player', 'enemy']

/**
 * A standing fire order: the aim point, in both spaces it is needed in.
 *
 * Mutated in place when the order is re-issued rather than replaced, so holding
 * the button and dragging leaves the order table's entries alone however many
 * units are selected. (`orderFire` still allocates the one `WorldPoint` that
 * `tileToWorld` returns, per call and not per unit.)
 */
interface FireOrder {
  /** Corner-indexed tile coordinates — the space `hasLineOfSight` walks. */
  tileX: number
  tileY: number
  /** The same point in world units, which is the ray the round is fired along. */
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
  const cooldowns = createCooldowns()

  /**
   * The level's extent, so aim points can be converted with the shared
   * `tileToWorld` rather than a second copy of its arithmetic. The grid is baked
   * from the level, so it always agrees with it.
   */
  const levelSize = { w: grid.w, h: grid.h }

  /**
   * `AIM_TOLERANCE_TILES` in WORLD units, squared, so the check against it is a
   * comparison of the squared distances `pickTarget` already computes.
   */
  const aimToleranceSq = (AIM_TOLERANCE_TILES * TILE_WORLD_SIZE) ** 2

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
   */
  const committed = new Map<number, number>()

  /**
   * The best target for `shooter`, or `null`.
   *
   * NEAREST VISIBLE ENEMY. Nearest because it is both the most immediate threat
   * and the shot most likely to connect, and because any cleverer rule (weakest,
   * most dangerous) reads as psychic to a player who cannot see the numbers it
   * is reasoning about.
   *
   * The LOS raycast is done LAST, after team, range and the distance comparison
   * have all been passed. It walks a tile at a time and is by far the most
   * expensive test here; almost every candidate is eliminated by a subtraction
   * and a multiply instead.
   */
  function pickTarget(
    world: World,
    shooter: Entity,
    spec: WeaponSpec,
    /**
     * The point candidates are ranked by nearness to, in world units, and how
     * far from it a candidate may be at all.
     *
     * An auto-engaging unit ranks from ITS OWN position with no limit — the
     * nearest visible enemy, which is ticket 011's rule unchanged. A commanded
     * one ranks from the AIM POINT within `AIM_TOLERANCE_TILES`, because
     * right-clicking one man in a crowd must shoot the man pointed at rather
     * than whoever happens to stand closest to the shooter.
     */
    fromX: number,
    fromZ: number,
    toleranceSq: number,
  ): Entity | null {
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
      // Target selection never picks your own team.
      //
      // Which means FRIENDLY FIRE IS UNREACHABLE FROM GAMEPLAY AS SHIPPED, and
      // saying so is worth more than implying otherwise: the rifle is hitscan
      // and damages only the entity it was aimed at, so a round whose line
      // happens to cross a friendly harms nobody. `applyDamage` nonetheless
      // detects and attributes it correctly (see `resolution.ts`), which is what
      // the acceptance tests exercise directly. It becomes reachable the moment
      // ordnance lands in ticket 015 — a grenade damages everything in a radius
      // and does not ask whose side they are on.
      if (candidate.team === shooter.team) continue
      // Already dead as far as this tick is concerned — see `committed`.
      if ((committed.get(candidate.id) ?? 0) >= candidate.health) continue
      if (!inRange(shooter.x, shooter.z, candidate.x, candidate.z, rangeWorld)) continue

      const dx = candidate.x - fromX
      const dz = candidate.z - fromZ
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > toleranceSq) continue
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
   * Give a standing fire order. See `CombatSystem.orderFire`.
   *
   * The aim point is converted to both spaces once, here, rather than on every
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
        existing.tileX = worldToTileAxis(point.x, grid.w)
        existing.tileY = worldToTileAxis(point.z, grid.h)
        existing.worldX = point.x
        existing.worldZ = point.z
        continue
      }
      orders.set(id, {
        tileX: worldToTileAxis(point.x, grid.w),
        tileY: worldToTileAxis(point.z, grid.h),
        worldX: point.x,
        worldZ: point.z,
      })
    }
  }

  function ceaseFire(unitIds: readonly number[]): void {
    for (const id of unitIds) orders.delete(id)
  }

  const isFiring = (unitId: number): boolean => orders.has(unitId)

  function combatSystem(world: World): void {
    attached = world
    const tick = world.tickCount

    // Bury the orders of the dead. An id is never reused, so a leaked order
    // could never be inherited by a live unit — but it would keep `isFiring`
    // answering true about a man who is gone, and the table would grow by one
    // per casualty for the length of the mission.
    if (orders.size > 0) {
      for (const id of [...orders.keys()]) {
        if (!world.isAlive(id)) orders.delete(id)
      }
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
        target = pickTarget(world, shooter, spec, shooter.x, shooter.z, Number.POSITIVE_INFINITY)
        if (target === null) return
        aimX = target.x
        aimZ = target.z
      } else {
        // A COMMANDED SHOT ALWAYS LEAVES THE RIFLE, subject only to the cooldown
        // above. What is clamped is its ENDPOINT.
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
        // face of whatever it meets first. Aiming past the reach fires short;
        // aiming at or through cover fires into the cover. Neither is silence,
        // and neither draws the eighteen-tile tracer. The clamp is measured from
        // the shooter's TILE CENTRE, so it is accurate to under a tile rather
        // than exact — see the note on the cover clamp below for the bound.
        //
        // TARGET SELECTION IS UNTOUCHED BY ANY OF THIS. A man is hit only if he
        // is in range, in sight, and inside `AIM_TOLERANCE_TILES` of the AIM
        // point — the clamp decides only what `ShotFired` REPORTS, which is what
        // FX draws. A shot that found a target needs no clamp at all: passing
        // those three tests is what makes the target's own position reachable.
        target = pickTarget(world, shooter, spec, order.worldX, order.worldZ, aimToleranceSq)
        if (target !== null) {
          aimX = target.x
          aimZ = target.z
        } else {
          const dx = order.worldX - shooter.x
          const dz = order.worldZ - shooter.z
          const distance = Math.hypot(dx, dz)
          // The whole way to the aim point unless something below shortens it.
          // A zero-length ray — ordered onto his own tile — skips the clamping
          // entirely: there is no direction to clamp along, and scaling nothing
          // by anything is still the muzzle.
          let reach = 1
          if (distance > 0) {
            const rangeWorld = spec.rangeTiles * TILE_WORLD_SIZE
            if (distance > rangeWorld) reach = rangeWorld / distance
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
            const clear = clearFractionAlong(
              grid,
              { x: sx, y: sz },
              { x: order.tileX, y: order.tileY },
              sightMask,
            )
            if (clear < reach) reach = clear
          }
          aimX = shooter.x + dx * reach
          aimZ = shooter.z + dz * reach
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
      // `ShotFired` BEFORE the death it causes: FX plays the muzzle flash and
      // the tracer from this event and the fall from `UnitDied`. Reversed, the
      // soldier drops before the shot is fired. Both endpoints ride on the
      // event so FX never has to look up an entity that may already be gone.
      world.emit({
        type: 'ShotFired',
        shooterId: shot.shooterId,
        targetId: shot.targetId,
        weapon: shot.spec.name,
        originX: shot.originX,
        originZ: shot.originZ,
        targetX: shot.targetX,
        targetZ: shot.targetZ,
      })
      // Hitscan: the round lands the tick it is fired. Travel time is an FX
      // concern — the tracer is interpolated between the endpoints above — not a
      // sim one. A projectile entity would add a second thing that can be
      // orphaned mid-flight for no change in outcome. `applyDamage` is a no-op
      // against a target an earlier round in this volley already killed, so
      // concentrated fire cannot produce two deaths from one soldier.
      //
      // A null target is suppressing fire: the round was aimed at a position,
      // and there is nothing there to damage.
      if (shot.targetId !== null) {
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

  return Object.assign(combatSystem, { orderFire, ceaseFire, isFiring })
}
