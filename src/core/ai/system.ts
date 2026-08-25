/**
 * The enemy state machine (ticket 012): one pass per tick that decides, for
 * every unit on the AI's team, whether it is standing about, walking toward
 * something, or shooting at somebody.
 *
 * A COORDINATOR, AND HONESTLY SO. This file owns no movement and no ballistics.
 * Its whole job is choosing which of two existing systems to drive this tick —
 * `SquadSystem` to close distance, `CombatSystem` to open fire — which is why
 * both arrive as required options rather than being built here. An AI that
 * moved a unit by writing `entity.x` would be a second movement implementation
 * that no test of the squad system covers, and an AI that emitted `ShotFired`
 * itself would be a round subject to no range check and no sightline. A dying
 * player must always be able to point at the wall or the distance that killed
 * him, and the only way to guarantee that is for the enemy's round to travel
 * through exactly the machinery the player's does.
 *
 * ACQUISITION OUTRANKS MEMORY. The transitions are ordered so that a live,
 * visible target beats anything the machine remembers: a soldier who finished
 * walking to a last-known position while the man he was looking for stood in
 * front of him would be a bug the state names would hide. `pursue` and `alert`
 * are what a unit does when it has nothing better; `engage` is better.
 *
 * LOSING A TARGET AND KILLING ONE ARE DIFFERENT THINGS, and the machine is
 * careful to tell them apart — the entity is gone in both cases, so the only
 * evidence is whether the id it was last shooting at is still alive. A man who
 * broke line of sight is somewhere else, so the machine stops firing and walks
 * to where he was. A man who went down is lying in plain view, so there is
 * nothing to walk toward: he goes back to idle and re-acquires. Treating both as
 * a pursuit would have a soldier walk onto a corpse; treating both as a kill
 * would have him forget a live player the moment a wall came between them.
 *
 * HEARING IS PUSHED IN, NOT PULLED. `world.drainEvents()` empties the bus and
 * the session already drains it, so an AI that drained it too would silently
 * starve FX, audio and the HUD. `hear()` is called by the owner with the batch
 * it drained, and this system runs BEFORE combat within a tick, so an enemy
 * reacts to gunfire on the tick after it was fired. One tick, and it is the
 * honest one.
 *
 * DETERMINISM IS STRUCTURAL HERE, not a property of using the seeded rng
 * carefully: the machine draws no random number at all and reads no clock, so
 * the only ordering that could reach a decision is iteration order. Units are
 * visited in `world.entities` order (spawn order, which ticket 005 guarantees is
 * stable) and targets are scanned the same way, scored on squared distance with
 * ties broken on the lower entity id — the same rule `CombatSystem` uses for
 * auto-engage, deliberately, because two target-choice rules in one codebase
 * disagree eventually and the disagreement is invisible: the man fires either
 * way. The one `Map` in the file is read by keyed lookup and iterated only to
 * delete the dead, so its order decides nothing.
 *
 * THE COORDINATE TRAP. There are two continuous tile spaces in this engine, half
 * a tile apart, and `core/squad/system.ts` documents both at length. This module
 * touches them in exactly two places: sightlines, which are CORNER-INDEXED like
 * everything `NavGrid` answers, and the destinations it hands to `squad.order`
 * and `combat.orderFire`, which are integer tile indices produced by
 * `worldToTile` (or its per-axis halves, which are the same arithmetic without
 * the object). Integer indices agree in both conventions, so the conversion is
 * `projection`'s and this file never spells one itself.
 */

import { hasLineOfSight, inRange, weaponForKind } from '../combat'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE, tileToWorld, worldToTileX, worldToTileY } from '../view/projection'
import {
  DEFAULT_ALERT_RADIUS_TILES,
  DEFAULT_ALERT_TIMEOUT_TICKS,
  DEFAULT_ARRIVAL_TILES,
  DEFAULT_PURSUE_TIMEOUT_TICKS,
  DEFAULT_SIGHT_RANGE_TILES,
} from './tuning'
import type { CombatSystem } from '../combat'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { SquadSystem } from '../squad'
import type { TileCoord } from '../view/projection'
import type { SimEvent } from '../world/events'
import type { Entity, SimSystem, Team, World } from '../world/world'

