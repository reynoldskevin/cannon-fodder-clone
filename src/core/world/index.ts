/**
 * The simulation spine (ticket 005): entity storage, the fixed 60 Hz tick, the
 * seeded PRNG and the `SimEvent` bus.
 *
 * This is the public face of `src/core/world`. `app/` builds a `World` and a
 * `GameLoop` and pumps one from the other; `render/` reads `world.entities` and
 * `world.drainEvents()` and nothing else. Everything else in this directory is
 * an implementation detail that later tickets may reshape without touching a
 * caller.
 */

export { createRng } from './prng'
export type { Rng } from './prng'

export { EventBus, EMPTY_EVENTS } from './events'
export type {
  MissionCompleteEvent,
  MissionFailedEvent,
  ShotFiredEvent,
  SimEvent,
  SimEventInput,
  UnitDespawnedEvent,
  UnitDiedEvent,
  UnitSpawnedEvent,
  Weapon,
} from './events'

export { createGameLoop, FIXED_TIMESTEP, MAX_STEPS_PER_FRAME } from './gameloop'
export type { GameLoop } from './gameloop'

export { World } from './world'
export type { Entity, EntityState, SimSystem, SpawnSpec, Team, WorldOptions } from './world'
