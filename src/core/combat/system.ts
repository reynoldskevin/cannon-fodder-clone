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

import { hasLineOfSight } from './los'
import { applyDamage, createCooldowns, inRange, markFired, readyToFire } from './resolution'
import { weaponForKind } from './weapons'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE } from '../view/projection'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { Entity, SimSystem, World } from '../world/world'
import type { WeaponSpec } from './weapons'

/** Knobs that are structural rather than balance. Feel lives in `weapons.ts`. */
export interface CombatOptions {
  /**
   * The traversal class sightlines are tested against. Infantry by default,
   * because that is what the game spawns; a turret with a raised firing position
   * would pass a different mask rather than a different grid.
   */
  readonly sightMask?: TraversalMask
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
  targetId: number
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
export function createCombatSystem(grid: NavGrid, options: CombatOptions = {}): SimSystem {
  const sightMask = options.sightMask ?? INFANTRY
  const cooldowns = createCooldowns()

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
  function pickTarget(world: World, shooter: Entity, spec: WeaponSpec): Entity | null {
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

  return function combatSystem(world: World): void {
    const tick = world.tickCount

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
      const target = pickTarget(world, shooter, spec)
      if (target === null) return

      const slot = decided[decidedCount]
      if (slot === undefined) {
        decided.push({
          shooterId: shooter.id,
          targetId: target.id,
          spec,
          originX: shooter.x,
          originZ: shooter.z,
          targetX: target.x,
          targetZ: target.z,
        })
      } else {
        slot.shooterId = shooter.id
        slot.targetId = target.id
        slot.spec = spec
        slot.originX = shooter.x
        slot.originZ = shooter.z
        slot.targetX = target.x
        slot.targetZ = target.z
      }
      decidedCount += 1
      committed.set(target.id, (committed.get(target.id) ?? 0) + spec.damage)
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
      applyDamage(world, shot.targetId, shot.spec.damage, shot.shooterId)
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
}