/**
 * Every state a unit under this machine can be in.
 *
 * ENUMERABLE, and exported as such, because a HUD, the debug overlay and any
 * later behaviour tree all need to name them — and because a fifth state added
 * without a decision is how a small machine stops being small.
 */
export const AI_STATES = ['idle', 'alert', 'engage', 'pursue'] as const

/** What a unit is currently doing. See the transition table in ticket 012. */
export type AiState = (typeof AI_STATES)[number]

const IDLE: AiState = 'idle'
const ALERT: AiState = 'alert'
const ENGAGE: AiState = 'engage'
const PURSUE: AiState = 'pursue'

/**
 * What the machine needs to run. `squad` and `combat` are REQUIRED: this system
 * is a coordinator, and one built without the systems it coordinates would be a
 * state machine whose states have no consequences.
 */
export interface AiOptions {
  /** Where move orders and halts go. The same instance the player's pointer uses. */
  readonly squad: SquadSystem
  /** Where fire orders go. The same instance the player's `fire` command uses. */
  readonly combat: CombatSystem
  /**
   * The team this machine commands. The enemy, and only the enemy.
   *
   * ONE TEAM. If it ever grew a second, the player's squad would start fighting
   * on its own and ticket 011a's whole decision — that the owner chooses when
   * his men shoot — would be undone from a new file.
   */
  readonly team?: Team
  /** Sight, hearing, patience and arrival. Defaults in `tuning.ts`. */
  readonly sightRangeTiles?: number
  readonly alertRadiusTiles?: number
  readonly pursueTimeoutTicks?: number
  readonly alertTimeoutTicks?: number
  readonly arrivalTiles?: number
  /**
   * The traversal class sightlines are tested against. Infantry by default,
   * because that is what the game spawns; a turret with a raised firing position
   * would pass a different mask rather than a different grid. Matches
   * `CombatOptions.sightMask`, and for the same reason.
   */
  readonly traversalMask?: TraversalMask
}

/**
 * The per-tick decision pass, with the machine's read side attached.
 *
 * A callable object rather than two separate things, exactly like `SquadSystem`
 * and `CombatSystem`: it is registered with `world.addSystem`, which wants a
 * plain `SimSystem`, and its owner needs somewhere to push events and somewhere
 * to read state from. Splitting them would mean handing callers two halves of
 * one piece of state and trusting them to keep the pair together.
 */
export interface AiSystem extends SimSystem {
  /**
   * What this unit is doing, or `undefined` for a unit this machine does not
   * command — the whole player team, anything that never existed, and anyone
   * who has died since the last tick.
   */
  stateOf(unitId: number): AiState | undefined
  /**
   * The entity this unit is currently shooting at, or `undefined` when it is
   * shooting at nobody — which is every state but `engage`, the whole player
   * team, and anyone this machine has never commanded.
   *
   * EXPOSED FOR THE DEBUG OVERLAY (ticket 014), and it is worth the two lines.
   * The alternative is for the overlay to recompute "nearest visible enemy"
   * itself, which would be a SECOND rule for target choice — the exact
   * dual-source-of-truth mistake this file's header spends a paragraph
   * avoiding between `AiSystem` and `CombatSystem`. Two rules disagree
   * eventually, and the disagreement here is the worst kind: the man fires
   * either way and only the picture lies, so the tuner goes hunting a bug in
   * the code that was right.
   *
   * Read-only, and a plain id rather than the entity: the id outlives the
   * entity and `World` never reuses one, so a caller cannot be handed a live
   * reference into the machine's memory.
   */
  targetOf(unitId: number): number | undefined
  /**
   * Hand the machine a batch of events to react to. Called by the owner with
   * what it drained, never by draining the bus here; see the note at the top.
   *
   * Everything given is considered on the NEXT tick and then forgotten, so an
   * event heard twice cannot alert a man twice.
   */
  hear(events: readonly SimEvent[]): void
}

/**
 * One unit's slice of the machine.
 *
 * Mutable, allocated once per unit and never per tick, matching the step buffer
 * in `core/squad/system.ts`: this runs 60 times a second for the length of a
 * mission, and a fresh record per unit per tick is precisely the steady-state
 * garbage ticket 005's tick contract rules out.
 *
 * Positions are carried as plain numbers with an explicit `has*` flag rather
 * than as a nullable object, for the same reason: `null` would mean a fresh
 * object every time a target moved.
 */
