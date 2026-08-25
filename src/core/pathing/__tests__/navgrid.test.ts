import { describe, it, expect } from 'vitest'
import { bakeNavGrid, NavGrid, INFANTRY, VEHICLE, ALL_TRAVERSAL } from '../navgrid'
import { asciiLevel } from './ascii'

/**
 * Ticket 006 — the navigation grid.
 *
 * Baked once from `LevelData.walkable` at mission start. Two things here exist
 * for the future rather than for today, and both are cheap now and expensive
 * later:
 *
 *  - A PER-UNIT TRAVERSAL MASK. `ARCHITECTURE.md`'s vehicles extension point
 *    says "`PathingSystem` takes a per-unit traversal mask, so vehicle-only
 *    terrain rules need no grid change". Only infantry exists today, so the
 *    mask is exercised here rather than in the game.
 *  - A VERSION KEY. The destructible-terrain extension point is "mutating
 *    walkability and bumping the key". Flow fields cache against that key, so
 *    without it a blown bridge leaves every unit following a field computed for
 *    a world that no longer exists.
 */

describe('bakeNavGrid', () => {
  describe('shape', () => {
    it('matches the level dimensions', () => {
      const grid = bakeNavGrid(asciiLevel(`
        .....
        .....
        .....
      `))
      expect(grid.w).toBe(5)
      expect(grid.h).toBe(3)
    })

    it('marks walkable cells passable to infantry', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ...
        .#.
        ...
      `))
      expect(grid.passable(0, 0, INFANTRY)).toBe(true)
      expect(grid.passable(1, 1, INFANTRY)).toBe(false)
      expect(grid.passable(2, 2, INFANTRY)).toBe(true)
    })

    it('treats every out-of-bounds cell as impassable', () => {
      // Systems index by unit position, which drifts off the edge during
      // steering. Returning `true` there would path units off the map.
      const grid = bakeNavGrid(asciiLevel(`
        ..
        ..
      `))
      for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2], [-1, -1], [99, 99]] as const) {
        expect(grid.passable(x, y, INFANTRY)).toBe(false)
      }
    })

    it('handles a fully blocked level', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ###
        ###
      `))
      expect(grid.passable(1, 1, INFANTRY)).toBe(false)
      expect(grid.passableCount(INFANTRY)).toBe(0)
    })

    it('handles a fully open level', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ....
        ....
      `))
      expect(grid.passableCount(INFANTRY)).toBe(8)
    })

    it('does not alias rows — editing one cell does not change another', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ...
        ...
        ...
      `))
      grid.setPassable(1, 1, 0)
      expect(grid.passable(1, 1, INFANTRY)).toBe(false)
      expect(grid.passable(1, 0, INFANTRY)).toBe(true)
      expect(grid.passable(1, 2, INFANTRY)).toBe(true)
      expect(grid.passable(0, 1, INFANTRY)).toBe(true)
    })

    it('does not hold a reference to the level that would let it drift', () => {
      // The grid is a bake, not a view. A later edit to the source arrays must
      // not silently change passability without a version bump.
      const level = asciiLevel(`
        ...
        ...
      `)
      const grid = bakeNavGrid(level)
      const before = grid.version
      ;(level.walkable as boolean[][])[0]![0] = false
      expect(grid.passable(0, 0, INFANTRY)).toBe(true)
      expect(grid.version).toBe(before)
    })
  })

  describe('traversal masks', () => {
    it('bakes walkable cells as passable to every traversal class by default', () => {
      // Infantry is all that exists today, so a walkable tile must not
      // accidentally be vehicle-only or infantry-only out of the importer.
      const grid = bakeNavGrid(asciiLevel(`
        ..
        ..
      `))
      expect(grid.passable(0, 0, INFANTRY)).toBe(true)
      expect(grid.passable(0, 0, VEHICLE)).toBe(true)
      expect(grid.passable(0, 0, ALL_TRAVERSAL)).toBe(true)
    })

    it('gives INFANTRY and VEHICLE distinct bits', () => {
      expect(INFANTRY & VEHICLE).toBe(0)
      expect(INFANTRY).not.toBe(0)
      expect(VEHICLE).not.toBe(0)
    })

    it('ALL_TRAVERSAL includes both', () => {
      expect(ALL_TRAVERSAL & INFANTRY).toBe(INFANTRY)
      expect(ALL_TRAVERSAL & VEHICLE).toBe(VEHICLE)
    })

    it('can make a cell passable to one class and not the other', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ..
        ..
      `))
      grid.setPassable(1, 0, INFANTRY)
      expect(grid.passable(1, 0, INFANTRY)).toBe(true)
      expect(grid.passable(1, 0, VEHICLE)).toBe(false)
    })

    it('treats a zero mask as passing nothing', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ..
        ..
      `))
      expect(grid.passable(0, 0, 0)).toBe(false)
    })

    it('counts passable cells per traversal class', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ...
        ...
      `))
      grid.setPassable(0, 0, INFANTRY)
      grid.setPassable(1, 0, INFANTRY)
      expect(grid.passableCount(INFANTRY)).toBe(6)
      expect(grid.passableCount(VEHICLE)).toBe(4)
    })
  })

  describe('version key', () => {
    it('starts at a stable value for a fresh bake', () => {
      const level = asciiLevel(`
        ..
        ..
      `)
      expect(bakeNavGrid(level).version).toBe(bakeNavGrid(level).version)
    })

    it('bumps when a cell changes passability', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ...
        ...
      `))
      const before = grid.version
      grid.setPassable(1, 1, 0)
      expect(grid.version).not.toBe(before)
    })

    it('does not bump when a write leaves passability unchanged', () => {
      // A destructible-terrain system that rewrites the same value every tick
      // would otherwise invalidate every cached field, 60 times a second.
      const grid = bakeNavGrid(asciiLevel(`
        ...
        ...
      `))
      grid.setPassable(1, 1, 0)
      const after = grid.version
      grid.setPassable(1, 1, 0)
      expect(grid.version).toBe(after)
    })

    it('bumps again on a second distinct change', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ....
        ....
      `))
      const v0 = grid.version
      grid.setPassable(1, 1, 0)
      const v1 = grid.version
      grid.setPassable(2, 1, 0)
      const v2 = grid.version
      expect(new Set([v0, v1, v2]).size).toBe(3)
    })

    it('ignores an out-of-bounds write rather than corrupting the grid', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ..
        ..
      `))
      const before = grid.version
      grid.setPassable(-1, 0, 0)
      grid.setPassable(9, 9, 0)
      expect(grid.version).toBe(before)
      expect(grid.passableCount(INFANTRY)).toBe(4)
    })
  })

  describe('NavGrid type', () => {
    it('is exported so systems can hold one', () => {
      const grid = bakeNavGrid(asciiLevel('..'))
      const held: NavGrid = grid
      expect(held.w).toBe(2)
    })
  })
})
