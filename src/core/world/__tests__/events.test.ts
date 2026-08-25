import { describe, it, expect } from 'vitest'
import { EventBus, EMPTY_EVENTS } from '../events'
import type { SimEvent } from '../events'

/**
 * Ticket 005 — the SimEvent bus.
 *
 * `ARCHITECTURE.md` calls this "the single channel from sim to presentation".
 * FX, audio and the HUD are all driven from it and nothing else, so two
 * properties are load-bearing:
 *
 *  - ORDER. A `UnitDied` that arrives before the `ShotFired` that caused it
 *    makes the death FX play before the muzzle flash. The bus must impose a
 *    total order that is a pure function of the simulation, not of who happened
 *    to subscribe first.
 *  - DRAIN. Presentation consumes each tick's events exactly once. An event
 *    delivered twice fires two explosions from one grenade; one delivered zero
 *    times is a silent death.
 */

const shot = (shooterId: number): Parameters<EventBus['emit']>[0] => ({
  type: 'ShotFired',
  shooterId,
  targetId: null,
  weapon: 'rifle',
  originX: 0,
  originZ: 0,
  targetX: 1,
  targetZ: 1,
})

describe('EventBus', () => {
  describe('emit and drain', () => {
    it('starts empty', () => {
      const bus = new EventBus()
      expect(bus.pending).toBe(0)
      expect(bus.drain()).toHaveLength(0)
    })

    it('returns emitted events in emission order', () => {
      const bus = new EventBus()
      bus.emit(shot(1))
      bus.emit(shot(2))
      bus.emit(shot(3))
      const drained = bus.drain()
      expect(drained.map((e) => (e.type === 'ShotFired' ? e.shooterId : -1))).toEqual([1, 2, 3])
    })

    it('empties the bus — a second drain yields nothing', () => {
      const bus = new EventBus()
      bus.emit(shot(1))
      expect(bus.drain()).toHaveLength(1)
      expect(bus.drain()).toHaveLength(0)
      expect(bus.pending).toBe(0)
    })

    it('does not deliver the same event twice across ticks', () => {
      const bus = new EventBus()
      bus.beginTick(0)
      bus.emit(shot(1))
      const first = bus.drain()
      bus.beginTick(1)
      bus.emit(shot(2))
      const second = bus.drain()
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(second[0]).not.toEqual(first[0])
    })

    it('tracks pending count as events accumulate', () => {
      const bus = new EventBus()
      expect(bus.pending).toBe(0)
      bus.emit(shot(1))
      expect(bus.pending).toBe(1)
      bus.emit(shot(2))
      expect(bus.pending).toBe(2)
      bus.drain()
      expect(bus.pending).toBe(0)
    })

    it('hands the caller a snapshot that later emissions cannot mutate', () => {
      // FX may hold the drained array across a frame. If drain returns the
      // bus's own live buffer, next tick's events appear retroactively inside
      // last tick's array and get replayed.
      const bus = new EventBus()
      bus.emit(shot(1))
      const drained = bus.drain()
      bus.emit(shot(2))
      bus.emit(shot(3))
      expect(drained).toHaveLength(1)
    })
  })

  describe('stamping', () => {
    it('stamps each event with the current tick', () => {
      const bus = new EventBus()
      bus.beginTick(41)
      bus.emit(shot(1))
      expect(bus.drain()[0]!.tick).toBe(41)
    })

    it('carries the tick forward until it is changed', () => {
      const bus = new EventBus()
      bus.beginTick(7)
      bus.emit(shot(1))
      bus.emit(shot(2))
      const drained = bus.drain()
      expect(drained.map((e) => e.tick)).toEqual([7, 7])
    })

    it('gives every event a strictly increasing sequence number', () => {
      const bus = new EventBus()
      const seqs: number[] = []
      for (let t = 0; t < 5; t++) {
        bus.beginTick(t)
        bus.emit(shot(t))
        bus.emit(shot(t + 100))
        for (const e of bus.drain()) seqs.push(e.seq)
      }
      expect(seqs).toHaveLength(10)
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
      }
    })

    it('does not reset sequence numbers when the tick advances', () => {
      // Sequence is a total order over the whole mission, so a consumer can sort
      // or de-duplicate across a tick boundary.
      const bus = new EventBus()
      bus.beginTick(0)
      bus.emit(shot(1))
      const a = bus.drain()[0]!.seq
      bus.beginTick(1)
      bus.emit(shot(2))
      const b = bus.drain()[0]!.seq
      expect(b).toBeGreaterThan(a)
    })

    it('returns the stamped event from emit, so a caller can reference it', () => {
      const bus = new EventBus()
      bus.beginTick(3)
      const e = bus.emit(shot(9))
      expect(e.tick).toBe(3)
      expect(typeof e.seq).toBe('number')
      expect(e.type).toBe('ShotFired')
    })
  })

  describe('event types', () => {
    it('carries UnitSpawned with identity and position', () => {
      const bus = new EventBus()
      bus.emit({ type: 'UnitSpawned', id: 4, kind: 'rifleman', team: 'player', x: 2, z: -3 })
      const e = bus.drain()[0]!
      expect(e).toMatchObject({ type: 'UnitSpawned', id: 4, kind: 'rifleman', team: 'player' })
    })

    it('carries UnitDied with team, id and killer', () => {
      const bus = new EventBus()
      bus.emit({ type: 'UnitDied', id: 8, team: 'enemy', killerId: 2, friendlyFire: false })
      const e = bus.drain()[0]!
      expect(e).toMatchObject({ type: 'UnitDied', id: 8, team: 'enemy', killerId: 2 })
    })

    it('allows a killerId of null for a death with no attributable killer', () => {
      const bus = new EventBus()
      bus.emit({ type: 'UnitDied', id: 1, team: 'player', killerId: null, friendlyFire: false })
      const e = bus.drain()[0]!
      expect(e.type === 'UnitDied' && e.killerId).toBeNull()
    })

    it('carries MissionComplete and MissionFailed', () => {
      const bus = new EventBus()
      bus.emit({ type: 'MissionComplete', objective: 'kill_all' })
      bus.emit({ type: 'MissionFailed', reason: 'squad_wiped' })
      const types = bus.drain().map((e) => e.type)
      expect(types).toEqual(['MissionComplete', 'MissionFailed'])
    })

    it('discriminates on type — narrowing reaches the payload', () => {
      const bus = new EventBus()
      bus.emit(shot(5))
      const e: SimEvent = bus.drain()[0]!
      if (e.type === 'ShotFired') {
        expect(e.shooterId).toBe(5)
        expect(e.weapon).toBe('rifle')
      } else {
        throw new Error('expected a ShotFired event')
      }
    })
  })

  describe('allocation discipline', () => {
    it('returns one shared empty array when there is nothing to drain', () => {
      // The steady-state tick — most ticks — must not allocate. A fresh [] per
      // tick is 60 throwaway arrays a second for nothing.
      const bus = new EventBus()
      expect(bus.drain()).toBe(EMPTY_EVENTS)
      expect(bus.drain()).toBe(EMPTY_EVENTS)
    })

    it('exposes EMPTY_EVENTS as an empty, frozen array', () => {
      expect(EMPTY_EVENTS).toHaveLength(0)
      expect(Object.isFrozen(EMPTY_EVENTS)).toBe(true)
    })
  })
})