interface Memory {
  state: AiState
  /** Destination of a `pursue` or `alert`, as a tile and as the world point of its centre. */
  hasGoal: boolean
  goalX: number
  goalY: number
  goalWorldX: number
  goalWorldZ: number
  /** The destination `squad` was last told about, so an unchanged one is not re-issued. */
  ordered: boolean
  orderedX: number
  orderedY: number
  /** The aim point `combat` was last told about, on the same principle. */
  aiming: boolean
  aimX: number
  aimY: number
  /** Where the target was when it was last SEEN — what a pursuit walks to. */
  hasLastKnown: boolean
  lastKnownX: number
  lastKnownZ: number
  /**
   * The last target acquired, so that losing it can be told apart from killing
   * it: the id outlives the entity, and `World` never reuses one.
   */
  hasTarget: boolean
  targetId: number
  /** The tick at which the current errand is abandoned. See the tuning file. */
  deadline: number
}

/** A shot this machine has been told about and has not yet reacted to. */
interface Rumour {
  x: number
  z: number
  shooterId: number
}

/**
 * Build the enemy state machine over `grid`.
 *
 * A factory rather than a bare `SimSystem` because the per-unit memory belongs
 * to ONE world for the length of a mission. Module-level state here would let
 * two worlds share what their soldiers remember, which is the determinism
 * failure that is hardest to reproduce: it depends on which test ran first.
 */
