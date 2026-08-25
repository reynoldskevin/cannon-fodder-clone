import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { makeLevel } from '../../world/__tests__/fixture'
import { bakeNavGrid } from '../../pathing/navgrid'
import { createCombatSystem, WEAPONS, RIFLE } from '../index'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 011 — combat wired into the tick.
 *
 * `createCombatSystem` returns a `SimSystem`, which is the seam ticket 005 built
 * for exactly this. Everything below drives a real `World` rather than calling
 * the pieces directly, because the ticket-010 lesson was that two individually
 * correct, individually tested modules can still be wrong in composition — the
 * `die` animation bug lived in nobody's module and in both.
 *
 * Positions are WORLD coordinates (x/z, ground plane, origin-centred — see
 * `core/view/projection`). The grid is in TILE coordinates. Combat has to cross
 * that boundary, and getting it wrong is invisible on a centred 16x16 fixture
 * unless a test puts a wall in a specific place, which is what the LOS case
 * below does.
 */

function scene(): { world: World; run: (ticks: number) => SimEvent[] } {
  const level = makeLevel({ w: 16, h: 16 })
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  world.addSystem(createCombatSystem(grid))
  return {
    world,
    run(ticks: number): SimEvent[] {
      const events: SimEvent[] = []
      for (let i = 0; i < ticks; i++) {
        world.tick()
        events.push(...world.drainEvents())
      }
      return events
    },
  }
}

