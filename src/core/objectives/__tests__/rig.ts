/**
 * Shared fixture for the ticket 013 objective tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 *
 * A REAL `World` AND REAL OBJECTIVES, not a fake of either. What an objective
 * system does is read the world and decide whether the mission is over, so a rig
 * that handed it a stub world would be asserting that the system agrees with
 * this file's idea of what "no living enemy" looks like. The world is cheap here
 * — no engine, no clock — and it is the thing the system will actually be wrong
 * about.
 */

import { asciiLevel } from '../../pathing/__tests__/ascii'
import { tileToWorld } from '../../view/projection'
import { World } from '../../world/world'
import { createObjectiveSystem } from '../index'
import type { ObjectiveSystem } from '../index'
import type { LevelData, LevelObjective, SpawnPoint } from '../../level/types'
import type { Entity, Team } from '../../world/world'
import type { SimEvent } from '../../world/events'

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

export interface Rig {
  readonly world: World
  readonly objectives: ObjectiveSystem
  readonly level: LevelData
  spawn(tileX: number, tileY: number, team: Team, health?: number): Entity
  /** Run whole ticks, returning every event they emitted. */
  run(ticks: number): SimEvent[]
  /** Move an entity, as if it had walked there. Fractional tiles allowed. */
  place(id: number, tileX: number, tileY: number): void
  /** Kill an entity the way combat does — despawn, plus the `UnitDied` combat emits. */
  kill(id: number): void
}

export interface RigOptions {
  readonly objectives?: readonly LevelObjective[]
  readonly chests?: readonly SpawnPoint[]
}

export function rig(options: RigOptions = {}): Rig {
  const base = asciiLevel(OPEN)
  const level: LevelData = {
    ...base,
    spawns: { ...base.spawns, chests: options.chests ?? [] },
    objectives: options.objectives ?? [{ type: 'kill_all' }],
  }
  const world = new World(level, { seed: 1 })
  const objectives = createObjectiveSystem(level)
  world.addSystem(objectives)
  world.drainEvents()

  return {
    world,
    objectives,
    level,
    spawn(tileX, tileY, team, health) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn(
        health === undefined
          ? { kind: 'rifleman', team, x: p.x, z: p.z }
          : { kind: 'rifleman', team, x: p.x, z: p.z, health },
      )
    },
    run(ticks) {
      const events: SimEvent[] = []
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        events.push(...world.drainEvents())
      }
      return events
    },
    place(id, tileX, tileY) {
      const e = world.get(id)
      if (e === undefined) throw new Error(`no entity ${id}`)
      const p = tileToWorld(tileX, tileY, level.size)
      e.x = p.x
      e.z = p.z
    },
    kill(id) {
      const e = world.get(id)
      if (e === undefined) throw new Error(`no entity ${id}`)
      const team = e.team
      // The pair `CombatSystem` emits, in the order it emits them. An objective
      // system that counted despawns rather than deaths would pass every test
      // written against `world.despawn` alone and then miscount the first time a
      // unit left the field for any other reason.
      world.emit({ type: 'UnitDied', id, team, killerId: null, friendlyFire: false })
      world.despawn(id)
    },
  }
}

/** Every mission-end event in a batch, which is nearly always what is counted. */
export const endings = (events: readonly SimEvent[]): SimEvent[] =>
  events.filter((e) => e.type === 'MissionComplete' || e.type === 'MissionFailed')
