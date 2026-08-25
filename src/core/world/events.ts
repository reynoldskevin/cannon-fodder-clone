/**
 * The `SimEvent` bus — "the single channel from sim to presentation"
 * (ARCHITECTURE.md).
 *
 * FX, audio and the HUD are driven from this and from nothing else. The sim
 * never calls into presentation and presentation never reads sim internals, so
 * two properties here are contracts rather than conveniences:
 *
 *   - ORDER. Events come out in emission order, which is a pure function of the
 *     simulation. If ordering depended on who subscribed first, a `UnitDied`
 *     could precede the `ShotFired` that caused it and the death FX would play
 *     before the muzzle flash.
 *   - EXACTLY-ONCE DRAIN. Presentation consumes each batch once. Delivered
 *     twice is two explosions from one grenade; delivered zero times is a
 *     silent death.
 *
 * There is deliberately no subscribe/publish machinery. A callback list would
 * let a listener re-enter the sim mid-tick and would make delivery order depend
 * on registration order; a drained buffer cannot.
 */

import type { Team } from './world'

/**
 * Weapon identifier. An open enum, like level tile ids and objective types:
 * adding a weapon must not require touching this union.
 */
export type Weapon = string

/**
 * Fields the bus stamps onto every event. Presentation reads `tick` to place an
 * effect on the simulation timeline (not the render clock, which runs at a
 * different rate) and `seq` to order or de-duplicate across a tick boundary.
 */
interface EventStamp {
  /** The simulation tick during which the event was emitted. */
  readonly tick: number
  /** Strictly increasing across the whole mission — a total order, never reset. */
  readonly seq: number
}

/** An entity entered the simulation. */
export interface UnitSpawnedEvent extends EventStamp {
  readonly type: 'UnitSpawned'
  readonly id: number
  readonly kind: string
  readonly team: Team
  readonly x: number
  readonly z: number
}

/**
 * An entity left the simulation. Distinct from `UnitDied`: a death is a
 * narrative fact that wants a ragdoll and a kill-feed line, a despawn is the
 * bookkeeping that follows it (and also covers extraction and cleanup, which
 * want neither).
 */
export interface UnitDespawnedEvent extends EventStamp {
  readonly type: 'UnitDespawned'
  readonly id: number
}

/** An entity was killed. */
export interface UnitDiedEvent extends EventStamp {
  readonly type: 'UnitDied'
  readonly id: number
  readonly team: Team
  /** `null` when no killer is attributable — falling damage, scripted death. */
  readonly killerId: number | null
  readonly friendlyFire: boolean
}

/** A shot was resolved. Carries both endpoints so FX needs no world lookup. */
export interface ShotFiredEvent extends EventStamp {
  readonly type: 'ShotFired'
  readonly shooterId: number
  /** `null` for suppressing fire and misses aimed at a position, not a unit. */
  readonly targetId: number | null
  readonly weapon: Weapon
  readonly originX: number
  readonly originZ: number
  readonly targetX: number
  readonly targetZ: number
}

/** An objective was satisfied. `objective` is the open-enum `LevelObjective.type`. */
export interface MissionCompleteEvent extends EventStamp {
  readonly type: 'MissionComplete'
  readonly objective: string
}

/** The mission was lost. */
export interface MissionFailedEvent extends EventStamp {
  readonly type: 'MissionFailed'
  readonly reason: string
}

/** Everything the simulation can tell presentation. Discriminated on `type`. */
export type SimEvent =
  | UnitSpawnedEvent
  | UnitDespawnedEvent
  | UnitDiedEvent
  | ShotFiredEvent
  | MissionCompleteEvent
  | MissionFailedEvent

/**
 * Strip the bus-owned stamp from every member of the union.
 *
 * Written as a distributive conditional rather than a bare
 * `Omit<SimEvent, 'tick' | 'seq'>`: `Omit` over a union collapses it into one
 * object type with a widened `type: string`, which destroys the discrimination
 * and lets a caller emit a `ShotFired` carrying a `MissionFailed` payload.
 */
type Unstamped<T> = T extends unknown ? Omit<T, 'tick' | 'seq'> : never

