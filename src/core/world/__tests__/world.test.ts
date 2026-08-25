import { describe, it, expect } from 'vitest'
import { World } from '../world'
import { makeLevel } from './fixture'
import { tileToWorld } from '../../view/projection'

/**
 * Ticket 005 — entity storage and the tick.
 *
 * `World` owns all mutable simulation state. Two things here are contracts
 * rather than conveniences:
 *
 *  - IDS ARE NEVER REUSED within a mission. The renderer keys instance
 *    matching, animation phase and facing memory on entity id (ticket 010), and
 *    `SimEvent`s reference ids after the entity is gone. Reissuing a dead
 *    soldier's id to the next spawn makes a corpse's death FX follow a live
 *    recruit around.
 *  - ITERATION ORDER IS DETERMINISTIC. Systems iterate entities; if the order
 *    varies, so do the results, and every determinism guarantee above it fails.
 */

describe('World', () => {
  describe('construction', () => {
    it('starts with no entities and no elapsed ticks', () => {
      const w = new World(makeLevel(), { seed: 1 })
      expect(w.entityCount).toBe(0)
      expect(w.tickCount).toBe(0)
    })

    it('exposes the level it was built from', () => {
      const level = makeLevel()
      expect(new World(level, { seed: 1 }).level).toBe(level)
    })

    it('exposes a seeded rng', () => {
      const a = new World(makeLevel(), { seed: 42 })
      const b = new World(makeLevel(), { seed: 42 })
      expect(a.rng.next()).toBe(b.rng.next())
    })
  })

  describe('spawn', () => {
    it('returns an entity carrying the requested fields', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 3, z: -4, health: 5 })
      expect(e).toMatchObject({ kind: 'rifleman', team: 'player', x: 3, z: -4, health: 5 })
      expect(e.id).toBeGreaterThan(0)
    })

    it('adds the entity to the live set', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      expect(w.entityCount).toBe(1)
      expect(w.get(e.id)).toBe(e)
      expect(w.entities).toContain(e)
    })

    it('gives every entity a distinct id', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const ids = new Set<number>()
      for (let i = 0; i < 500; i++) {
        ids.add(w.spawn({ kind: 'rifleman', team: 'enemy', x: i, z: 0 }).id)
      }
      expect(ids.size).toBe(500)
    })

    it('defaults health and state rather than leaving them undefined', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      expect(typeof e.health).toBe('number')
      expect(e.health).toBeGreaterThan(0)
      expect(typeof e.state).toBe('string')
    })

    it('emits UnitSpawned', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'enemy', x: 1, z: 2 })
      const events = w.drainEvents()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'UnitSpawned', id: e.id, team: 'enemy' })
    })
  })

  describe('despawn', () => {
    it('removes the entity from the live set', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      expect(w.despawn(e.id)).toBe(true)
      expect(w.entityCount).toBe(0)
      expect(w.get(e.id)).toBeUndefined()
      expect(w.entities).not.toContain(e)
    })

    it('reports false for an unknown id', () => {
      const w = new World(makeLevel(), { seed: 1 })
      expect(w.despawn(9999)).toBe(false)
    })

    it('is idempotent — despawning twice does not double-remove', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const a = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      const b = w.spawn({ kind: 'rifleman', team: 'player', x: 1, z: 0 })
      expect(w.despawn(a.id)).toBe(true)
      expect(w.despawn(a.id)).toBe(false)
      expect(w.entityCount).toBe(1)
      expect(w.get(b.id)).toBe(b)
    })

    it('emits UnitDespawned', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      w.drainEvents()
      w.despawn(e.id)
      expect(w.drainEvents()[0]).toMatchObject({ type: 'UnitDespawned', id: e.id })
    })

    it('emits nothing for an unknown id', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.despawn(4242)
      expect(w.drainEvents()).toHaveLength(0)
    })
  })

  describe('id reuse', () => {
    it('never reissues a despawned entity id', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const seen = new Set<number>()
      for (let i = 0; i < 300; i++) {
        const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
        expect(seen.has(e.id)).toBe(false)
        seen.add(e.id)
        w.despawn(e.id)
      }
      expect(seen.size).toBe(300)
    })

    it('does not reuse ids after churning a mixed population', () => {
      // The realistic shape: spawns and deaths interleaved, never a clean slate.
      const w = new World(makeLevel(), { seed: 1 })
      const seen = new Set<number>()
      const live: number[] = []
      for (let i = 0; i < 400; i++) {
        const e = w.spawn({ kind: 'rifleman', team: i % 2 ? 'player' : 'enemy', x: i, z: 0 })
        expect(seen.has(e.id)).toBe(false)
        seen.add(e.id)
        live.push(e.id)
        if (i % 3 === 0 && live.length > 0) w.despawn(live.shift()!)
      }
      expect(seen.size).toBe(400)
    })

    it('keeps a stale id resolving to nothing rather than to a new entity', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const dead = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      w.despawn(dead.id)
      for (let i = 0; i < 20; i++) w.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0 })
      expect(w.get(dead.id)).toBeUndefined()
      expect(w.isAlive(dead.id)).toBe(false)
    })
  })

  describe('entity iteration', () => {
    it('is stable in spawn order', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const ids = Array.from({ length: 10 }, (_, i) =>
        w.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0 }).id,
      )
      expect(w.entities.map((e) => e.id)).toEqual(ids)
    })

    it('keeps the surviving order after a despawn from the middle', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const ids = Array.from({ length: 6 }, (_, i) =>
        w.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0 }).id,
      )
      w.despawn(ids[2]!)
      const remaining = ids.filter((id) => id !== ids[2])
      expect(w.entities.map((e) => e.id)).toEqual(remaining)
    })

    it('hands out the same array reference across ticks', () => {
      // A defensive copy per tick is 60 array allocations a second for a value
      // nothing is allowed to mutate anyway.
      const w = new World(makeLevel(), { seed: 1 })
      w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      const first = w.entities
      w.tick()
      w.tick()
      expect(w.entities).toBe(first)
    })
  })

  describe('spawnFromLevel', () => {
    it('spawns one entity per avatar and enemy spawn point', () => {
      const level = makeLevel({
        avatars: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
        enemies: [{ x: 9, y: 9 }, { x: 10, y: 9 }],
      })
      const w = new World(level, { seed: 1 })
      w.spawnFromLevel()
      expect(w.entityCount).toBe(5)
      expect(w.entities.filter((e) => e.team === 'player')).toHaveLength(3)
      expect(w.entities.filter((e) => e.team === 'enemy')).toHaveLength(2)
    })

    it('places entities at the world position of their tile', () => {
      const level = makeLevel({ avatars: [{ x: 4, y: 6 }], enemies: [] })
      const w = new World(level, { seed: 1 })
      w.spawnFromLevel()
      const expected = tileToWorld(4, 6, level.size)
      const e = w.entities[0]!
      expect(e.x).toBeCloseTo(expected.x, 9)
      expect(e.z).toBeCloseTo(expected.z, 9)
    })

    it('does not spawn props or chests as combat entities', () => {
      const level = makeLevel({ avatars: [{ x: 1, y: 1 }], enemies: [] })
      const w = new World(level, { seed: 1 })
      w.spawnFromLevel()
      expect(w.entityCount).toBe(1)
    })

    it('is deterministic across two worlds built from the same level', () => {
      const level = makeLevel()
      const a = new World(level, { seed: 3 })
      const b = new World(level, { seed: 3 })
      a.spawnFromLevel()
      b.spawnFromLevel()
      expect(a.entities.map((e) => ({ ...e }))).toEqual(b.entities.map((e) => ({ ...e })))
    })
  })

  describe('tick', () => {
    it('advances the tick count by exactly one', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.tick()
      expect(w.tickCount).toBe(1)
      w.tick()
      expect(w.tickCount).toBe(2)
    })

    it('runs registered systems once per tick, in registration order', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const calls: string[] = []
      w.addSystem(() => calls.push('a'))
      w.addSystem(() => calls.push('b'))
      w.addSystem(() => calls.push('c'))
      w.tick()
      expect(calls).toEqual(['a', 'b', 'c'])
      w.tick()
      expect(calls).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
    })

    it('hands each system the world', () => {
      const w = new World(makeLevel(), { seed: 1 })
      let seen: unknown
      w.addSystem((world) => {
        seen = world
      })
      w.tick()
      expect(seen).toBe(w)
    })

    it('stamps events emitted during a tick with that tick number', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.addSystem((world) => {
        world.emit({ type: 'MissionFailed', reason: 'test' })
      })
      w.tick()
      w.tick()
      const events = w.drainEvents()
      expect(events.map((e) => e.tick)).toEqual([1, 2])
    })

    it('runs no systems when none are registered, and does not throw', () => {
      const w = new World(makeLevel(), { seed: 1 })
      expect(() => {
        w.tick()
      }).not.toThrow()
      expect(w.tickCount).toBe(1)
    })
  })

  describe('drainEvents', () => {
    it('returns events accumulated since the last drain', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 1, z: 0 })
      expect(w.drainEvents()).toHaveLength(2)
      expect(w.drainEvents()).toHaveLength(0)
    })

    it('accumulates across ticks until drained', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.addSystem((world) => {
        world.emit({ type: 'MissionFailed', reason: 'x' })
      })
      w.tick()
      w.tick()
      w.tick()
      expect(w.drainEvents()).toHaveLength(3)
    })
  })

  describe('stateHash', () => {
    it('is stable for an unchanged world', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.spawnFromLevel()
      expect(w.stateHash()).toBe(w.stateHash())
    })

    it('changes when an entity moves', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      const before = w.stateHash()
      e.x += 1
      expect(w.stateHash()).not.toBe(before)
    })

    it('changes when an entity dies', () => {
      const w = new World(makeLevel(), { seed: 1 })
      const e = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 5, z: 5 })
      const before = w.stateHash()
      w.despawn(e.id)
      expect(w.stateHash()).not.toBe(before)
    })

    it('distinguishes two worlds whose entities differ only in health', () => {
      const a = new World(makeLevel(), { seed: 1 })
      const b = new World(makeLevel(), { seed: 1 })
      const ea = a.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0, health: 1 })
      b.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0, health: 1 })
      ea.health = 0
      expect(a.stateHash()).not.toBe(b.stateHash())
    })

    it('agrees between two identically built worlds', () => {
      const level = makeLevel()
      const a = new World(level, { seed: 9 })
      const b = new World(level, { seed: 9 })
      a.spawnFromLevel()
      b.spawnFromLevel()
      expect(a.stateHash()).toBe(b.stateHash())
    })

    it('is a finite integer, so it can be logged and compared cheaply', () => {
      const w = new World(makeLevel(), { seed: 1 })
      w.spawnFromLevel()
      const h = w.stateHash()
      expect(Number.isFinite(h)).toBe(true)
      expect(Number.isInteger(h)).toBe(true)
    })
  })
})