describe('createCombatSystem', () => {
  describe('engagement', () => {
    it('fires on an enemy in range with a clear line', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      world.drainEvents()
      const shots = run(1).filter((e) => e.type === 'ShotFired')
      expect(shots.length).toBeGreaterThan(0)
    })

    it('does not fire on a unit of its own team', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'player', x: 3, z: 0 })
      world.drainEvents()
      expect(run(30).filter((e) => e.type === 'ShotFired')).toHaveLength(0)
    })

    it('does not fire on an enemy out of range', () => {
      const { world, run } = scene()
      const far = WEAPONS[RIFLE]!.rangeTiles + 5
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'enemy', x: far, z: 0 })
      world.drainEvents()
      expect(run(30).filter((e) => e.type === 'ShotFired')).toHaveLength(0)
    })

    it('does not fire through a wall', () => {
      const level = makeLevel({ w: 16, h: 16 })
      const world = new World(level, { seed: 1 })
      const grid = bakeNavGrid(level)
      // Wall off the whole column between the two soldiers, in tile space.
      for (let y = 0; y < 16; y++) grid.setPassable(8, y, 0)
      world.addSystem(createCombatSystem(grid))
      // Tiles 6 and 10 straddle the wall. Centred 16x16 => world x = tile - 7.5.
      world.spawn({ kind: 'rifleman', team: 'player', x: 6 - 7.5, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'enemy', x: 10 - 7.5, z: 0 })
      world.drainEvents()
      const events: SimEvent[] = []
      for (let i = 0; i < 30; i++) {
        world.tick()
        events.push(...world.drainEvents())
      }
      expect(events.filter((e) => e.type === 'ShotFired')).toHaveLength(0)
    })

    it('respects the cooldown across ticks', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'jeep', team: 'enemy', x: 3, z: 0, health: 10000 })
      world.drainEvents()
      const spec = WEAPONS[RIFLE]!
      const shots = run(120).filter((e) => e.type === 'ShotFired')
      // One shot per cooldown window, not one per tick.
      expect(shots.length).toBeLessThanOrEqual(Math.ceil(120 / spec.cooldownTicks) + 1)
      expect(shots.length).toBeGreaterThan(1)
    })
  })

  describe('ShotFired payload', () => {
    it('carries shooter, target, weapon and both endpoints', () => {
      const { world, run } = scene()
      const shooter = world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      const target = world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      world.drainEvents()
      const shot = run(1).find((e) => e.type === 'ShotFired')
      expect(shot).toMatchObject({
        type: 'ShotFired',
        shooterId: shooter.id,
        targetId: target.id,
        weapon: RIFLE,
        originX: 0,
        originZ: 0,
        targetX: 3,
        targetZ: 0,
      })
    })

    it('is emitted before the UnitDied it causes', () => {
      // FX plays the muzzle flash and the tracer from ShotFired and the death
      // from UnitDied. Reversed, the soldier falls before the shot is fired.
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      world.drainEvents()
      const types = run(2).map((e) => e.type)
      expect(types.indexOf('ShotFired')).toBeGreaterThanOrEqual(0)
      expect(types.indexOf('ShotFired')).toBeLessThan(types.indexOf('UnitDied'))
    })
  })

  describe('death', () => {
    it('kills the enemy and removes it from the world', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      const target = world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      world.drainEvents()
      run(2)
      expect(world.isAlive(target.id)).toBe(false)
    })

    it('stops firing once every enemy is dead', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      world.drainEvents()
      run(10)
      expect(run(60).filter((e) => e.type === 'ShotFired')).toHaveLength(0)
    })

    it('does not skip a unit when several die in one sweep', () => {
      // The `despawn`-during-iteration hazard ticket 005 documented, in the
      // exact code that was warned about. If the walk skips, some enemies
      // survive a volley that should have killed them and nothing looks wrong.
      const { world, run } = scene()
      for (let i = 0; i < 6; i++) {
        world.spawn({ kind: 'rifleman', team: 'player', x: i * 0.1, z: 0 })
        world.spawn({ kind: 'rifleman', team: 'enemy', x: 2 + i * 0.1, z: 0 })
      }
      world.drainEvents()
      run(30)
      expect(world.entities.filter((e) => e.team === 'enemy')).toHaveLength(0)
    })
  })

  describe('determinism', () => {
    it('two identical worlds produce identical event streams', () => {
      const build = () => {
        const s = scene()
        for (let i = 0; i < 5; i++) {
          s.world.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0, health: 3 })
          s.world.spawn({ kind: 'rifleman', team: 'enemy', x: i, z: 4, health: 3 })
        }
        s.world.drainEvents()
        return s
      }
      const a = build()
      const b = build()
      expect(a.run(200)).toEqual(b.run(200))
    })

    it('produces a substantial event stream, so the comparison is not vacuous', () => {
      const s = scene()
      for (let i = 0; i < 5; i++) {
        s.world.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0, health: 3 })
        s.world.spawn({ kind: 'rifleman', team: 'enemy', x: i, z: 4, health: 3 })
      }
      s.world.drainEvents()
      const events = s.run(200)
      expect(events.length).toBeGreaterThan(10)
      expect(new Set(events.map((e) => e.type)).size).toBeGreaterThan(1)
    })

    it('leaves the world stable once combat resolves', () => {
      // NOT a stateHash comparison across time. `stateHash` folds `ticks` in as
      // its first input, deliberately (ticket 005), so a hash at tick 300 can
      // never equal one at tick 600 no matter how quiet the world is. What
      // "stable" actually means here is that combat stops doing anything: no
      // further events, and the survivors are untouched.
      const s = scene()
      s.world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      s.world.spawn({ kind: 'rifleman', team: 'enemy', x: 3, z: 0 })
      s.run(300)
      const survivors = s.world.entities.map((e) => ({ ...e }))
      expect(s.run(300)).toHaveLength(0)
      expect(s.world.entities.map((e) => ({ ...e }))).toEqual(survivors)
    })
  })

  describe('empty and degenerate worlds', () => {
    it('does nothing in an empty world', () => {
      const { run } = scene()
      expect(run(60)).toHaveLength(0)
    })

    it('does nothing with only one team present', () => {
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.drainEvents()
      expect(run(60)).toHaveLength(0)
    })

    it('does not allocate unboundedly over a long stalemate', () => {
      // Cooldown state is keyed by entity id. Left untended it grows with every
      // unit that ever fired, which over a campaign is a leak.
      const { world, run } = scene()
      world.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      world.spawn({ kind: 'jeep', team: 'enemy', x: 3, z: 0, health: 1e9 })
      run(2000)
      const before = process.memoryUsage().heapUsed
      run(20000)
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(24 * 1024 * 1024)
    })
  })
})
