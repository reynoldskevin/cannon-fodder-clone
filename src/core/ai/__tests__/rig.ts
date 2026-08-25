/**
 * Shared fixture for the ticket 012 AI tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 *
 * THE WHOLE STACK, NOT A MOCK OF IT. The AI is a coordinator — its entire job is
 * deciding which of two existing systems to drive this tick — so a rig that
 * handed it fake `squad` and `combat` objects would assert only that the machine
 * calls the methods this rig was written to expect. It would pass with the
 * arguments in the wrong order, with a tile passed where a world point belongs,
 * and with a fire order aimed at nothing. The real `SquadSystem` and the real
 * `CombatSystem` are cheap here (no engine, no clock) and they are the two
 * things most likely to disagree with the machine about what a coordinate means.
 *
 * `spy` exists for the small number of claims that ARE about the calls rather
 * than their effect — "does not re-order every tick", "never touches a player
 * unit" — and it wraps the real systems rather than replacing them.
 */

import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { createCombatSystem } from '../../combat'
import { createSquadSystem } from '../../squad'
import { tileToWorld, worldToTile } from '../../view/projection'
import { World } from '../../world/world'
import { createAiSystem } from '../index'
import type { AiOptions, AiSystem } from '../index'
import type { CombatSystem } from '../../combat'
import type { SquadSystem } from '../../squad'
import type { Entity, Team } from '../../world/world'
import type { SimEvent } from '../../world/events'
import type { TileCoord } from '../../view/projection'

/** Twenty by ten, all open. Wide enough that 12 tiles of sight fits inside it. */
export const OPEN = `
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

/** A full-height wall at x=8, so a sightline across it is blocked everywhere. */
export const WALLED = `
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
  ........#...........
`

/** Every call the AI made into the systems it drives, in order. */
export interface Spy {
  readonly orders: { unitIds: readonly number[]; target: TileCoord }[]
  readonly halts: number[][]
  readonly fires: { unitIds: readonly number[]; target: TileCoord }[]
  readonly ceases: number[][]
}

export interface Rig {
  readonly world: World
  readonly ai: AiSystem
  readonly squad: SquadSystem
  readonly combat: CombatSystem
  readonly spy: Spy
  /** Spawn at a tile CENTRE. `health` defaults to the archetype's one hit point. */
  spawn(tileX: number, tileY: number, team: Team, health?: number): Entity
  /** Run whole ticks, returning every event they emitted. */
  run(ticks: number): SimEvent[]
  /** Where this entity now stands, in tile space. */
  tileOf(id: number): TileCoord
  /**
   * Put an entity somewhere, as if it had walked there.
   *
   * FRACTIONAL TILES ARE ALLOWED AND ONE TEST DEPENDS ON IT. A unit mid-stride
   * is not standing on a tile centre, and the whole-number case turns out to be
   * the one case that cannot detect a half-tile error in the world-to-tile
   * conversion — `clearFractionAlong` floors both endpoints, and at a centre the
   * right spelling and the wrong one floor to the same tile. See "the half-tile
   * convention" in `engagement.test.ts`.
   */
  place(id: number, tileX: number, tileY: number): void
  /** A `ShotFired` as the session would hand it to `hear`, fired FROM a tile. */
  shotAt(tileX: number, tileY: number, shooterId?: number): SimEvent
}

export function rig(art = OPEN, options: Partial<AiOptions> = {}): Rig {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const squad = createSquadSystem(grid, {})
  // NOT `['enemy']`. The AI decides when the enemy shoots, and auto-engage
  // deciding it too would make every firing assertion below pass whether or not
  // the state machine ever reached `engage`.
  const combat = createCombatSystem(grid, { autoEngageTeams: [] })

  const spy: Spy = { orders: [], halts: [], fires: [], ceases: [] }
  const watchedSquad = watchSquad(squad, spy)
  const watchedCombat = watchCombat(combat, spy)

  const ai = createAiSystem(grid, {
    ...options,
    squad: watchedSquad,
    combat: watchedCombat,
  })

  // AI first: a pursue order given this tick must move the man this tick, and a
  // halt must land before the movement it is cancelling. Combat last, so a unit
  // shoots from where it now stands. This is the order the session uses.
  world.addSystem(ai)
  world.addSystem(squad)
  world.addSystem(combat)
  world.drainEvents()

  return {
    world,
    ai,
    squad,
    combat,
    spy,
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
        const batch = world.drainEvents()
        // Exactly what the session does, and in the same place: the bus is
        // drained once, by the caller, and the AI is TOLD. An enemy therefore
        // hears a shot on the tick after it was fired.
        ai.hear(batch)
        events.push(...batch)
      }
      return events
    },
    tileOf(id) {
      const e = world.get(id)
      if (e === undefined) throw new Error(`no entity ${id}`)
      return worldToTile(e.x, e.z, level.size)
    },
    place(id, tileX, tileY) {
      const e = world.get(id)
      if (e === undefined) throw new Error(`no entity ${id}`)
      const p = tileToWorld(tileX, tileY, level.size)
      e.x = p.x
      e.z = p.z
    },
    shotAt(tileX, tileY, shooterId = -1) {
      const p = tileToWorld(tileX, tileY, level.size)
      return {
        type: 'ShotFired',
        tick: 0,
        seq: 0,
        shooterId,
        targetId: null,
        weapon: 'rifle',
        originX: p.x,
        originZ: p.z,
        targetX: p.x,
        targetZ: p.z,
      }
    },
  }
}

/** The real squad system, with every AI call recorded on the way through. */
function watchSquad(squad: SquadSystem, spy: Spy): SquadSystem {
  const wrapper = (world: World): void => {
    squad(world)
  }
  return Object.assign(wrapper, {
    order(unitIds: readonly number[], target: TileCoord): void {
      spy.orders.push({ unitIds: [...unitIds], target })
      squad.order(unitIds, target)
    },
    halt(unitIds: readonly number[]): void {
      spy.halts.push([...unitIds])
      squad.halt(unitIds)
    },
    leaderOf: (id: number) => squad.leaderOf(id),
    targetOf: (id: number) => squad.targetOf(id),
    get detachmentCount(): number {
      return squad.detachmentCount
    },
  }) as SquadSystem
}

/** The real combat system, with every AI call recorded on the way through. */
function watchCombat(combat: CombatSystem, spy: Spy): CombatSystem {
  const wrapper = (world: World): void => {
    combat(world)
  }
  return Object.assign(wrapper, {
    orderFire(unitIds: readonly number[], target: TileCoord): void {
      spy.fires.push({ unitIds: [...unitIds], target })
      combat.orderFire(unitIds, target)
    },
    ceaseFire(unitIds: readonly number[]): void {
      spy.ceases.push([...unitIds])
      combat.ceaseFire(unitIds)
    },
    isFiring: (id: number) => combat.isFiring(id),
  }) as CombatSystem
}

/** Only the shots, which is what nearly every assertion here is counting. */
export const shots = (events: readonly SimEvent[]): SimEvent[] =>
  events.filter((e) => e.type === 'ShotFired')

/** Shots fired BY this unit. */
export const shotsBy = (events: readonly SimEvent[], id: number): SimEvent[] =>
  events.filter((e) => e.type === 'ShotFired' && e.shooterId === id)
