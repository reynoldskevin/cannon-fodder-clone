import { describe, it, expect } from 'vitest'
import { bakeNavGrid, INFANTRY, VEHICLE } from '../navgrid'
import { createFlowFieldCache, DEFAULT_FIELD_CAPACITY } from '../cache'
import { asciiLevel } from './ascii'

/**
 * Ticket 006 — the flow-field cache.
 *
 * A field is a Dijkstra sweep over the whole map: on level 1 that is 2565 cells
 * per destination. Recomputing one per unit per tick is the cost the flow-field
 * approach exists to avoid, so the cache is not an optimisation bolted on
 * afterwards — it is the reason the design was chosen (`ARCHITECTURE.md`,
 * "Mitigated by caching a small number of concurrent fields").
 *
 * Two correctness hazards, both worse than a slow game:
 *  - A field that outlives the grid it was computed from routes units through a
 *    bridge that has since been blown. Invalidation is keyed on the grid's
 *    version, which is exactly what that key exists for.
 *  - An unbounded cache grows one field per distinct destination ever ordered.
 *    A player clicking around for five minutes would accumulate thousands.
 */

const GRID = `
  ..........
  ..#####...
  ..#...#...
  ....#.....
  ..........
`

describe('createFlowFieldCache', () => {
  describe('hits and misses', () => {
    it('computes on first request', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const f = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      expect(f.cost(9, 4)).toBe(0)
      expect(cache.stats.misses).toBe(1)
      expect(cache.stats.hits).toBe(0)
    })

    it('returns the identical field object on a repeat request', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const a = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      const b = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      expect(b).toBe(a)
      expect(cache.stats.hits).toBe(1)
      expect(cache.stats.misses).toBe(1)
    })

    it('keys on the target, so a different destination is a different field', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const a = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      const b = cache.get(grid, { x: 0, y: 0 }, INFANTRY)
      expect(b).not.toBe(a)
      expect(cache.size).toBe(2)
    })

    it('treats a fractional target as the tile containing it', () => {
      // Ticket 007 holds float positions and 008 picks destinations by
      // raycasting the ground plane, so near-identical floats arrive constantly.
      // Keyed unfloored, every click on the same tile is a fresh whole-map
      // sweep and the cache does nothing at all.
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const a = cache.get(grid, { x: 1, y: 1 }, INFANTRY)
      const b = cache.get(grid, { x: 1.5, y: 1.25 }, INFANTRY)
      expect(b).toBe(a)
      expect(cache.size).toBe(1)
    })

    it('keys on the traversal mask, so infantry and vehicles do not share', () => {
      // Sharing here would route a tank down an infantry-only track.
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const a = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      const b = cache.get(grid, { x: 9, y: 4 }, VEHICLE)
      expect(b).not.toBe(a)
      expect(cache.size).toBe(2)
    })

    it('serves many units heading to one destination from a single field', () => {
      // The whole economic argument for flow fields.
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const fields = new Set()
      for (let i = 0; i < 50; i++) fields.add(cache.get(grid, { x: 9, y: 4 }, INFANTRY))
      expect(fields.size).toBe(1)
      expect(cache.stats.misses).toBe(1)
      expect(cache.stats.hits).toBe(49)
    })
  })

  describe('invalidation by grid version', () => {
    it('recomputes after the grid changes', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const before = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      grid.setPassable(5, 4, 0)
      const after = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      expect(after).not.toBe(before)
      expect(after.gridVersion).toBe(grid.version)
    })

    it('the recomputed field reflects the new obstacle', () => {
      // The failure this prevents: units walking through a wall that was built
      // after their field was cached.
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(`
        .....
        .....
        .....
      `))
      const before = cache.get(grid, { x: 0, y: 1 }, INFANTRY)
      expect(before.reachable(4, 1)).toBe(true)
      for (let y = 0; y < 3; y++) grid.setPassable(2, y, 0)
      const after = cache.get(grid, { x: 0, y: 1 }, INFANTRY)
      expect(after.reachable(4, 1)).toBe(false)
    })

    it('does not leave the stale field occupying a slot', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      expect(cache.size).toBe(1)
      grid.setPassable(5, 4, 0)
      cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      expect(cache.size).toBe(1)
    })

    it('does not recompute when an unrelated write left the version alone', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const before = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      grid.setPassable(2, 1, 0) // already blocked — no version bump
      expect(cache.get(grid, { x: 9, y: 4 }, INFANTRY)).toBe(before)
    })
  })

  describe('bounded size and LRU eviction', () => {
    it('has a sane default capacity', () => {
      expect(DEFAULT_FIELD_CAPACITY).toBeGreaterThanOrEqual(4)
      expect(DEFAULT_FIELD_CAPACITY).toBeLessThanOrEqual(64)
      expect(createFlowFieldCache().capacity).toBe(DEFAULT_FIELD_CAPACITY)
    })

    it('never exceeds its capacity', () => {
      const cache = createFlowFieldCache(4)
      const grid = bakeNavGrid(asciiLevel(GRID))
      for (let x = 0; x < 10; x++) {
        cache.get(grid, { x, y: 4 }, INFANTRY)
        expect(cache.size).toBeLessThanOrEqual(4)
      }
      expect(cache.size).toBe(4)
    })

    it('evicts the least recently used field, not the oldest', () => {
      const cache = createFlowFieldCache(3)
      const grid = bakeNavGrid(asciiLevel(GRID))
      const a = cache.get(grid, { x: 0, y: 4 }, INFANTRY)
      cache.get(grid, { x: 1, y: 4 }, INFANTRY)
      cache.get(grid, { x: 2, y: 4 }, INFANTRY)
      // Touch `a` so it is the most recent, then overflow by one.
      expect(cache.get(grid, { x: 0, y: 4 }, INFANTRY)).toBe(a)
      cache.get(grid, { x: 3, y: 4 }, INFANTRY)
      // `a` survives; (1,4) — now the least recently used — is gone.
      expect(cache.get(grid, { x: 0, y: 4 }, INFANTRY)).toBe(a)
      expect(cache.stats.evictions).toBe(1)
    })

    it('counts evictions', () => {
      const cache = createFlowFieldCache(2)
      const grid = bakeNavGrid(asciiLevel(GRID))
      for (let x = 0; x < 6; x++) cache.get(grid, { x, y: 4 }, INFANTRY)
      expect(cache.stats.evictions).toBe(4)
    })

    it('recomputes an evicted destination rather than returning a wrong field', () => {
      const cache = createFlowFieldCache(2)
      const grid = bakeNavGrid(asciiLevel(GRID))
      const first = cache.get(grid, { x: 0, y: 4 }, INFANTRY)
      cache.get(grid, { x: 1, y: 4 }, INFANTRY)
      cache.get(grid, { x: 2, y: 4 }, INFANTRY)
      const again = cache.get(grid, { x: 0, y: 4 }, INFANTRY)
      expect(again).not.toBe(first)
      expect(again.target).toEqual({ x: 0, y: 4 })
      expect(again.cost(0, 4)).toBe(0)
    })

    it('rejects a degenerate capacity rather than caching nothing forever', () => {
      expect(createFlowFieldCache(0).capacity).toBeGreaterThan(0)
      expect(createFlowFieldCache(-5).capacity).toBeGreaterThan(0)
    })
  })

  describe('clear', () => {
    it('drops every field', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const before = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get(grid, { x: 9, y: 4 }, INFANTRY)).not.toBe(before)
    })
  })

  describe('determinism', () => {
    it('a cached field and a freshly computed one agree everywhere', () => {
      const cache = createFlowFieldCache()
      const grid = bakeNavGrid(asciiLevel(GRID))
      const cached = cache.get(grid, { x: 9, y: 4 }, INFANTRY)
      const fresh = createFlowFieldCache().get(grid, { x: 9, y: 4 }, INFANTRY)
      for (let y = 0; y < grid.h; y++) {
        for (let x = 0; x < grid.w; x++) {
          expect(cached.cost(x, y)).toBe(fresh.cost(x, y))
          expect(cached.dirX(x, y)).toBe(fresh.dirX(x, y))
          expect(cached.dirY(x, y)).toBe(fresh.dirY(x, y))
        }
      }
    })
  })
})
