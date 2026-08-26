/**
 * The ordnance system (ticket 015): one pass per tick that flies everything in
 * the air, detonates whatever has arrived or run out of fuse, and lands the
 * blast on the world.
 *
 * WHAT THIS OWNS that the two pure modules do not: the grid (so a rocket stops
 * at cover), the world (so a blast damages somebody), the tick (so a fuse can
 * expire), and the order in which all of it happens.
 *
 * PROJECTILES ARE NOT ENTITIES. A round in the air is this system's private
 * bookkeeping and never enters `world.entities`. `World.spawnFromLevel` already
 * draws that line for props and chests; here the reason is sharper, because
 * everything in the live array is walked by `CombatSystem.pickTarget` and by the
 * AI every tick — so a thrown grenade would become a thing soldiers stop and
 * shoot at. The renderer gets `inFlight()` instead.
 *
 * DETERMINISM. Projectiles are integrated and detonated in LAUNCH ORDER, and a
 * blast damages its victims in `world.entities` order. Nothing here draws from
 * `world.rng` and nothing iterates a `Map` to reach a result — the cooldown table
 * is read by keyed lookup only, exactly as combat's is.
 *
 * ONCE A ROUND IS IN THE AIR IT CANNOT BE RECALLED, which is the same rule
 * `combat/system.ts` enforces with its second pass. The launcher's TEAM is
 * captured at launch rather than read at detonation: the thrower may be dead by
 * the time it lands, and a `damagesFriendlies: false` grenade whose owner's team
 * had become unknowable would suddenly kill his own squad.
 */

import { applyDamage, createCooldowns, markFired, readyToFire } from '../combat/resolution'
import { clearFractionAlong } from '../combat/los'
import { INFANTRY } from '../pathing/navgrid'
import { tileToWorld } from '../view/projection'
import { planTrajectory, positionAt } from './ballistics'
import { resolveBlast, worldToTileAxis } from './blast'
import { ORDNANCE } from './table'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { TileCoord } from '../view/projection'
import type { SimSystem, Team, World } from '../world/world'
import type { Trajectory } from './ballistics'
import type { OrdnanceSpec } from './table'

/**
 * How far back along a flat round's ray to step when its impact lands exactly on
 * the face of a solid tile that the flooring convention counts as INSIDE that
 * tile. A fraction of the whole ray, so on the longest shot on a level-1-sized
 * map it is still well under a thousandth of a tile — invisible on screen, and
 * the smallest step that reliably lands the point in the tile the round came
 * from rather than the one it stopped at.
 */
const FACE_NUDGE = 1e-6

/** Knobs that are structural rather than balance. Feel lives in `table.ts`. */
export interface OrdnanceOptions {
  /**
   * The ordnance available to `launch`, keyed by name. Defaults to the module
   * `ORDNANCE`.
   *
   * THE EXTENSIBILITY SEAM, and the whole reason it is a parameter. "Adding an
   * ordnance type is adding a table row" is only worth anything if it can be
   * shown from OUTSIDE this directory: a system that read the module singleton
   * could be exercised only by editing the shipped table, which proves nothing
   * about a designer loading ordnance from `level.json`. It REPLACES the default
   * rather than merging over it, so a caller's table is exactly what it says.
   */
  readonly table?: Readonly<Record<string, OrdnanceSpec>>
  /**
   * The traversal class sightlines and cover are tested against. Infantry by
   * default, because that is what the game spawns — the same default, for the
   * same reason, as `CombatOptions.sightMask`.
   */
  readonly sightMask?: TraversalMask
}

/**
 * A round in the air, as the renderer sees it.
 *
 * Position is WORLD space with `y` as height above the ground plane, so a
 * grenade at the top of its arc reads as one. A snapshot value: see `inFlight`.
 */