/** What an emitter supplies: the payload, without the bus's stamp. */
export type SimEventInput = Unstamped<SimEvent>

/**
 * The batch handed back when a tick produced nothing.
 *
 * Most ticks are silent. Returning a fresh `[]` from each of them is 60
 * throwaway arrays a second to say "nothing happened", which is exactly the
 * per-tick allocation the acceptance criteria forbid. Frozen so a consumer that
 * mistakes it for its own buffer fails loudly instead of poisoning every later
 * empty drain.
 */
export const EMPTY_EVENTS: readonly SimEvent[] = Object.freeze([] as SimEvent[])

/**
 * An ordered, drained-per-tick queue of `SimEvent`s.
 *
 * One instance per `World`. Nothing module-level lives here: a shared bus (or a
 * shared sequence counter) would make one world's event stream depend on
 * whether another world happened to exist, which is the determinism failure
 * that is hardest to reproduce.
 */
export class EventBus {
  /** The live buffer. Reused across drains rather than reallocated. */
  private readonly buffer: SimEvent[] = []
  private currentTick = 0
  private nextSeq = 0

  /** How many events are waiting to be drained. */
  get pending(): number {
    return this.buffer.length
  }

  /**
   * The `seq` the next emission will carry.
   *
   * Exposed for `World.stateHash`, which must distinguish two worlds whose next
   * event will be numbered differently — they have emitted different numbers of
   * events over the mission and are genuinely diverged, even if their live
   * entities happen to match. Unlike `pending`, this is monotonic mission state
   * and never changes when presentation drains, so folding it into a state hash
   * cannot make the hash depend on drain frequency.
   */
  get nextSequence(): number {
    return this.nextSeq
  }

  /**
   * Set the tick that subsequent emissions are stamped with. Called once by
   * `World.tick()`; the value carries forward until it is changed, so an event
   * emitted outside a tick (a spawn during mission setup) still gets a coherent
   * timestamp rather than `undefined`.
   */
  beginTick(tick: number): void {
    this.currentTick = tick
  }

  /**
   * Queue an event and return it stamped, so the caller can reference the same
   * object it just emitted (for a log line, or to correlate a shot with the
   * death it later causes) without fishing it back out of the drain.
   */
  emit(event: SimEventInput): SimEvent {
    const stamped = { ...event, tick: this.currentTick, seq: this.nextSeq } as SimEvent
    this.nextSeq += 1
    this.buffer.push(stamped)
    return stamped
  }

  /**
   * Everything queued since the last drain, in emission order, WITHOUT
   * consuming it.
   *
   * The read half of the bus, for a simulation system that must learn what
   * happened this tick and must not take it: draining is presentation's
   * business and exactly-once, so a system that drained for itself would
   * silently starve the HUD, FX and audio of whatever it swallowed. Reading
   * cannot, because it removes nothing.
   *
   * This is NOT the subscribe/publish machinery the header rules out. It is a
   * pull, made at a moment of the reader's choosing, so no callback re-enters
   * the sim mid-emit and delivery order still depends on emission alone.
   *
   * THE LIVE BUFFER, NOT A COPY — the same bargain `World.entities` makes, and
   * for the same reason: this is read once per tick per reader and a defensive
   * copy would be 60 throwaway arrays a second. A caller must read it and let
   * go, never hold it across a drain, and must track how far it has already
   * read (by `seq`) rather than assuming a batch is new: two ticks with no
   * drain between them see the earlier tick's events again.
   */
  peek(): readonly SimEvent[] {
    return this.buffer
  }

  /**
   * Take everything queued since the last drain, in emission order, and empty
   * the bus.
   *
   * The returned array is a snapshot, not the live buffer: presentation may
   * hold a batch across a frame, and if it held the bus's own array then next
   * tick's events would appear retroactively inside last tick's batch and be
   * replayed.
   */
  drain(): readonly SimEvent[] {
    if (this.buffer.length === 0) return EMPTY_EVENTS
    const batch = this.buffer.slice()
    this.buffer.length = 0
    return batch
  }
}
