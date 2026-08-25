/**
 * The squad system (ticket 007): move orders, formation follow, and the local
 * steering that keeps a squad looking like several men rather than one.
 *
 * WHAT A DETACHMENT IS. An ordered roster of unit ids and one target tile. The
 * leader is the FIRST LIVING MEMBER IN ROSTER ORDER — a question asked fresh
 * every tick, never a stored `leaderId`. A stored id is a field that can be
 * stale, and the tick it goes stale the squad either follows a corpse or stops;
 * asking again after a death cannot be stale, and because the target lives on
 * the detachment rather than on the leader, the order survives the promotion.
 * Splitting falls out of the same model: `order` pulls the named ids out of
 * whatever detachment holds them and forms a new one, so the remainder keeps its
 * old target under whoever is now first in what is left of its roster.
 *
 * FOUR PASSES — snapshot, seek, separate, apply — for the reason
 * `core/combat/system.ts` gives at length: everything a unit decides this tick
 * is decided against the SAME snapshot of where everybody stood at the start of
 * it, and only the last pass touches the world. Half-updated positions would
 * make a separation push depend on roster order — the man iterated first would
 * shove the man iterated second and never be shoved back — and that asymmetry
 * is deterministic, so no determinism test would ever see it.
 *
 * THE COORDINATE TRAP, AND THE TWO CONVENTIONS IT IS MADE OF. There are two
 * continuous tile coordinate systems in this engine and they sit exactly half a
 * tile apart.
 *
 *   - CENTRE-INDEXED, the one `core/view/projection` speaks. `tileToWorld` maps
 *     integer tile `n` to world `n - (w - 1) / 2`, so an integer names a tile
 *     CENTRE, tile `n` spans `[n - 0.5, n + 0.5)`, and the index of a position
 *     is `Math.round`. That is what `worldToTile` does.
 *   - CORNER-INDEXED, the one `NavGrid.index`, `FlowField.index`,
 *     `computeFlowField` and `squad/steering` all speak. Tile `n` spans
 *     `[n, n + 1)`, its centre is `n + 0.5`, and the index of a position is
 *     `Math.floor`.
 *
 * This module thinks in the CORNER-INDEXED system, because everything it asks a
 * question of does. So the conversion in from a world position adds `w / 2`
 * (not `(w - 1) / 2`, which would land in the centre-indexed system and be
 * floored by the grid into the tile next door), and the conversion out
 * subtracts it again. `core/combat/system.ts` bridges the same gap the same
 * way. Mixing the two is the worst-sized bug available here: every unit still
 * ends up somewhere plausible, it just occupies the tile next door from the one
 * the rest of the engine says it is in.
 *
 * DETERMINISM. Iteration is detachment order then roster order, both stable.
 * Every tick is a pure function of the previous state and the orders given: no
 * clock is read and no `rng` is drawn from. The one `Map` in reach — inside the
 * flow field cache — IS iterated, by that cache's LRU eviction; determinism
 * survives because its insertion order is fully determined by the order this
 * system asks for fields, which is detachment order, so two identical worlds
 * evict identically or not at all. Two identical worlds therefore tick to
 * identical positions, which is what lets a mission replay from a seed and a
 * command list.
 */

import { createFlowFieldCache } from '../pathing/cache'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE } from '../view/projection'
import { FIXED_TIMESTEP } from '../world/gameloop'
import { rotatedX, rotatedY, slotForward, slotRight } from './formation'
import { slideX, slideY } from './steering'
import type { FlowField, GridPoint } from '../pathing/flowfield'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { TileCoord } from '../view/projection'
import type { World } from '../world/world'

/** Tuning. Every one of these is feel rather than structure — see the defaults. */
export interface SquadOptions {
  /** Ground speed of every unit under command, in tiles per second. */
  readonly speedTilesPerSecond?: number
  /** How close two units may get before they push each other apart, in tiles. */
  readonly separationRadius?: number
  /** Distance between formation rows, in tiles. Also sets the wedge's width. */
  readonly slotSpacing?: number
  /** How far a follower may be from its slot before it abandons it, in tiles. */
  readonly catchUpDistance?: number
  /**
   * The traversal class these units belong to. Infantry by default, because
   * that is what the game spawns; the vehicles extension point passes a
   * different mask rather than a different grid.
   */
  readonly traversalMask?: TraversalMask
}