export function createAiSystem(grid: NavGrid, options: AiOptions): AiSystem {
  const squad = options.squad
  const combat = options.combat
  const team = options.team ?? 'enemy'
  const mask = options.traversalMask ?? INFANTRY
  const sightRangeTiles = options.sightRangeTiles ?? DEFAULT_SIGHT_RANGE_TILES
  const alertRadiusTiles = options.alertRadiusTiles ?? DEFAULT_ALERT_RADIUS_TILES
  const pursueTimeoutTicks = options.pursueTimeoutTicks ?? DEFAULT_PURSUE_TIMEOUT_TICKS
  const alertTimeoutTicks = options.alertTimeoutTicks ?? DEFAULT_ALERT_TIMEOUT_TICKS
  const arrivalTiles = options.arrivalTiles ?? DEFAULT_ARRIVAL_TILES

  /**
   * Tile distances converted to WORLD units once, here, at the one place the two
   * spaces meet. `TILE_WORLD_SIZE` is 1 today so these multiplies change
   * nothing — but omitting them would leave this the only module that reads a
   * tile count as a world distance, and a later change to the tile size would
   * make every range in the machine silently wrong by exactly that factor.
   */
  const sightRangeWorld = sightRangeTiles * TILE_WORLD_SIZE
  const alertRadiusWorld = alertRadiusTiles * TILE_WORLD_SIZE
  const arrivalWorld = arrivalTiles * TILE_WORLD_SIZE

  /**
   * The level's extent, so destinations can be converted with the shared
   * `worldToTile`/`tileToWorld` rather than a second copy of their arithmetic.
   * The grid is baked from the level, so it always agrees with it.
   */
  const levelSize = { w: grid.w, h: grid.h }

  /**
   * What each unit under this machine is doing, by entity id.
   *
   * Keyed by the id and never by an index into the entity array, which
   * `World.despawn` compacts. Read by keyed lookup, so its iteration order
   * cannot reach a decision; it IS walked once a tick to bury the dead, which
   * only ever deletes entries and therefore decides nothing.
   */
  const memories = new Map<number, Memory>()

  /**
   * Shots heard since the last tick, in the order they were reported.
   *
   * A buffer that is reused and never shrunk, for the allocation reason above;
   * `rumourCount` is how much of it is live. It settles at the largest volley
   * the mission ever fired, which is bounded by the entity count.
   */
  const rumours: Rumour[] = []
  let rumourCount = 0

  /**
   * Scratch endpoints for the sightline walk.
   *
   * Safe to reuse because `hasLineOfSight` reads both and retains neither: it
   * floors them into tile indices and walks integers from there.
   */
  const sightFrom = { x: 0, y: 0 }
  const sightTo = { x: 0, y: 0 }

  /**
   * The one-element argument every order this machine issues is made of.
   *
   * Reused rather than allocated per call for the tick-contract reason above,
   * and safe because none of the three callees retains it: `squad.order` copies
   * the ids it accepts into a roster of its own, and `squad.halt` and
   * `combat.orderFire`/`ceaseFire` iterate it and are done.
   */
  const commanded: number[] = [0]
  function just(unitId: number): readonly number[] {
    commanded[0] = unitId
    return commanded
  }

  /**
   * A world coordinate in the CORNER-INDEXED tile space the grid walks.
   *
   * The two spaces share a scale (`TILE_WORLD_SIZE` is 1) but not an origin: a
   * level is centred on the world origin, so world x = tile x - (n - 1) / 2, and
   * the `+ n / 2` here is that inverse composed with `hasLineOfSight`'s flooring
   * convention. `core/combat/system.ts` bridges the same gap the same way, and
   * for the same consumer.
   *
   * Not `worldToTile`, deliberately: that clamps to the grid, which is right for
   * pointer picking and wrong here — a unit that had somehow left the map would
   * be teleported onto the edge and handed a sightline it does not have.
   */
  const toTileAxis = (world: number, tiles: number): number => world / TILE_WORLD_SIZE + tiles / 2

  /** This unit's memory, created the first time the machine sees it. */
  function memoryFor(unitId: number): Memory {
    const existing = memories.get(unitId)
    if (existing !== undefined) return existing
    const created: Memory = {
      state: IDLE,
      hasGoal: false,
      goalX: 0,
      goalY: 0,
      goalWorldX: 0,
      goalWorldZ: 0,
      ordered: false,
      orderedX: 0,
      orderedY: 0,
      aiming: false,
      aimX: 0,
      aimY: 0,
      hasLastKnown: false,
      lastKnownX: 0,
      lastKnownZ: 0,
      hasTarget: false,
      targetId: 0,
      deadline: 0,
    }
    memories.set(unitId, created)
    return created
  }

  /**
   * The best target for `hunter`, or `null`.
   *
   * NEAREST LIVING ENEMY IN SIGHT, which is `CombatSystem`'s auto-engage rule
   * with sight range in place of weapon range — see the note at the top on why
   * it is that rule and not a cleverer one. Sight is longer than any weapon, so
   * a target found here may still be out of range; that is the difference
   * between `engage` and `pursue`, and it is decided by the caller.
   *
   * The sightline raycast is done LAST, after team and the distance comparison
   * have both been passed. It walks a tile at a time and is by far the most
   * expensive test here; almost every candidate is eliminated by a subtraction
   * and a multiply instead.
   */
  function acquire(world: World, hunter: Entity): Entity | null {
    let best: Entity | null = null
    let bestDistanceSq = 0
    const candidates = world.entities
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      if (candidate.team === hunter.team) continue
      if (candidate.health <= 0) continue
      const dx = candidate.x - hunter.x
      const dz = candidate.z - hunter.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > sightRangeWorld * sightRangeWorld) continue
      if (best !== null) {
        if (distanceSq > bestDistanceSq) continue
        // Equal distance is common — a squad advancing abreast — and without an
        // explicit tie-break the winner would be whichever the scan reached
        // first, which is stable today only by accident of spawn order. Lower id
        // wins, which is a fact about the world rather than about the loop.
        if (distanceSq === bestDistanceSq && candidate.id >= best.id) continue
      }
      sightFrom.x = toTileAxis(hunter.x, grid.w)
      sightFrom.y = toTileAxis(hunter.z, grid.h)
      sightTo.x = toTileAxis(candidate.x, grid.w)
      sightTo.y = toTileAxis(candidate.z, grid.h)
      if (!hasLineOfSight(grid, sightFrom, sightTo, mask)) continue
      best = candidate
      bestDistanceSq = distanceSq
    }
    return best
  }

  /**
   * The nearest shot this unit has been told about and ought to care about, or
   * `null`.
   *
   * A unit never reacts to its OWN gunfire: otherwise a man who fires walks
   * toward himself, which reads as an engaged soldier drifting off his firing
   * position for no reason the player can see. Ties go to the earlier report,
   * which is emission order and therefore a fact about the simulation.
   */
  function nearestRumour(listener: Entity): Rumour | null {
    let best: Rumour | null = null
    let bestDistanceSq = 0
    for (let i = 0; i < rumourCount; i += 1) {
      const rumour = rumours[i]
      if (rumour === undefined) continue
      if (rumour.shooterId === listener.id) continue
      const dx = rumour.x - listener.x
      const dz = rumour.z - listener.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > alertRadiusWorld * alertRadiusWorld) continue
      if (best !== null && distanceSq >= bestDistanceSq) continue
      best = rumour
      bestDistanceSq = distanceSq
    }
    return best
  }

  /**
   * Point this unit's errand at the tile containing a world position.
   *
   * A no-op when the tile has not changed, which is what stops a pursuit of a
   * man walking across one tile from rebuilding a detachment every tick: the
   * order dedupe downstream compares against `goalX`/`goalY`, and leaving them
   * untouched is what makes the comparison meaningful.
   *
   * The destination is the tile's CENTRE in world units, because that is where
   * `squad` actually walks a unit to; measuring arrival against the raw position
   * that produced the tile would call the errand finished up to 0.71 tiles early.
   */
  function aimErrandAt(memory: Memory, worldX: number, worldZ: number): void {
    // The axes SEPARATELY, and before anything is built: `worldToTile` returns a
    // fresh object, and a man pursuing another across open ground asks this
    // question 60 times a second to be told the tile has not changed. The pair
    // of helpers is `worldToTile`'s own arithmetic — it is defined in terms of
    // them — so this is the same rounding and the same clamp, not a second
    // spelling of the half-tile convention.
    const tileX = worldToTileX(worldX, levelSize)
    const tileY = worldToTileY(worldZ, levelSize)
    if (memory.hasGoal && memory.goalX === tileX && memory.goalY === tileY) return
    // Only the change allocates.
    const point = tileToWorld(tileX, tileY, levelSize)
    memory.hasGoal = true
    memory.goalX = tileX
    memory.goalY = tileY
    memory.goalWorldX = point.x
    memory.goalWorldZ = point.z
  }

  /** Whether this unit is standing on the errand it was sent on. */
  const arrived = (unit: Entity, memory: Memory): boolean =>
    inRange(unit.x, unit.z, memory.goalWorldX, memory.goalWorldZ, arrivalWorld)

  /**
   * Put this unit on the march, if it is not already marching to that tile.
   *
   * ONE ORDER PER DESTINATION, NOT ONE PER TICK. `squad.order` is a flow-field
   * lookup and a detachment rebuild; re-issuing an unchanged order 60 times a
   * second would pay both for nothing, and would reset the detachment the unit
   * is already in every tick.
   */
  function march(memory: Memory, unitId: number): void {
    if (!memory.hasGoal) return
    if (memory.ordered && memory.orderedX === memory.goalX && memory.orderedY === memory.goalY) {
      return
    }
    memory.ordered = true
    memory.orderedX = memory.goalX
    memory.orderedY = memory.goalY
    // A fresh object per order, not per tick: `SquadSystem.order` reads the
    // coordinate and keeps its own copy, and the dedupe above is what makes this
    // rare. `TileCoord` is readonly, so it cannot be a reused scratch.
    const target: TileCoord = { x: memory.goalX, y: memory.goalY }
    squad.order(just(unitId), target)
  }

  /** Take this unit off the march and forget where it was going. */
  function stop(memory: Memory, unitId: number): void {
    memory.hasGoal = false
    memory.ordered = false
    squad.halt(just(unitId))
  }

  /**
   * Open — or re-aim — fire on a target.
   *
   * Aimed at the target's TILE, which is what `CombatSystem` takes, and re-aimed
   * only when that tile changes. Combat's own `AIM_TOLERANCE_TILES` is what
   * turns a tile back into the man standing in it, so this is the player's
   * pointer's own path to a round leaving a rifle, with the machine holding the
   * pointer.
   */
  function shootAt(memory: Memory, unitId: number, target: Entity): void {
    // Axes first, object second — see `aimErrandAt`. An engaged man asks this
    // every tick of the firefight and the answer changes only when his target
    // crosses a tile boundary.
    const tileX = worldToTileX(target.x, levelSize)
    const tileY = worldToTileY(target.z, levelSize)
    if (memory.aiming && memory.aimX === tileX && memory.aimY === tileY) return
    memory.aiming = true
    memory.aimX = tileX
    memory.aimY = tileY
    // A fresh object per re-aim, not per tick: `CombatSystem.orderFire` converts
    // the coordinate and keeps its own copy, and `TileCoord` is readonly, so it
    // cannot be a reused scratch.
    const aim: TileCoord = { x: tileX, y: tileY }
    combat.orderFire(just(unitId), aim)
  }

  /** Take this unit off its standing fire order. */
  function holdFire(memory: Memory, unitId: number): void {
    if (!memory.aiming) return
    memory.aiming = false
    combat.ceaseFire(just(unitId))
  }

  /**
   * One unit's tick: decide the state, then make it true of the world.
   *
   * The two halves are kept apart on purpose. The first reads the world and
   * writes only to `Memory`; the second is the only place an order is issued,
   * so "which transitions command what" is one readable block rather than a
   * rule scattered through the branches above it.
   */
  function step(world: World, unit: Entity, tick: number): void {
    const memory = memoryFor(unit.id)
    const previous = memory.state
    const target = acquire(world, unit)
    let next: AiState

    if (target !== null) {
      // Seen. Remembered whether or not it is shootable, because this is the
      // position a pursuit walks to the moment sight is broken.
      memory.hasLastKnown = true
      memory.lastKnownX = target.x
      memory.lastKnownZ = target.z
      memory.hasTarget = true
      memory.targetId = target.id
      // Range is the WEAPON'S, asked of the weapon table rather than stated
      // here: a retune in `weapons.ts` must move the distance at which enemies
      // stop walking and start shooting, or the two quietly disagree. An unarmed
      // kind has no range at all and therefore never engages — it closes and
      // keeps closing, which is the honest behaviour for something that cannot
      // shoot back.
      const spec = weaponForKind(unit.kind)
      const rangeWorld = spec === null ? 0 : spec.rangeTiles * TILE_WORLD_SIZE
      if (spec !== null && inRange(unit.x, unit.z, target.x, target.z, rangeWorld)) {
        next = ENGAGE
      } else {
        next = PURSUE
        aimErrandAt(memory, target.x, target.z)
        // The clock on a pursuit runs from the last sight of the man being
        // pursued, not from the start of the chase: a soldier who can still see
        // his target has not lost the trail, and retiring him on a timer while
        // the player is in plain view is the state names hiding a bug again.
        memory.deadline = tick + pursueTimeoutTicks
      }
    } else if (previous === ENGAGE && memory.hasTarget && !world.isAlive(memory.targetId)) {
      // GUARDED ON `previous === ENGAGE`, DELIBERATELY. A man already in
      // `pursue` whose quarry is killed by somebody else keeps walking to the
      // last-known tile, and that is not an inconsistency: an engaging man
      // watched his target fall and knows there is nothing left to look for,
      // where a pursuing one never saw it happen. He finds out by arriving.
      //
      // HE WENT DOWN, which is not the same as getting away. Losing sight leaves
      // a question — where did he go? — and `pursue` is the answer to it; a dead
      // man leaves no question, so there is nothing to walk toward and nothing
      // to keep shooting at. Rounds poured into the spot where a corpse fell are
      // rounds the player watches an enemy waste. The man goes back to idle, and
      // because acquisition outranks memory anything else in sight is picked up
      // on the very next tick.
      next = IDLE
    } else if (previous === ENGAGE) {
      // Lost him, and he is still out there. Walk to where he was — the only
      // place a man who has just ducked out of sight can possibly be — and stop
      // shooting on the way, because the round would be going into the cover he
      // is behind rather than into him.
      if (memory.hasLastKnown) {
        next = PURSUE
        aimErrandAt(memory, memory.lastKnownX, memory.lastKnownZ)
        memory.deadline = tick + pursueTimeoutTicks
      } else {
        next = IDLE
      }
    } else if (previous === PURSUE || previous === ALERT) {
      // An errand in progress, with nothing in sight to outrank it. It ends on
      // arrival, or on the timeout that stops an unreachable destination from
      // being walked at for the rest of the mission.
      next = !memory.hasGoal || tick >= memory.deadline || arrived(unit, memory) ? IDLE : previous
    } else {
      // Idle, and therefore available to be curious. Gunfire is the only thing
      // that reaches a man who can see nothing; `alert` deliberately cannot
      // interrupt anything, which is why this branch is last.
      const rumour = nearestRumour(unit)
      if (rumour === null) {
        next = IDLE
      } else {
        next = ALERT
        aimErrandAt(memory, rumour.x, rumour.z)
        memory.deadline = tick + alertTimeoutTicks
      }
    }

    memory.state = next

    if (next === ENGAGE) {
      // HALT ON ENTERING, NOT EVERY TICK. A man who walks into his own weapon's
      // range and keeps walking ends the engagement in knife range, which wastes
      // every piece of cover the level contains — but halting a man who is
      // already halted would take him out of a detachment he is not in, 60 times
      // a second, for as long as the firefight lasts.
      if (previous !== ENGAGE) stop(memory, unit.id)
      if (target !== null) shootAt(memory, unit.id, target)
      return
    }

    // Everything below is a state that does not shoot. Ceasing fire is idempotent — `holdFire` returns immediately unless an
    // order stands — so it can be stated once here rather than per branch.
    holdFire(memory, unit.id)
    if (next === IDLE) {
      // A man retired mid-march has to be stopped, or he finishes walking to a
      // destination the machine has already given up on.
      if (previous === PURSUE || previous === ALERT) stop(memory, unit.id)
      return
    }
    march(memory, unit.id)
  }

  function aiSystem(world: World): void {
    // Bury the memory of the dead. An id is never reused, so a leaked entry
    // could never be inherited by a live unit — but `stateOf` would keep
    // answering about a man who is gone, and the table would grow by one per
    // casualty for the length of the mission.
    // Walked LIVE, not over a copy of the keys. Deleting the entry a `Map`
    // iterator is standing on is defined behaviour — the walk continues from the
    // next entry, and an entry deleted before it is reached is simply never
    // visited — so the snapshot would buy nothing but an array per tick, for
    // every tick of the mission. It is safe to iterate a `Map` here at all only
    // because this loop DELETES and decides nothing: no simulation result can
    // depend on the order it happens to walk in.
    for (const id of memories.keys()) {
      if (!world.isAlive(id)) memories.delete(id)
    }

    // Spawn order, and nothing is added to or removed from the entity list by
    // anything below, so the plain index walk is safe: this pass issues orders
    // and never spawns or despawns.
    const entities = world.entities
    const tick = world.tickCount
    for (let i = 0; i < entities.length; i += 1) {
      const unit = entities[i]
      if (unit === undefined) continue
      if (unit.team !== team) continue
      step(world, unit, tick)
    }

    // Heard once, acted on once. Anything not reacted to this tick is stale by
    // the next one — a shot fired two ticks ago is not news — and leaving the
    // buffer full would alert a man over and over to the same round.
    rumourCount = 0
  }

  function hear(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event === undefined) continue
      if (event.type !== 'ShotFired') continue
      // The ORIGIN, not the target: what a man hears is the rifle going off, and
      // walking toward where the round landed would send him somewhere nobody
      // has ever been.
      const slot = rumours[rumourCount]
      if (slot === undefined) {
        rumours.push({ x: event.originX, z: event.originZ, shooterId: event.shooterId })
      } else {
        slot.x = event.originX
        slot.z = event.originZ
        slot.shooterId = event.shooterId
      }
      rumourCount += 1
    }
  }

  const stateOf = (unitId: number): AiState | undefined => memories.get(unitId)?.state

  /**
   * See `AiSystem.targetOf`.
   *
   * GATED ON `engage`, not merely on `hasTarget`. A pursuing man remembers the
   * id he was last shooting at — that is how losing a target is told apart from
   * killing one, above — but he is not shooting at it, and a ray drawn to a man
   * who has ducked behind a wall would show a sightline that does not exist.
   * The two facts are different and this reports the narrower one.
   */
  function targetOf(unitId: number): number | undefined {
    const memory = memories.get(unitId)
    if (memory === undefined) return undefined
    if (memory.state !== ENGAGE || !memory.hasTarget) return undefined
    return memory.targetId
  }

  return Object.assign(aiSystem, { stateOf, targetOf, hear })
}
