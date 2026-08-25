/**
 * The simulation's mutable state and its tick (ticket 005).
 *
 * `World` owns every entity and is the only thing that advances time. It is
 * engine-free by construction: no `three`, no DOM, no clock read, no
 * `Math.random()`. Everything non-deterministic is injected — the seed at
 * construction, real elapsed time via `GameLoop` in `app/` — which is what lets
 * a whole mission be replayed from a seed and a command list.
 *
 * Three decisions here are load-bearing rather than incidental:
 *
 *   - IDS ARE NEVER REUSED within a mission. The renderer keys instance
 *     matching, animation phase and facing memory on entity id (ticket 010),
 *     and `SimEvent`s reference ids after the entity is gone. Reissuing a dead
 *     soldier's id to the next spawn makes a corpse's death FX follow a live
 *     recruit around the map.
 *   - ITERATION ORDER IS SPAWN ORDER, ALWAYS. Systems iterate `entities`; if
 *     the order varied — a `Map` re-bucketing, a sort by distance — so would
 *     every result computed from it, and the determinism guarantee above it
 *     would fail intermittently, which is the worst way for it to fail.
 *   - THE TICK ALLOCATES NOTHING at steady state. 60 ticks a second for a
 *     five-minute mission is 18000 opportunities to hand the nursery a fresh
 *     array of entities for no reason. `entities` is the live array, not a
 *     defensive copy, and a silent tick drains the shared `EMPTY_EVENTS`.
 */

import { EventBus } from './events'
import { createRng } from './prng'
import type { SimEvent, SimEventInput } from './events'
import type { Rng } from './prng'
import type { LevelData } from '../level/types'
import { tileToWorld } from '../view/projection'

/** Which side an entity fights for. Closed: the whole sim branches on it. */
export type Team = 'player' | 'enemy'

/**
 * What an entity is currently doing. An open enum, like level tile ids and
 * objective types: tickets 007/011/012 add `'moving'`, `'firing'`, `'dying'`
 * and more, and none of them should need to widen a union here to do it.
 */
export type EntityState = string

/**
 * One simulated thing.
 *
 * Position is flat `x`/`z` numbers rather than a `pos` object, for two reasons:
 * it matches `RenderEntity` in `core/render-state/entity.ts` so the render-state
 * builder is a field copy rather than a reshape, and it keeps movement a pair of
 * in-place number writes instead of a fresh vector per entity per tick.
 *
 * `id`, `kind` and `team` are readonly because nothing in the design changes
 * them and the renderer caches on all three; the rest are hot mutable state.
 */
export interface Entity {
  /** Unique within the mission, never reused. */
  readonly id: number
  /** Archetype: `'rifleman'`, `'rocket-trooper'`, ... Open enum. */
  readonly kind: string
  readonly team: Team
  /** World position on the ground plane (y-up world, XZ ground — see `core/view/projection`). */
  x: number
  z: number
  health: number
  state: EntityState
}

/**
 * What a caller supplies to `spawn`. `health` and `state` are optional because
 * most spawns want the archetype default, but they are *defaulted*, never left
 * undefined: an entity with `health: undefined` fails every comparison silently
 * and would be immortal.
 */
export interface SpawnSpec {
  readonly kind: string
  readonly team: Team
  readonly x: number
  readonly z: number
  readonly health?: number
  readonly state?: EntityState
}

/**
 * A simulation system: one pass over the world, once per tick.
 *
 * This is the seam the rest of the sim plugs into — pathing (006), squad
 * command (007), combat (011) and AI (012) each register one. A plain function
 * rather than a class or an interface with a `name`: registration order is the
 * only thing that distinguishes them, and anything richer invites systems to
 * acquire lifecycle hooks and hidden inter-system state.
 */
export type SimSystem = (world: World) => void

/** Health an entity gets when the spawn does not say. */
const DEFAULT_HEALTH = 100

/** State an entity starts in when the spawn does not say. */
const DEFAULT_STATE: EntityState = 'idle'

/** Archetype assumed for a level spawn point that omits `type`. */
const DEFAULT_KIND = 'rifleman'

// ---------------------------------------------------------------------------
// State hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the whole entity set, used to compare two runs cheaply.
 *
 * Scratch views, module-level and reused, so hashing a 40-entity world does not
 * allocate 40 typed arrays. Safe to share: each `hashFloat` writes then reads
 * within a single synchronous call, and `core/` is single-threaded by
 * construction.
 */