/**
 * The per-tick movement pass, with the ordering API attached.
 *
 * A callable object rather than two separate things: it is registered with
 * `world.addSystem`, which wants a plain `SimSystem`, and the command layer
 * needs somewhere to send orders. Splitting them would mean handing callers two
 * halves of one piece of state and trusting them to keep the pair together.
 */
export interface SquadSystem {
  (world: World): void
  /**
   * Order these units to a tile. Ids that name no living unit are ignored;
   * the rest leave whatever detachment they were in and form a new one, in the
   * order given — so the first id is the leader unless it is dead.
   */
  order(unitIds: readonly number[], target: TileCoord): void
  /**
   * Stop these units where they stand (ticket 012). Ids that name no living
   * unit are ignored, and a unit that was under nobody's command is unaffected.
   *
   * A REAL PRIMITIVE, NOT A CONVENIENCE. The alternative is ordering a man to
   * the tile he is already standing on — and an order aims at a tile CENTRE, so
   * he shuffles up to 0.71 tiles sideways at the exact moment he was meant to
   * plant his feet and shoot. Ordering a stop and getting a step is not a stop.
   *
   * It also resets `Entity.state` to `'idle'`, which is half the point and the
   * easier half to leave out: the apply pass writes that field every tick it
   * runs, so a unit dropped out of its detachment keeps whatever its last step
   * wrote and walk-animates on the spot forever. The reset lands on the NEXT
   * tick, not inside this call — see `halted`.
   */
  halt(unitIds: readonly number[]): void
  /**
   * The unit currently leading this unit's detachment, or `undefined`.
   *
   * Liveness is checked against the world this system was last ticked with, so
   * between an order given before the very first tick and that tick landing
   * there is no world to check against and this returns the first id in the
   * roster whether or not it names a living unit. That window is one tick long
   * and closes for good; see `attached`.
   */
  leaderOf(unitId: number): number | undefined
  /** The tile this unit's detachment is marching to, or `undefined`. */
  targetOf(unitId: number): TileCoord | undefined
  /** How many detachments are under command. Empty ones are dropped each tick. */
  readonly detachmentCount: number
}

/** A walking pace: fast enough to cross a level, slow enough to see formation. */
const DEFAULT_SPEED_TILES_PER_SECOND = 3

/** Just under a tile, so a squad on open ground reads as men and not a column. */
const DEFAULT_SEPARATION_RADIUS = 0.6

/**
 * Row spacing, in tiles. Deliberately LOOSER than the separation radius above.
 *
 * Spacing tight enough that two slots sit closer than `separationRadius` would
 * put men inside each other's personal space the moment the formation was
 * actually held, so the seek and the separation push would fight each other
 * forever and a standing squad would shiver. The threshold is not the spacing
 * itself: the CLOSEST pair of slots the wedge produces is the leader and rank 1,
 * `spacing * hypot(1, 0.7)` = 1.2207 * spacing apart, where 0.7 is the wedge
 * spread in `formation.ts` (rank 1 to rank 2,
 * the other candidate, is 1.4 * spacing), so the crossover is at a spacing of
 * about 0.49, not 0.6. At 0.9 against a radius of 0.6 the minimum slot gap is
 * 1.0986, comfortably clear, and the formation is a stable fixed point: hold the
 * slot and nobody is crowding anybody.
 */
const DEFAULT_SLOT_SPACING = 0.9

/**
 * Far enough that ordinary lag behind a marching leader is not mistaken for
 * being lost, close enough that a slot on the far side of a wall is.
 */
const DEFAULT_CATCH_UP_DISTANCE = 3

/**
 * Distance at which a unit is treated as standing on its goal.
 *
 * A unit never overshoots — a step is clamped to the distance remaining — so
 * this is only here to stop the final, vanishing residue from being normalised
 * into a direction. Tiny, because anything larger is a radius the unit visibly
 * stops short by.
 */
