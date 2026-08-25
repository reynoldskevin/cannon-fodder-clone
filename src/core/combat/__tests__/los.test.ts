import { describe, it, expect } from 'vitest'
import { bakeNavGrid, INFANTRY } from '../../pathing/navgrid'
import { hasLineOfSight } from '../los'
import { asciiLevel } from '../../pathing/__tests__/ascii'

/**
 * Ticket 011 — line of sight.
 *
 * Reuses ticket 006's ASCII fixture helper rather than growing a second one:
 * LOS and pathing read the same grid, and two drifting copies of "what does `#`
 * mean" is precisely the kind of divergence that makes a combat bug look like a
 * pathing bug.
 *
 * SYMMETRY IS THE PROPERTY THAT MATTERS. If A can see B but B cannot see A,
 * one soldier shoots the other with impunity and the exchange looks broken from
 * exactly one side of the wall — which is maddening to diagnose, because the
 * losing player reports a bug the winning player cannot reproduce. Every
 * fixture below is asserted in both directions.
 */

const los = (art: string, from: readonly [number, number], to: readonly [number, number]): boolean =>
  hasLineOfSight(bakeNavGrid(asciiLevel(art)), { x: from[0], y: from[1] }, { x: to[0], y: to[1] }, INFANTRY)

/** Assert LOS is the same looking both ways, and return it. */
function symmetric(art: string, a: readonly [number, number], b: readonly [number, number]): boolean {
  const forward = los(art, a, b)
  const backward = los(art, b, a)
  expect({ a, b, forward, backward }).toEqual({ a, b, forward, backward: forward })
  return forward
}

describe('hasLineOfSight', () => {
  describe('open ground', () => {
    const OPEN = `
      .........
      .........
      .........
      .........
      .........
    `

    it('sees along a clear horizontal line', () => {
      expect(symmetric(OPEN, [0, 2], [8, 2])).toBe(true)
    })

    it('sees along a clear vertical line', () => {
      expect(symmetric(OPEN, [4, 0], [4, 4])).toBe(true)
    })

    it('sees along a clear diagonal', () => {
      expect(symmetric(OPEN, [0, 0], [4, 4])).toBe(true)
    })

    it('sees along a clear shallow angle', () => {
      expect(symmetric(OPEN, [0, 0], [8, 3])).toBe(true)
    })

    it('sees itself', () => {
      expect(los(OPEN, [3, 3], [3, 3])).toBe(true)
    })

    it('sees an adjacent tile', () => {
      expect(symmetric(OPEN, [3, 3], [4, 3])).toBe(true)
      expect(symmetric(OPEN, [3, 3], [4, 4])).toBe(true)
    })
  })

  describe('walls block', () => {
    it('does not see through a wall straight ahead', () => {
      expect(
        symmetric(
          `
        .........
        .........
        ....#....
        .........
        .........
      `,
          [1, 2],
          [7, 2],
        ),
      ).toBe(false)
    })

    it('does not see through a long wall', () => {
      expect(
        symmetric(
          `
        ....#....
        ....#....
        ....#....
        ....#....
        ....#....
      `,
          [1, 2],
          [7, 2],
        ),
      ).toBe(false)
    })

    it('sees past the end of a wall', () => {
      expect(
        symmetric(
          `
        .........
        ....#....
        ....#....
        .........
        .........
      `,
          [1, 4],
          [7, 4],
        ),
      ).toBe(true)
    })

    it('does not see through a wall on a diagonal', () => {
      expect(
        symmetric(
          `
        .....
        .....
        ..#..
        .....
        .....
      `,
          [0, 0],
          [4, 4],
        ),
      ).toBe(false)
    })

    it('treats the shooter standing in a wall as blind', () => {
      // Should not happen, but a unit nudged into geometry must not gain x-ray
      // vision as a consolation prize.
      expect(
        los(
          `
        .....
        ..#..
        .....
      `,
          [2, 1],
          [4, 1],
        ),
      ).toBe(false)
    })

    it('cannot see a target standing inside a wall', () => {
      expect(
        los(
          `
        .....
        ..#..
        .....
      `,
          [0, 1],
          [2, 1],
        ),
      ).toBe(false)
    })
  })

  describe('the diagonal gap', () => {
    it('does not see between two diagonally touching walls', () => {
      // The optical twin of ticket 006's corner rule: a ray that threads the
      // exact point where two wall corners meet is looking through solid
      // terrain, and a soldier who can shoot through it is shooting through a
      // wall on every canopy fringe in the level.
      expect(
        symmetric(
          `
        ..#..
        ..#..
        ...#.
        ...#.
        .....
      `,
          [0, 0],
          [4, 3],
        ),
      ).toBe(false)
    })

    it('sees through a genuine one-tile gap', () => {
      expect(
        symmetric(
          `
        ####.####
        .........
        ####.####
      `,
          [4, 0],
          [4, 2],
        ),
      ).toBe(true)
    })
  })

  describe('bounds', () => {
    const OPEN = `
      ....
      ....
    `

    it('reports no sight to an off-map tile', () => {
      expect(los(OPEN, [1, 1], [99, 1])).toBe(false)
      expect(los(OPEN, [1, 1], [-1, 1])).toBe(false)
    })

    it('reports no sight from an off-map tile', () => {
      expect(los(OPEN, [-1, 0], [1, 1])).toBe(false)
    })

    it('does not throw on absurd coordinates', () => {
      expect(() => los(OPEN, [1, 1], [1e9, -1e9])).not.toThrow()
      expect(los(OPEN, [1, 1], [Number.NaN, 0])).toBe(false)
      expect(los(OPEN, [1, 1], [Number.POSITIVE_INFINITY, 0])).toBe(false)
    })

    it('floors fractional coordinates to their tile', () => {
      // Entities hold continuous world positions; a shot fired from the middle
      // of a tile is fired from that tile.
      const art = `
        .....
        .....
      `
      expect(hasLineOfSight(bakeNavGrid(asciiLevel(art)), { x: 0.7, y: 0.2 }, { x: 4.4, y: 0.9 }, INFANTRY)).toBe(
        true,
      )
    })
  })

  describe('symmetry under stress', () => {
    it('is symmetric for every pair in a cluttered field', () => {
      // The property asserted exhaustively rather than by example: a Bresenham
      // walked from A biases its rounding differently than one walked from B,
      // and that asymmetry is the classic way this function goes wrong.
      const art = `
        ..#....#..
        ....#.....
        .#......#.
        .....#....
        ..#....#..
        ....#.....
      `
      const grid = bakeNavGrid(asciiLevel(art))
      let blocked = 0
      let clear = 0
      for (let ay = 0; ay < 6; ay++) {
        for (let ax = 0; ax < 10; ax++) {
          for (let by = 0; by < 6; by++) {
            for (let bx = 0; bx < 10; bx++) {
              const f = hasLineOfSight(grid, { x: ax, y: ay }, { x: bx, y: by }, INFANTRY)
              const b = hasLineOfSight(grid, { x: bx, y: by }, { x: ax, y: ay }, INFANTRY)
              expect({ ax, ay, bx, by, f, b }).toEqual({ ax, ay, bx, by, f, b: f })
              if (f) clear++
              else blocked++
            }
          }
        }
      }
      // Non-vacuous: the fixture genuinely produces both outcomes in quantity.
      expect(blocked).toBeGreaterThan(500)
      expect(clear).toBeGreaterThan(500)
    })
  })
})