const FLOAT_SCRATCH = new Float64Array(1)
const FLOAT_WORDS = new Uint32Array(FLOAT_SCRATCH.buffer)

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

const hashUint32 = (hash: number, value: number): number => {
  let h = hash
  h = Math.imul(h ^ (value & 0xff), FNV_PRIME)
  h = Math.imul(h ^ ((value >>> 8) & 0xff), FNV_PRIME)
  h = Math.imul(h ^ ((value >>> 16) & 0xff), FNV_PRIME)
  h = Math.imul(h ^ ((value >>> 24) & 0xff), FNV_PRIME)
  return h >>> 0
}

/**
 * Hash a float by its BITS, not by a rounded decimal.
 *
 * Positions are continuous and drift by fractions of a tile per tick, so a hash
 * that quantised to, say, three decimals would report two diverged runs as
 * identical for hundreds of ticks before the error grew past the quantum —
 * which is precisely the case the determinism tests exist to catch, arriving
 * late and blamed on the wrong system.
 */
const hashFloat = (hash: number, value: number): number => {
  FLOAT_SCRATCH[0] = value
  return hashUint32(hashUint32(hash, FLOAT_WORDS[0] ?? 0), FLOAT_WORDS[1] ?? 0)
}

const hashString = (hash: number, value: string): number => {
  let h = hash
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), FNV_PRIME)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Everything needed to build a reproducible world. */
export interface WorldOptions {
  /** The mission seed. The same seed, level and commands replay identically. */
  readonly seed: number
}

export class World {
  /** The level this world simulates. Held by reference; never mutated. */
  readonly level: LevelData

  /**
   * The mission's random source. Public because systems draw from it directly:
   * routing every draw through a `World` method would be a wrapper that adds
   * nothing, and a system that wants an independent stream calls `rng.fork()`.
   */
  readonly rng: Rng

  /**
   * The live entity array, in spawn order.
   *
   * Handed out as-is. A per-tick defensive copy would be 60 array allocations a
   * second to protect a value that systems are not permitted to structurally
   * modify anyway — `readonly Entity[]` says so at the type level, and the
   * entities themselves are deliberately mutable because that is where movement
   * and damage land.
   */
  private readonly liveEntities: Entity[] = []

  /** id -> entity, for O(1) lookup by the ids that events and the renderer carry. */
  private readonly byId = new Map<number, Entity>()

  private readonly bus = new EventBus()

  private readonly systems: SimSystem[] = []

  /**
   * Monotonic id source. Never decremented, never scanned for a free slot: a
   * free-list would reuse a dead entity's id, which is the one thing entity ids
   * must never do.
   */
  private nextId = 1

  private ticks = 0

  constructor(level: LevelData, options: WorldOptions) {
    this.level = level
    this.rng = createRng(options.seed)
  }

  /**
   * Entities in spawn order. Stable reference across ticks.
   *
   * THIS IS THE LIVE ARRAY, NOT A COPY, and `despawn` compacts it immediately.
   * So this loop is WRONG and fails silently:
   *
   *     for (const e of world.entities) { ...; world.despawn(e.id) }
   *
   * Removing an element shifts every later one down by one while the array
   * iterator's cursor keeps climbing, so each removal skips the entity that
   * takes the vacated slot. Over six entities that visits 1, 3 and 5 and never
   * sees 2, 4 or 6. It does not throw and it is perfectly deterministic, so it
   * survives every determinism test in this ticket and surfaces later as
   * "sometimes an enemy just doesn't shoot".
   *
   * Three ways to write it correctly. In rough order of preference:
   *
   *   - `world.forEachEntity(e => ...)` — removal-safe, forward order, and it
   *     allocates nothing, so it is the right default for a per-tick system.
   *   - Two passes: decide in a read-only pass, then act. Combat wants this
   *     anyway, so that simultaneous deaths resolve against the same snapshot
   *     rather than against a world half-updated by earlier iterations.
   *   - `for (const e of [...world.entities])` — a snapshot. Correct and
   *     obvious, but it allocates an array per tick, so keep it to tests and
   *     cold paths (the determinism fixture uses exactly this).
   */
  get entities(): readonly Entity[] {
    return this.liveEntities
  }