export interface InFlightOrdnance {
  /** Unique for the life of the mission, so a renderer can pool per-projectile state. */
  readonly id: number
  /** Who threw it. Names a dead man perfectly happily — ids are never reused. */
  readonly launcherId: number
  /** The `OrdnanceSpec.name` it was launched with. */
  readonly ordnance: string
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * The per-tick ordnance pass, with the launch API attached.
 *
 * A callable object rather than two separate things, exactly like `CombatSystem`
 * and `SquadSystem`: it is registered with `world.addSystem`, which wants a
 * plain `SimSystem`, and the command layer needs somewhere to send a throw.
 * Splitting them would hand callers two halves of one piece of state and trust
 * them to keep the pair together.
 */
export interface OrdnanceSystem extends SimSystem {
  /**
   * Throw or fire `ordnance` from `launcherId` at a TILE. Returns whether the
   * projectile actually left.
   *
   * A BOOLEAN THAT MEANS "SOMETHING HAPPENED", not "the request was well
   * formed" — the distinction `command/apply.ts` had to learn the hard way in
   * ticket 011a, where a fire command validated, returned true and fired
   * nothing. It is refused for an ordnance the table does not name, an id naming
   * nothing living, a target off the map, and a launcher still on cooldown.
   *
   * AMMUNITION IS NOT CHECKED HERE. `OrdnanceSpec.ammoCost` is declared and
   * spent by ticket 016, which owns selection and finite ammo. The cooldown is
   * enforced because an unenforced field is a lie and this one is mechanical.
   */
  launch(launcherId: number, ordnance: string, target: TileCoord): boolean
  /**
   * Every round currently in the air, in launch order.
   *
   * FRESH OBJECTS IN A FRESH ARRAY, never the live one. Handing back the
   * system's own storage is the obvious allocation win and it means a renderer
   * holding last frame's list watches its grenades teleport as the slots beneath
   * them are reused — the trap `render-state/tracers.ts` already caught once.
   */
  inFlight(): InFlightOrdnance[]
  /** How many rounds are in the air. Agrees with `inFlight().length`, allocating nothing. */
  readonly inFlightCount: number
}

/**
 * A round in the air, as the system stores it.
 *
 * The SPEC and the TEAM are held by value rather than looked up at detonation.
 * The team is the recall rule in the header; the spec is the same argument one
 * step further — a caller who edits their table mid-mission must not retune a
 * grenade that is already in the air.
 */
interface Projectile {
  id: number
  launcherId: number
  /** The launcher's team AT LAUNCH, or `null` if he was somehow teamless. */
  team: Team | null
  ordnance: string
  spec: OrdnanceSpec
  trajectory: Trajectory
  /** Ticks elapsed since launch. */
  age: number
  /**
   * The tick after launch at which it goes off: the EARLIER of impact and the
   * fuse. A fuse that expires first detonates the round where it is, height
   * included.
   */
  detonateAt: number
}

/**
 * Build the ordnance pass over `grid`.
 *
 * A factory rather than a bare `SimSystem`, for the reason `createCombatSystem`
 * gives: the cooldown table and the in-flight list live for the whole mission
 * and belong to ONE world. Module-level mutable state here would let two worlds
 * share them, which is the determinism failure that is hardest to reproduce —
 * it depends on which test ran first.
 */
export function createOrdnanceSystem(
  grid: NavGrid,
  options: OrdnanceOptions = {},
): OrdnanceSystem {
  const table = options.table ?? ORDNANCE
  const sightMask = options.sightMask ?? INFANTRY
  const cooldowns = createCooldowns()

  /**
   * The level's extent, so aim points convert with the shared `tileToWorld`
   * rather than a second copy of its arithmetic. The grid is baked from the
   * level, so it always agrees with it.
   */
  const levelSize = { w: grid.w, h: grid.h }

  /**
   * Rounds in the air, in launch order — which is the order they are integrated
   * in, detonated in and reported in, and therefore the order two identical
   * missions agree on.
   *
   * A plain array compacted in place. It is allocated into once per LAUNCH,
   * which is bounded by the cooldown at well under one object a second per
   * soldier — not the per-tick garbage the tick contract rules out. The per-tick
   * pass itself allocates nothing.
   */
  const flying: Projectile[] = []

  /** Rounds ever launched. Doubles as the id source, so ids never repeat. */
  let launched = 0

  /**
   * The world this system was last ticked with, or `null` before its first tick.
   *
   * `launch` needs it to read the launcher's position and liveness, exactly as
   * `CombatSystem.orderFire` does and for the same reason: the system is handed
   * a grid, not a world.
   *
   * THIS COMMENT USED TO SAY "the session ticks before it applies commands, so a
   * launch before the first tick only ever happens in a test", AND THAT IS
   * EXACTLY BACKWARDS. `createSession`'s step loop drains the command queue at
   * the TOP of every step, BEFORE `world.tick()` runs a single system — go and
   * read it, the loop is a dozen lines and its own comment says "Commands at the
   * TOP OF EVERY STEP, before the systems that read them". So the FIRST command
   * of every mission genuinely does reach `launch` with `attached === null`.
   *
   * WHICH IS WHY THE SESSION PRIMES THIS SYSTEM with an inert pass at
   * construction, immediately after `world.addSystem(ordnance)`. That call is
   * LOAD-BEARING, not defensive: delete it as the no-op it resembles and the
   * first grenade of every mission is refused here — no projectile, no
   * `Explosion`, no `FireRejected`, no error, and a pouch that is never charged.
   * The player's first right-click with grenades selected simply does nothing,
   * and the second one works, which is the shape of bug nobody reports
   * accurately.
   *
   * A WRONG COMMENT IS WORSE THAN NO COMMENT, and this one cost ticket 015 a
   * review round: a reader reasoned from the sentence instead of from the loop
   * and concluded the null case was unreachable outside a test. Every claim
   * above names the file that proves it so the next reader can check rather than
   * trust.
   */
  let attached: World | null = null

  /**
   * Where this round will actually arrive, in world units.
   *
   * A BALLISTIC ROUND IS NOT CLAMPED AT ALL. Arcing over cover is the entire
   * reason a grenade exists, so there is deliberately no wall check in its
   * flight — clamping it would make it a short-range rocket with a curve drawn
   * on it.
   *
   * A FLAT ROUND STOPS AT THE NEAR FACE of the first solid tile, via the
   * `clearFractionAlong` that ticket 011a already uses to stop the rifle's
   * tracer in exactly the same place, so this needs no new geometry. Clamping
   * the AIM POINT rather than the flight is what keeps `ballistics.ts` free of
   * the grid: the trajectory is then solved to a point it can actually reach.
   *
   * THE CENTRE-RAY FRACTION IS NOT ENOUGH ON ITS OWN, and this is where this
   * clamp parts company with the one `combat/system.ts` documents.
   * `clearFractionAlong` reports a fraction of the ray joining two tile CENTRES;
   * a launcher is only ON his centre when he is standing on a waypoint, i.e.
   * almost never. Applying that fraction to the ray from his ACTUAL position
   * scales a different, differently-anchored vector, so the impact misses the
   * wall's near face by up to a tile — harmlessly short when he is nudged AWAY
   * from the wall, and INSIDE the solid tile when he is nudged toward it. In
   * combat the same approximation only shortens a cosmetic tracer; HERE it
   * decides who dies, because `resolveBlast` finds a blast centred in solid
   * ground and snaps its sightline to the nearest passable neighbour, which can
   * be on the FAR side of the wall. The bargain is therefore refused rather than
   * repeated: the fraction is taken as a first guess and then PULLED BACK along
   * the real ray, tile face by tile face, until the point it names is somewhere
   * a man could stand.
   *
   * Paid only per LAUNCH, and only on the launches that are actually blocked —
   * a clear shot's first passability test ends the loop. Nothing here runs on
   * the flight path.
   */
  function impactPoint(
    spec: OrdnanceSpec,
    originX: number,
    originZ: number,
    target: TileCoord,
    aimX: number,
    aimZ: number,
  ): { x: number; z: number } {
    if (spec.arc === 'ballistic') return { x: aimX, z: aimZ }
    const dx = aimX - originX
    const dz = aimZ - originZ
    // A zero-length ray — fired at his own tile — has no direction to clamp
    // along, and scaling nothing by anything is still the muzzle.
    if (dx === 0 && dz === 0) return { x: aimX, z: aimZ }

    // The whole clamp is reasoned about in TILE space, because tile faces are
    // where it stops. The parameter `t` along the ray is the same number in both
    // spaces — they differ by an offset and a scale — so it can be applied to the
    // world vector at the end without converting back.
    const originTileX = worldToTileAxis(originX, grid.w)
    const originTileZ = worldToTileAxis(originZ, grid.h)
    const rayTileX = worldToTileAxis(aimX, grid.w) - originTileX
    const rayTileZ = worldToTileAxis(aimZ, grid.h) - originTileZ

    let t = clearFractionAlong(
      grid,
      { x: originTileX, y: originTileZ },
      { x: target.x, y: target.y },
      sightMask,
    )

    // WHAT BOUNDS THIS LOOP IS NOT A TILE COUNT. The tempting justification —
    // "the guess is under a tile out, so it is a face or two from clear" —
    // measures the error in SPACE and the retreat in FACES, and those two are
    // only interchangeable on a ray that crosses tiles squarely. A ray running
    // lengthwise ALONG a wall crosses many faces per unit of perpendicular
    // distance: it enters the wall column once and then crosses row face after
    // row face still inside it, so it is far out in faces while barely out in
    // space. Believing otherwise let oblique shots detonate inside walls at
    // about one in fifty, and the wrong comment is how that survived a review.
    //
    // What actually terminates it is that `t` STRICTLY DECREASES every pass —
    // `entry` is at most `t` and the nudge is subtracted unconditionally — and
    // that it stops at the muzzle, so the worst case is a bounded retreat down a
    // ray that gets shorter each time. Correctness rests on exactly three things:
    // that strict decrease, the passability re-test at the top of every pass, and
    // the floor at the muzzle.
    //
    // THE COUNT IS NOT MARGIN — IT IS MEASURED, AND IT IS THE ONE NUMBER HERE
    // THAT IS LOAD-BEARING. Over a 51,744-shot probe across five wall geometries,
    // a budget of 4 leaks 14 impacts into solid ground and a budget of 8 leaks
    // none. Tighten it and cover penetration comes back; the contract test catches
    // 8 -> 4 as a failure, so trust that over any face-counting argument.
    for (let pass = 0; pass < 8; pass += 1) {
      const tileX = Math.floor(originTileX + rayTileX * t)
      const tileZ = Math.floor(originTileZ + rayTileZ * t)
      if (grid.passable(tileX, tileZ, sightMask)) break
      // Where the REAL ray enters that tile: the later of the two slab entries,
      // never before the muzzle. An axis the ray does not move along never
      // constrains the entry, so it contributes nothing.
      //
      // This arithmetic is an ACCELERATOR HINT, not a guarantee — it only makes
      // each pass retreat further so the loop converges sooner. Dropping either
      // slab axis, or swapping this `max` for `min`, still leaks zero impacts
      // into solid ground on the same 51,744-shot probe; the passability re-test
      // and the unconditional nudge below are what keep it correct. So this is
      // the part a later reader may safely sharpen. The pass budget above is not.
      let entry = 0
      if (rayTileX > 0) entry = Math.max(entry, (tileX - originTileX) / rayTileX)
      else if (rayTileX < 0) entry = Math.max(entry, (tileX + 1 - originTileX) / rayTileX)
      if (rayTileZ > 0) entry = Math.max(entry, (tileZ - originTileZ) / rayTileZ)
      else if (rayTileZ < 0) entry = Math.max(entry, (tileZ + 1 - originTileZ) / rayTileZ)
      // THE NUDGE APPLIES TO BOTH BRANCHES, and putting it on only one of them
      // is what survived the last review. Approached from below, a tile's entry
      // face IS that tile under the flooring convention, so `t = entry` taken
      // verbatim lands exactly ON the wall and floors straight back into it —
      // the very case the nudge exists for. Landing on the face was therefore
      // costing a whole pass to undo, and on exact-integer faces it never
      // resolved at all. A hair back is the near face on the side the round came
      // from, whichever direction it arrived from. Rounds whose first guess was
      // already clear never reach this line: the loop broke above, so an
      // unobstructed shot still lands exactly where it was aimed.
      t = (entry < t ? entry : t) - FACE_NUDGE
      if (!(t > 0)) {
        t = 0
        break
      }
    }
    return { x: originX + dx * t, z: originZ + dz * t }
  }

  /** See `OrdnanceSystem.launch`. */
  function launch(launcherId: number, ordnance: string, target: TileCoord): boolean {
    // An open enum reaching a table with no row for it. Silently doing nothing
    // is how a typo in level data becomes a weapon that never fires and nobody
    // can explain, so this is a refusal the caller can count.
    const spec = table[ordnance]
    if (spec === undefined) return false
    // Before the first tick there is no world to read a position out of. See
    // `attached`.
    if (attached === null) return false
    const launcher = attached.get(launcherId)
    if (launcher === undefined) return false
    // Off the map. Negated comparisons so a `NaN` coordinate falls out here
    // rather than becoming a `NaN` aim point and then a `NaN` blast centre.
    if (!(target.x >= 0) || !(target.y >= 0) || target.x >= grid.w || target.y >= grid.h) {
      return false
    }
    // NOT a passability check: a grenade aimed into the canopy is an ordinary
    // throw on this map, and `resolveBlast` is built to resolve one.
    const tick = attached.tickCount
    if (!readyToFire(cooldowns, launcherId, tick)) return false

    const aim = tileToWorld(target.x, target.y, levelSize)
    const impact = impactPoint(spec, launcher.x, launcher.z, target, aim.x, aim.z)
    markFired(cooldowns, launcherId, tick, spec)
    launched += 1
    const trajectory = planTrajectory(spec, launcher.x, launcher.z, impact.x, impact.z)
    // Whole ticks, at least one, and the earlier of the two deadlines. A fuse of
    // zero from a hand-authored table would otherwise detonate the round before
    // it had a position anybody could see.
    const fuse = Math.max(1, Math.floor(spec.fuseTicks))
    flying.push({
      id: launched,
      launcherId,
      team: launcher.team,
      ordnance,
      spec,
      trajectory,
      age: 0,
      detonateAt: Math.min(trajectory.flightTicks, fuse),
    })
    return true
  }

  /** See `OrdnanceSystem.inFlight`. */
  function inFlight(): InFlightOrdnance[] {
    const out: InFlightOrdnance[] = []
    for (let i = 0; i < flying.length; i += 1) {
      const p = flying[i]
      if (p === undefined) continue
      const at = positionAt(p.trajectory, p.age)
      out.push({
        id: p.id,
        launcherId: p.launcherId,
        ordnance: p.ordnance,
        x: at.x,
        y: at.y,
        z: at.z,
      })
    }
    return out
  }

  /**
   * Go off. Emits, then damages.
   *
   * `Explosion` BEFORE the deaths it causes, which is the ordering contract
   * `ShotFired` already holds against `UnitDied` and for the same reason: FX
   * plays the fireball from the explosion and the fall from the death. Reversed,
   * the men drop before the grenade goes off. It is emitted whether or not the
   * blast caught anybody, because the event drives sound and FX as well as the
   * kill feed — a grenade thrown into an empty field still makes a noise.
   *
   * TWO PASSES AGAIN, and the second reason from `combat/system.ts` is the one
   * that matters here: `resolveBlast` measures everybody against the world as it
   * was when the round went off, so two men standing together take the damage
   * they were standing in rather than the first one's death changing the second
   * one's arithmetic. (`applyDamage` also compacts `world.entities`, which is
   * the array `resolveBlast` was reading.)
   */
  function detonate(world: World, p: Projectile): void {
    const at = positionAt(p.trajectory, p.detonateAt)
    world.emit({
      type: 'Explosion',
      ordnance: p.ordnance,
      x: at.x,
      z: at.z,
      y: at.y,
      radiusTiles: p.spec.blastRadiusTiles,
      sourceId: p.launcherId,
    })
    const hits = resolveBlast(world, grid, p.spec, at.x, at.z, p.team, sightMask)
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i]
      if (hit === undefined) continue
      // Attributed to the launcher even if he is dead: `applyDamage` reports the
      // friendly-fire flag as false when the killer's team is unknowable, and
      // still names him, which is what a kill log needs.
      applyDamage(world, hit.id, hit.damage, p.launcherId)
    }
  }

  function ordnanceSystem(world: World): void {
    attached = world

    // One pass, in launch order, that both integrates and compacts. `write`
    // trails `i` by however many rounds have gone off, so the survivors keep
    // their relative order and the array never allocates.
    let write = 0
    for (let i = 0; i < flying.length; i += 1) {
      const p = flying[i]
      if (p === undefined) continue
      p.age += 1
      if (p.age >= p.detonateAt) {
        // Detonating inline rather than in a second pass is deliberate: rounds
        // that arrive on the same tick must resolve in launch order, and each
        // one's victims must be measured against the world the one before it
        // left behind. Nothing in `detonate` touches `flying`, so compacting
        // around it is safe.
        detonate(world, p)
        continue
      }
      flying[write] = p
      write += 1
    }
    flying.length = write

    // Cooldown housekeeping, and the same honest bargain `combat/system.ts`
    // strikes: ids are never reused, so a dead thrower's entry can never be
    // inherited by a live unit, but left untended the table grows by one per man
    // who ever threw anything. Comparing against the live entity count is a
    // cheap trigger rather than a proof — a stale entry can be masked by a unit
    // that has not thrown yet — but it bounds the table at one entry per unit
    // that has ever launched, which makes the worst case a lingering entry
    // rather than unbounded growth. The walk DELETES and decides nothing, so
    // iterating a `Map` here cannot reach a simulation result.
    if (cooldowns.size > world.entityCount) {
      for (const id of [...cooldowns.readyAt.keys()]) {
        if (!world.isAlive(id)) cooldowns.forget(id)
      }
    }
  }

  const system = Object.assign(ordnanceSystem, { launch, inFlight, inFlightCount: 0 })
  // A LIVE getter, not a copied number. `Object.assign` evaluates a getter once
  // and stores its value, which would freeze `inFlightCount` at zero for the
  // whole mission, so the property is redefined here — the count has to be read
  // through the closure to mean anything.
  Object.defineProperty(system, 'inFlightCount', {
    get: (): number => flying.length,
    enumerable: true,
  })
  return system
}