const ARRIVED_EPSILON = 1e-6

/**
 * Below this, two units are the same point and have no axis to separate along.
 *
 * The degenerate case is the one that actually happens: two spawns land on one
 * tile and the squad renders as a single soldier with a bad shadow. Normalising
 * a zero vector yields NaN, and a NaN position never comes back, so the pair is
 * pushed apart along x by buffer order instead — deterministic, and the wedge
 * takes over from there.
 */
const COINCIDENT_EPSILON = 1e-9

/** `Entity.state` while a unit is walking, and while it is not. */
const STATE_MOVING = 'moving'
const STATE_IDLE = 'idle'

/** One detachment: who, where to, and which way its leader is currently facing. */
interface Detachment {
  /** Ordered unit ids. Compacted each tick, so the leader is `roster[0]`. */
  readonly roster: number[]
  /** The ordered destination, in tile coordinates, exactly as given. */
  readonly targetX: number
  readonly targetY: number
  /**
   * The leader's heading as a unit vector in tile space, carried across ticks so
   * a halted squad keeps the shape it arrived in. Starts pointing south, which
   * is arbitrary and survives only until the leader's first step.
   */
  facingX: number
  facingY: number
  /**
   * The field descending to (`targetX`, `targetY`), once something has asked
   * for it, or `null`.
   *
   * Held here rather than looked up per tick because the target never changes
   * for the life of a detachment — a new order builds a new detachment — so
   * this is a memo of a constant, not a cache with an invalidation problem. The
   * one thing that can invalidate it is the map changing under it, which
   * `FlowField.gridVersion` reports; see `detachmentField`.
   */
  field: FlowField | null
}

/**
 * One unit's slice of a tick: where it was, and what it decided to do.
 *
 * Mutable objects in a buffer that is reused and never shrunk, matching the
 * combat system: this runs 60 times a second for the length of a mission, and a
 * fresh array of vectors per tick is precisely the steady-state garbage the tick
 * contract rules out. The buffer settles at the largest squad ever commanded.
 */
interface UnitStep {
  id: number
  /** Position at the START of the tick, in tile space. The shared snapshot. */
  x: number
  y: number
  /** Displacement decided by seeking — flow field, formation slot or leader. */
  moveX: number
  moveY: number
  /** Displacement decided by separation, accumulated over every crowding pair. */
  pushX: number
  pushY: number
}

/**
 * Build the per-tick squad pass over `grid`.
 *
 * A factory rather than a bare `SimSystem` because the detachments, the flow
 * field cache and the step buffer all belong to ONE world for the length of a
 * mission. Module-level state here would let two worlds share a roster, which is
 * the determinism failure that depends on which test ran first.
 */