  /**
   * Visit every live entity in spawn order, tolerating removals made by the
   * visitor itself.
   *
   * The safe counterpart to iterating `entities` directly, and the reason it can
   * be safe without a defensive copy: `liveEntities` is always sorted ascending
   * by id (ids only increase, and both `push` and `despawn`'s compaction
   * preserve relative order), so "not yet visited" is exactly "id greater than
   * the last id visited". A removal can only move an entity to a LOWER index,
   * never a higher one, so re-finding that entity is a short walk from where the
   * cursor already is. No iterator object, no copy, no per-entity allocation.
   *
   * An entity spawned during the walk has the highest id yet issued and is
   * therefore visited before the walk ends. An entity despawned before its turn
   * is simply never visited, which is the intended reading of "it is gone".
   */
  forEachEntity(visit: (entity: Entity) => void): void {
    const list = this.liveEntities
    let cursor = 0
    let visitedId = 0
    for (;;) {
      // Walk back over anything a removal shifted down past the cursor.
      while (cursor > 0) {
        const previous = list[cursor - 1]
        if (previous === undefined || previous.id <= visitedId) break
        cursor -= 1
      }
      // Then forward over everything already seen (normally exactly one step).
      while (cursor < list.length) {
        const candidate = list[cursor]
        if (candidate === undefined || candidate.id > visitedId) break
        cursor += 1
      }
      const entity = list[cursor]
      if (entity === undefined) return
      visitedId = entity.id
      visit(entity)
    }
  }

  get entityCount(): number {
    return this.liveEntities.length
  }

  /** Simulation steps elapsed. The sim's clock; nothing here reads wall time. */
  get tickCount(): number {
    return this.ticks
  }

  /** The entity with this id, or `undefined` if it is gone. */
  get(id: number): Entity | undefined {
    return this.byId.get(id)
  }

  /**
   * Whether an id still refers to a live entity. Because ids are never reused,
   * a `false` here is permanent — a stale id can never start resolving again.
   */
  isAlive(id: number): boolean {
    return this.byId.has(id)
  }

  /** Register a system. Systems run in registration order, once per tick. */
  addSystem(system: SimSystem): void {
    this.systems.push(system)
  }

  /** Queue an event for presentation. The only channel out of the sim. */
  emit(event: SimEventInput): SimEvent {
    return this.bus.emit(event)
  }

  /**
   * Take this batch of events and empty the bus.
   *
   * Draining is presentation's business and must not feed back into the
   * simulation: a dropped frame that skips a drain simply means a larger batch
   * next time, never a different mission.
   */
  drainEvents(): readonly SimEvent[] {
    return this.bus.drain()
  }

  /** Add an entity and announce it. */
  spawn(spec: SpawnSpec): Entity {
    const entity: Entity = {
      id: this.nextId,
      kind: spec.kind,
      team: spec.team,
      x: spec.x,
      z: spec.z,
      health: spec.health ?? DEFAULT_HEALTH,
      state: spec.state ?? DEFAULT_STATE,
    }
    this.nextId += 1
    this.liveEntities.push(entity)
    this.byId.set(entity.id, entity)
    this.bus.emit({
      type: 'UnitSpawned',
      id: entity.id,
      kind: entity.kind,
      team: entity.team,
      x: entity.x,
      z: entity.z,
    })
    return entity
  }

  /**
   * Remove an entity. Returns whether anything was removed, so a caller can
   * tell "I killed it" from "it was already gone" — the difference between one
   * death event and two.
   *
   * Note this emits `UnitDespawned` only. Whether a removal was a *death* is a
   * judgement the combat system makes, and it emits `UnitDied` itself with the
   * killer and friendly-fire detail that only it knows.
   *
   * REMOVAL IS IMMEDIATE AND MUTATES THE ARRAY `entities` HANDS OUT. Calling
   * this from inside `for (const e of world.entities)` silently skips the
   * entity that slides into the vacated slot — see the hazard note on the
   * `entities` getter for the failure and the three correct alternatives. Use
   * `forEachEntity`, or decide in one pass and remove in the next.
   *
   * (Immediate rather than deferred is a fixed contract, not an oversight:
   * `get`, `isAlive` and `entityCount` must all agree the instant this returns,
   * so a caller can never act on an entity the world has already written off. A
   * deferred-removal queue would buy safe live iteration at the price of a
   * window in which a dead entity still answers `isAlive`, which is the worse
   * bug of the two — it is invisible to the code that has to handle it.)
   */
  despawn(id: number): boolean {
    const entity = this.byId.get(id)
    if (entity === undefined) return false
    this.byId.delete(id)

    // Compact in place rather than `splice`. Order must survive a removal from
    // the middle (it is the iteration order every system depends on), and
    // `splice` allocates an array of the removed elements that nothing reads.
    const list = this.liveEntities
    let write = 0
    for (let read = 0; read < list.length; read += 1) {
      const current = list[read]
      if (current === undefined || current.id === id) continue
      list[write] = current
      write += 1
    }
    list.length = write

    this.bus.emit({ type: 'UnitDespawned', id })
    return true
  }

