import { describe, it, expect } from 'vitest'
import { interpolateEntities } from '../interpolation'
import type { EntitySnapshot } from '../interpolation'

/**
 * Ticket 010 — interpolating entity positions between sim ticks.
 *
 * The sim runs at a fixed 60Hz while the display runs at whatever rate it runs
 * at, so the renderer draws somewhere between the previous and current sim
 * state. The cases that matter are the edges: an entity that spawned this tick
 * has no previous state, and one that died has no current state — neither may
 * produce a NaN position or a ghost that never clears.
 */

const snap = (id: number, x: number, z: number): EntitySnapshot => ({ id, x, z })

describe('interpolateEntities', () => {
  it('returns the previous position at alpha 0', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 20)], 0)
    expect(out[0]!.x).toBeCloseTo(0)
    expect(out[0]!.z).toBeCloseTo(0)
  })

  it('returns the current position at alpha 1', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 20)], 1)
    expect(out[0]!.x).toBeCloseTo(10)
    expect(out[0]!.z).toBeCloseTo(20)
  })

  it('returns the midpoint at alpha 0.5', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 20)], 0.5)
    expect(out[0]!.x).toBeCloseTo(5)
    expect(out[0]!.z).toBeCloseTo(10)
  })

  it('interpolates each entity independently', () => {
    const prev = [snap(1, 0, 0), snap(2, 100, 0)]
    const cur = [snap(1, 10, 0), snap(2, 90, 0)]
    const out = interpolateEntities(prev, cur, 0.5)
    expect(out.find((e) => e.id === 1)!.x).toBeCloseTo(5)
    expect(out.find((e) => e.id === 2)!.x).toBeCloseTo(95)
  })

  it('matches entities by id, not by array position', () => {
    const prev = [snap(1, 0, 0), snap(2, 100, 0)]
    const cur = [snap(2, 90, 0), snap(1, 10, 0)] // reordered
    const out = interpolateEntities(prev, cur, 0.5)
    expect(out.find((e) => e.id === 1)!.x).toBeCloseTo(5)
    expect(out.find((e) => e.id === 2)!.x).toBeCloseTo(95)
  })
})

describe('entities appearing and vanishing', () => {
  it('draws a newly spawned entity at its current position, not halfway from nowhere', () => {
    const out = interpolateEntities([], [snap(1, 10, 20)], 0.5)
    expect(out).toHaveLength(1)
    expect(out[0]!.x).toBeCloseTo(10)
    expect(out[0]!.z).toBeCloseTo(20)
  })

  it('drops an entity that no longer exists — no ghosts', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [], 0.5)
    expect(out).toHaveLength(0)
  })

  it('handles a mix of spawned, persisting and despawned in one step', () => {
    const prev = [snap(1, 0, 0), snap(2, 0, 0)]
    const cur = [snap(2, 10, 0), snap(3, 50, 50)]
    const out = interpolateEntities(prev, cur, 0.5)
    expect(out.map((e) => e.id).sort()).toEqual([2, 3])
    expect(out.find((e) => e.id === 2)!.x).toBeCloseTo(5)
    expect(out.find((e) => e.id === 3)!.x).toBeCloseTo(50)
  })

  it('never produces a non-finite position', () => {
    const out = interpolateEntities([], [snap(1, 1, 1)], 0.5)
    for (const e of out) {
      expect(Number.isFinite(e.x)).toBe(true)
      expect(Number.isFinite(e.z)).toBe(true)
    }
  })
})

describe('alpha handling', () => {
  it('clamps alpha below 0', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 0)], -3)
    expect(out[0]!.x).toBeCloseTo(0)
  })

  it('clamps alpha above 1, so a frame spike cannot fling entities past their target', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 0)], 5)
    expect(out[0]!.x).toBeCloseTo(10)
  })

  it('treats a non-finite alpha as the current state rather than NaN', () => {
    const out = interpolateEntities([snap(1, 0, 0)], [snap(1, 10, 0)], Number.NaN)
    expect(Number.isFinite(out[0]!.x)).toBe(true)
  })

  it('is stable when previous and current are identical', () => {
    // The situation before ticket 005 exists: no sim, so both states match.
    const out = interpolateEntities([snap(1, 7, 8)], [snap(1, 7, 8)], 0.37)
    expect(out[0]!.x).toBeCloseTo(7)
    expect(out[0]!.z).toBeCloseTo(8)
  })

  it('does not mutate its inputs', () => {
    const prev = [snap(1, 0, 0)]
    const cur = [snap(1, 10, 20)]
    interpolateEntities(prev, cur, 0.5)
    expect(prev[0]).toEqual({ id: 1, x: 0, z: 0 })
    expect(cur[0]).toEqual({ id: 1, x: 10, z: 20 })
  })
})