export function createSquadSystem(grid: NavGrid, options: SquadOptions = {}): SquadSystem {
  const speed = options.speedTilesPerSecond ?? DEFAULT_SPEED_TILES_PER_SECOND
  const separationRadius = options.separationRadius ?? DEFAULT_SEPARATION_RADIUS
  const slotSpacing = options.slotSpacing ?? DEFAULT_SLOT_SPACING
  const catchUpDistance = options.catchUpDistance ?? DEFAULT_CATCH_UP_DISTANCE
  const mask = options.traversalMask ?? INFANTRY

  /**
   * How far a unit travels in one call of this system.
   *
   * One system call is one fixed step by the tick contract, so the timestep is a
   * constant and not something to be measured. Reading a clock here is what the
   * whole fixed-timestep design exists to avoid.
   */
  const stepPerTick = speed * FIXED_TIMESTEP

  // Origin shift from world space into CORNER-INDEXED tile space — the
  // convention `NavGrid`, `FlowField` and `steering` all floor against; see the
  // coordinate note at the top of this file. A level is centred on the world
  // origin, so its west edge is at world `-w / 2` and corner-indexed tile x is
  // `world x / tile size + w / 2`. Half a tile more than the `(w - 1) / 2` that
  // `projection.tileToWorld` uses, and that half tile is the whole point: it is
  // what turns "the world point of tile n's CENTRE" into "a coordinate that
  // floors to n". `core/combat/system.ts` bridges the same gap the same way.
  //
  // Computed once from the grid, which is baked from the level and therefore
  // always agrees with it.
  const originX = grid.w / 2
  const originY = grid.h / 2
  const toTileX = (worldX: number): number => worldX / TILE_WORLD_SIZE + originX
  const toTileY = (worldZ: number): number => worldZ / TILE_WORLD_SIZE + originY
  const toWorldX = (tileX: number): number => (tileX - originX) * TILE_WORLD_SIZE
  const toWorldZ = (tileY: number): number => (tileY - originY) * TILE_WORLD_SIZE

  /**
   * Shared store of fields, so two detachments ordered to the same tile solve
   * it once between them.
   *
   * It is NOT what bounds the sweep count. This cache is an LRU of fixed
   * capacity (`DEFAULT_FIELD_CAPACITY`, 16), and a mission with more live
   * detachments than that would evict every entry before its owner asked again
   * — one full `computeFlowField` per detachment per tick, which is more work
   * than the per-unit A* flow fields were chosen to replace. What actually
   * bounds it is `detachmentField` below, which holds the returned field on the
   * detachment itself: the cache is consulted once per detachment per grid
   * version and never per tick, so the LRU's capacity affects only how much of
   * that first-fetch sharing survives, never the steady-state cost.
   *
   * Nor does the capacity bound what is RESIDENT. `Detachment.field` is a strong
   * reference held for the life of the detachment, outside the LRU, so a field
   * survives its own eviction: resident field memory is one `FlowField` — a
   * `Float64Array` and two `Int8Array`s, each `w * h` — per DISTINCT live target,
   * not 16. That is bounded by the number of detachments, which is bounded by the
   * unit count, and every one of them is dropped with its detachment when the
   * detachment empties, so it grows with the mission's squads rather than
   * leaking.
   */
  const fields = createFlowFieldCache()

  const detachments: Detachment[] = []
  const steps: UnitStep[] = []
  let stepCount = 0

  /**
   * Units taken out of command by `halt` whose `Entity.state` has not been reset
   * yet.
   *
   * DEFERRED, AND IT HAS TO BE. `halt` is handed ids and not entities — the
   * system holds a grid, and before its first tick there is no world to look one
   * up in, exactly as `order` documents on `attached`. Writing the state from
   * inside `halt` would therefore be a no-op for an order given during setup and
   * would silently depend on the caller having ticked first. Applied at the top
   * of the pass below instead, where a world is in hand and where a unit
   * re-ordered in the meantime is about to have `'moving'` written over it
   * anyway by the apply pass.
   */
  const halted: number[] = []

  /**
   * The world this system was last ticked with, or `null` before its first tick.
   *
   * `order` uses it to drop ids that name nothing living. It cannot be captured
   * any earlier: `createSquadSystem` is handed a grid, and `World.addSystem`
   * only stores the function — so an order given before the very first tick is
   * accepted as written and validated on the tick that follows it. That is one
   * tick, 1/60 of a second, during which `detachmentCount` may count a
   * detachment whose members do not exist.
   */
  let attached: World | null = null

  /**
   * Scratch destination for cache lookups, reused rather than allocated.
   *
   * Safe because the cache does not retain it: `keyFor` stringifies it and
   * `computeFlowField` copies the floored tile onto the field it returns.
   */
  const lookup = { x: 0, y: 0 }

  /** The step buffer slot at `index`, creating it the first time it is needed. */
  function stepAt(index: number): UnitStep {
    const existing = steps[index]
    if (existing !== undefined) return existing
    const created: UnitStep = { id: 0, x: 0, y: 0, moveX: 0, moveY: 0, pushX: 0, pushY: 0 }
    steps.push(created)
    return created
  }

  /** The detachment holding `unitId`, or `null`. */
  function detachmentOf(unitId: number): Detachment | null {
    for (let i = 0; i < detachments.length; i += 1) {
      const detachment = detachments[i]
      if (detachment === undefined) continue
      if (detachment.roster.includes(unitId)) return detachment
    }
    return null
  }

  /**
   * Aim `unit` at (goalX, goalY) and write the step it should take.
   *
   * Clamped to the distance remaining, so a unit lands exactly on its goal and
   * then stops rather than overshooting and coming back — which is the whole
   * difference between a squad that settles and one that orbits its target
   * forever. Returns whether a step was written.
   */
  function seekPoint(unit: UnitStep, goalX: number, goalY: number): boolean {
    const dx = goalX - unit.x
    const dy = goalY - unit.y
    const distance = Math.hypot(dx, dy)
    // Negated so a NaN goal — which nothing should produce, and which would be
    // permanent if it reached a position — leaves the unit standing still.
    if (!(distance > ARRIVED_EPSILON)) return false
    const travel = distance < stepPerTick ? distance : stepPerTick
    unit.moveX = (dx / distance) * travel
    unit.moveY = (dy / distance) * travel
    return true
  }

  /**
   * Steer `unit` down `field`, aiming at (finalX, finalY) once it is standing in
   * the field's target tile.
   *
   * The goal is always a tile CENTRE — `tile + 0.5` in the corner-indexed space
   * this module works in — rather than the raw step direction: it keeps units
   * off the tile edges they would otherwise hug, which is what stops the man on
   * the outside of a corner from spending the whole turn grinding along a wall.
   * (finalX, finalY) is passed in rather than derived so the caller can decide
   * what "arrived" means for it; both callers pass the centre of a tile.
   *
   * `facingOwner`, when given, takes its heading from the FIELD's step direction
   * rather than from the movement produced: the field's direction is one of
   * eight and therefore steady, where the direction to a tile centre wobbles by
   * however far off-centre the unit currently is. The heading is left alone
   * during the final approach, because the last half-tile of shuffling onto an
   * exact spot is not a change of heading and rotating the whole wedge to match
   * it would swing the squad round its leader on arrival.
   */
  function steerAlongField(
    unit: UnitStep,
    field: FlowField,
    finalX: number,
    finalY: number,
    facingOwner: Detachment | null,
  ): void {
    // An unreachable cell has no direction to give — the target is walled off,
    // inside a rock, or off the map. Standing still is the honest answer;
    // handed a direction anyway, a unit would walk into the wall and, because
    // the field does not change, keep doing it for the rest of the mission.
    if (!field.reachable(unit.x, unit.y)) return
    const tileX = Math.floor(unit.x)
    const tileY = Math.floor(unit.y)
    if (tileX === field.target.x && tileY === field.target.y) {
      seekPoint(unit, finalX, finalY)
      return
    }
    const dirX = field.dirX(unit.x, unit.y)
    const dirY = field.dirY(unit.x, unit.y)
    if (dirX === 0 && dirY === 0) return
    if (facingOwner !== null) {
      const length = Math.hypot(dirX, dirY)
      facingOwner.facingX = dirX / length
      facingOwner.facingY = dirY / length
    }
    seekPoint(unit, tileX + dirX + 0.5, tileY + dirY + 0.5)
  }

  /**
   * The field descending to this detachment's target.
   *
   * Memoised on the detachment and re-fetched only when the grid version it was
   * solved against has moved — a door opening or a wall coming down, which is
   * exactly when a field routing through the old shape becomes a lie. So the
   * cost of a marching detachment is one `computeFlowField` for the whole
   * march, not one per tick, and the shared cache is asked once rather than
   * being churned by however many detachments are alive.
   */
  function detachmentField(detachment: Detachment): FlowField {
    const memo = detachment.field
    if (memo !== null && memo.gridVersion === grid.version) return memo
    lookup.x = detachment.targetX
    lookup.y = detachment.targetY
    // The scratch object is read and discarded inside this call — see `lookup`.
    const field = fields.get(grid, lookup as GridPoint, mask)
    detachment.field = field
    return field
  }

  /**
   * Decide one follower's step: hold the slot, or go and find the leader.
   *
   * A slot is a position in the leader's frame and knows nothing about terrain,
   * so a follower cut off from its slot by a building is being asked to walk
   * into a wall. Past `catchUpDistance` the slot is abandoned and the follower
   * paths on a flow field instead, which is terrain-aware by construction, and
   * picks the slot back up once it is close enough to mean something.
   *
   * It paths to the DETACHMENT'S TARGET, not to the leader. Both converge — the
   * leader is walking to that target too — and the target is a fixed tile,
   * where the leader's tile changes every time he crosses a boundary. A field
   * keyed on a moving leader would be a fresh whole-map Dijkstra sweep every
   * few ticks for as long as one man was lagging, which is the churn the memo
   * on the detachment exists to avoid; this way a straggler costs nothing at
   * all beyond the field the detachment already holds.
   */
  function steerFollower(
    unit: UnitStep,
    detachment: Detachment,
    leader: UnitStep,
    rank: number,
  ): void {
    const forward = slotForward(rank, slotSpacing)
    const right = slotRight(rank, slotSpacing)
    const slotX = leader.x + rotatedX(forward, right, detachment.facingX, detachment.facingY)
    const slotY = leader.y + rotatedY(forward, right, detachment.facingX, detachment.facingY)
    if (Math.hypot(slotX - unit.x, slotY - unit.y) > catchUpDistance) {
      steerAlongField(
        unit,
        detachmentField(detachment),
        detachment.targetX + 0.5,
        detachment.targetY + 0.5,
        null,
      )
      return
    }
    seekPoint(unit, slotX, slotY)
  }

  /**
   * Pull these ids out of every detachment holding them, dropping any
   * detachment the removal empties.
   *
   * The whole of what "squad splitting" is, and shared by `order` and `halt`
   * because it is the same operation: the remainder keeps its old target and
   * re-promotes whoever is now first in what is left of its roster. Ids naming
   * nothing are simply not found.
   */
  function detach(ids: readonly number[]): void {
    let write = 0
    for (let i = 0; i < detachments.length; i += 1) {
      const detachment = detachments[i]
      if (detachment === undefined) continue
      const held = detachment.roster
      let kept = 0
      for (let r = 0; r < held.length; r += 1) {
        const id = held[r]
        if (id === undefined || ids.includes(id)) continue
        held[kept] = id
        kept += 1
      }
      held.length = kept
      if (kept === 0) continue
      detachments[write] = detachment
      write += 1
    }
    detachments.length = write
  }

  /** Cancel the pending idle reset for these ids. Compacted in place. */
  function forgetHalted(ids: readonly number[]): void {
    if (halted.length === 0) return
    let write = 0
    for (let i = 0; i < halted.length; i += 1) {
      const id = halted[i]
      if (id === undefined || ids.includes(id)) continue
      halted[write] = id
      write += 1
    }
    halted.length = write
  }

  /**
   * Give an order. See `SquadSystem.order`.
   *
   * The named ids are removed from every existing detachment before the new one
   * is formed, which is all "squad splitting" is: the remainder is left with its
   * old target and re-promotes whoever is now first, and a detachment emptied
   * by the move is dropped. Re-ordering a whole squad therefore replaces its
   * detachment rather than accumulating a second, empty one.
   */
  function order(unitIds: readonly number[], target: TileCoord): void {
    const roster: number[] = []
    for (const id of unitIds) {
      // Unknown and dead ids are dropped rather than throwing: a command layer
      // is selecting from a list that a mortar round may have edited between
      // the click and the order arriving, and losing a man must not lose the
      // order. Duplicates are dropped too — a unit standing in two of its own
      // formation slots would fight itself for both.
      if (attached !== null && !attached.isAlive(id)) continue
      if (roster.includes(id)) continue
      roster.push(id)
    }

    detach(roster)
    // A unit put back under command is no longer a halted one: it is about to
    // have `'moving'` written over its state by the apply pass, and leaving it
    // queued would idle it a tick later for an order it has already been given.
    forgetHalted(roster)

    // An order naming nobody living is an order to nobody. It leaves the ids it
    // named detached, which is the correct reading of "those units are gone".
    if (roster.length === 0) return
    detachments.push({
      roster,
      targetX: target.x,
      targetY: target.y,
      facingX: 0,
      facingY: 1,
      field: null,
    })
  }

  /**
   * Stop these units. See `SquadSystem.halt`.
   *
   * Nothing is written to the world here — not the position, which is already
   * where the man should stop, and not the state, which is queued for the top of
   * the next pass. A halt is therefore exactly a detach plus a promise, and the
   * promise is the only part with a tick of latency.
   */
  function halt(unitIds: readonly number[]): void {
    detach(unitIds)
    for (const id of unitIds) {
      if (halted.includes(id)) continue
      halted.push(id)
    }
  }

  function leaderOf(unitId: number): number | undefined {
    const detachment = detachmentOf(unitId)
    if (detachment === null) return undefined
    // First LIVING member, asked fresh — the promotion rule, not a cached id.
    // Rosters are compacted every tick, so this scan normally stops on the
    // first entry; it still checks, because a death between two ticks must
    // promote immediately rather than a frame later.
    //
    // BEFORE THE FIRST TICK there is no world to ask, and `attached === null`
    // short-circuits the liveness test — so an order given between
    // `createSquadSystem` and the first `world.tick()` can name a dead unit as
    // leader for exactly that one tick. Documented on `attached` as well, and
    // repeated here so reading this function is enough to know it.
    for (let i = 0; i < detachment.roster.length; i += 1) {
      const id = detachment.roster[i]
      if (id === undefined) continue
      if (attached === null || attached.isAlive(id)) return id
    }
    return undefined
  }

  function targetOf(unitId: number): TileCoord | undefined {
    const detachment = detachmentOf(unitId)
    if (detachment === null) return undefined
    // A copy: the caller must not be able to redirect a squad by writing to the
    // object it was told about.
    return { x: detachment.targetX, y: detachment.targetY }
  }

  function squadSystem(world: World): void {
    attached = world

    // ---- Pass 0: land the state reset `halt` promised ----------------------
    // BEFORE the snapshot, not after the apply: a unit halted and then ordered
    // again in the same window is back in a roster, and pass 4 must be free to
    // write `'moving'` over this. A halted unit is in no roster at all, so
    // nothing downstream touches it and the reset stands.
    if (halted.length > 0) {
      for (let i = 0; i < halted.length; i += 1) {
        const id = halted[i]
        if (id === undefined) continue
        const entity = world.get(id)
        // The man died between the halt and this tick. Nothing to reset, and
        // nothing to complain about — a corpse takes no orders.
        if (entity === undefined) continue
        entity.state = STATE_IDLE
      }
      halted.length = 0
    }

    // ---- Pass 1: snapshot, and bury the dead ------------------------------
    // Compaction and snapshot in one walk, so the step buffer's layout matches
    // the compacted rosters by construction rather than by two loops agreeing.
    // A detachment with no living members is dropped here, which is why nothing
    // downstream has to cope with a leaderless one.
    stepCount = 0
    let liveDetachments = 0
    for (let i = 0; i < detachments.length; i += 1) {
      const detachment = detachments[i]
      if (detachment === undefined) continue
      const roster = detachment.roster
      let kept = 0
      for (let r = 0; r < roster.length; r += 1) {
        const id = roster[r]
        if (id === undefined) continue
        const entity = world.get(id)
        if (entity === undefined) continue
        roster[kept] = id
        kept += 1
        const unit = stepAt(stepCount)
        unit.id = id
        unit.x = toTileX(entity.x)
        unit.y = toTileY(entity.z)
        unit.moveX = 0
        unit.moveY = 0
        unit.pushX = 0
        unit.pushY = 0
        stepCount += 1
      }
      roster.length = kept
      if (kept === 0) continue
      detachments[liveDetachments] = detachment
      liveDetachments += 1
    }
    detachments.length = liveDetachments
    if (stepCount === 0) return

    // ---- Pass 2: seek. Reads the snapshot, writes only decisions. ---------
    let base = 0
    for (let i = 0; i < detachments.length; i += 1) {
      const detachment = detachments[i]
      if (detachment === undefined) continue
      const size = detachment.roster.length
      const leader = steps[base]
      if (leader !== undefined) {
        // The leader is steered first because the wedge hangs off both his
        // position and the heading his step sets, and both are read below.
        steerAlongField(
          leader,
          detachmentField(detachment),
          // Corner-indexed centre of the ordered tile: the same world point
          // `projection.tileToWorld` calls tile (targetX, targetY).
          detachment.targetX + 0.5,
          detachment.targetY + 0.5,
          detachment,
        )
        for (let rank = 1; rank < size; rank += 1) {
          const follower = steps[base + rank]
          if (follower === undefined) continue
          steerFollower(follower, detachment, leader, rank)
        }
      }
      base += size
    }

    // ---- Pass 3: separation. Every pair, from the same snapshot. ----------
    // A correction to a position, not a force added to a velocity. A force
    // competes with the seek for the same budget and can simply lose — which is
    // how a squad ends up marching through itself in a corridor while every
    // end-of-run assertion passes — whereas a correction is applied on top and
    // the property being asserted is about positions in the first place.
    //
    // Each of a crowding pair takes half the overlap, so neither is privileged
    // by being iterated first. Accumulated from the snapshot rather than applied
    // as the scan goes, for the same reason: a later pair must not be resolved
    // against a position an earlier pair has already moved.
    for (let i = 0; i < stepCount; i += 1) {
      const a = steps[i]
      if (a === undefined) continue
      for (let j = i + 1; j < stepCount; j += 1) {
        const b = steps[j]
        if (b === undefined) continue
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distance = Math.hypot(dx, dy)
        if (distance >= separationRadius) continue
        let normalX = -1
        let normalY = 0
        let overlap = separationRadius
        if (distance > COINCIDENT_EPSILON) {
          normalX = dx / distance
          normalY = dy / distance
          overlap = separationRadius - distance
        }
        const half = overlap / 2
        a.pushX += normalX * half
        a.pushY += normalY * half
        b.pushX -= normalX * half
        b.pushY -= normalY * half
      }
    }

    // ---- Pass 4: apply. The only pass that touches the world. -------------
    for (let i = 0; i < stepCount; i += 1) {
      const unit = steps[i]
      if (unit === undefined) continue
      const entity = world.get(unit.id)
      if (entity === undefined) continue
      let pushX = unit.pushX
      let pushY = unit.pushY
      // A man in a crowd collects a push from everyone around him, and the sum
      // of six of them would teleport him across a corridor in one tick. Capped
      // at the separation radius: enough to clear the man he is standing on, not
      // enough to be a shove.
      const pushLength = Math.hypot(pushX, pushY)
      if (pushLength > separationRadius) {
        pushX = (pushX / pushLength) * separationRadius
        pushY = (pushY / pushLength) * separationRadius
      }
      const nextX = slideX(grid, mask, unit.x, unit.y, unit.moveX + pushX)
      const nextY = slideY(grid, mask, nextX, unit.y, unit.moveY + pushY)
      const moved = nextX !== unit.x || nextY !== unit.y
      // Written back only when they actually changed. The round trip through
      // tile space is not bit-exact — `(w + c) - c` is not `w` in binary
      // floating point — so writing unconditionally would make a stationary
      // squad drift by a rounding error per tick, forever.
      if (nextX !== unit.x) entity.x = toWorldX(nextX)
      if (nextY !== unit.y) entity.z = toWorldZ(nextY)
      entity.state = moved ? STATE_MOVING : STATE_IDLE
    }
  }

  Object.defineProperty(squadSystem, 'detachmentCount', {
    get: (): number => detachments.length,
  })
  // One assertion, and it is sound in the direction that matters: `SquadSystem`
  // is assignable to what `Object.assign` returns here — it has the call
  // signature and all three methods — and the property the returned type is
  // missing is the accessor defined immediately above, which a data-property
  // spread could not have carried anyway (`Object.assign` would have copied the
  // getter's value once and frozen the count at zero).
  return Object.assign(squadSystem, { order, halt, leaderOf, targetOf }) as SquadSystem
}