  /**
   * Populate the world from the level's spawn points.
   *
   * Only `avatars` and `enemies` become entities. `props` (shrubs, trees,
   * birds) and `chests` are scenery and pickups: they are drawn and collided
   * with, not simulated as combatants, and putting them in `entities` would put
   * a tree through the AI's target list every tick.
   *
   * Order is avatars then enemies, each in level order, so two worlds built
   * from the same document assign the same ids to the same units.
   */
  spawnFromLevel(): void {
    const { size, spawns } = this.level
    for (const point of spawns.avatars) {
      const where = tileToWorld(point.x, point.y, size)
      this.spawn({ kind: point.type ?? DEFAULT_KIND, team: 'player', x: where.x, z: where.z })
    }
    for (const point of spawns.enemies) {
      const where = tileToWorld(point.x, point.y, size)
      this.spawn({ kind: point.type ?? DEFAULT_KIND, team: 'enemy', x: where.x, z: where.z })
    }
  }

  /**
   * Advance exactly one fixed step.
   *
   * The tick number is incremented BEFORE systems run, so the first tick is 1
   * and every event a system emits is stamped with the tick that produced it
   * rather than the one that preceded it.
   *
   * Indexed loop, not `for...of`: this is the hot path, and the array iterator
   * is per-tick garbage for a list that changes once at startup.
   */
  tick(): void {
    this.ticks += 1
    this.bus.beginTick(this.ticks)
    const systems = this.systems
    for (let i = 0; i < systems.length; i += 1) {
      const system = systems[i]
      if (system !== undefined) system(this)
    }
  }

  /**
   * A cheap fingerprint of the whole simulation state.
   *
   * Exists for the determinism guarantee: comparing two runs entity-by-entity
   * is unreadable in a failure message and unaffordable tick-by-tick, whereas
   * two integers either match or they do not. It is a pure read — notably it
   * does not draw from `rng` — because an observer that perturbed the system
   * would make "the run diverges only when you watch it" a real possibility.
   *
   * WHAT IS IN, and why each is not optional. Everything here is state that a
   * future tick can read, so two worlds differing in any of it are diverged
   * even when their visible entities match exactly:
   *
   *   - `ticks`, and every field of every entity. The obvious part.
   *   - The rng position. Two worlds with identical entities standing at
   *     different points in their streams are one draw from diverging.
   *   - `nextId`. A world that spawned and despawned a scout has the same live
   *     entities as one that never did, but its next spawn takes a different
   *     id — and ids are what the renderer and every event reference.
   *   - The bus's next sequence number, for the same reason one step further
   *     out: the next event either is or is not numbered the same.
   *
   * WHAT IS OUT: the pending event buffer. Its length depends on how recently
   * presentation drained, which is a frame-rate accident and must never reach
   * the hash — `nextSequence` gives the same information without that coupling.
   */
  stateHash(): number {
    let h = FNV_OFFSET_BASIS
    h = hashUint32(h, this.ticks)
    h = hashUint32(h, this.rng.getState())
    h = hashUint32(h, this.nextId)
    h = hashUint32(h, this.bus.nextSequence)
    h = hashUint32(h, this.liveEntities.length)
    const list = this.liveEntities
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i]
      if (e === undefined) continue
      h = hashUint32(h, e.id)
      h = hashString(h, e.kind)
      h = hashString(h, e.team)
      h = hashString(h, e.state)
      h = hashFloat(h, e.x)
      h = hashFloat(h, e.z)
      h = hashFloat(h, e.health)
    }
    return h >>> 0
  }
}
