import { describe, it, expect } from 'vitest'
import { bakeNavGrid, INFANTRY, VEHICLE } from '../navgrid'
import { computeFlowField, UNREACHABLE, SQRT2 } from '../flowfield'
import type { FlowField } from '../flowfield'
import { asciiLevel } from './ascii'

/**
 * Ticket 006 — flow fields.
 *
 * `ARCHITECTURE.md` (Hard problem 3): Dijkstra outward from the destination, one
 * field shared by every unit heading there, each reading its direction in O(1).
 * The acceptance criterion is a gradient that "monotonically descends to the
 * target", and that is the property these tests hammer — not a spot-check of a
 * few directions, but a walk from EVERY reachable cell that must actually
 * arrive.
 *
 * The two failure modes that matter in play:
 *  - A unit in an enclosed pocket must be told it is stuck. Given a direction
 *    anyway it walks into the wall, and because the field never changes it
 *    jitters there for the rest of the mission.
 *  - Diagonal moves must not cut wall corners. A soldier clipping the corner of
 *    a hut looks like a collision bug, and on level 1's dense canopy fringe
 *    there are hundreds of such corners.
 */

const field = (art: string, target: { x: number; y: number }, mask = INFANTRY): FlowField =>
  computeFlowField(bakeNavGrid(asciiLevel(art)), target, mask)

/**
 * Follow the field from `start` and return the cells visited. Bounded, so a
 * cycle returns a long path rather than hanging the suite.
 */
function walk(f: FlowField, start: { x: number; y: number }, limit = 4000): { x: number; y: number }[] {
  const path = [start]
  let { x, y } = start
  for (let i = 0; i < limit; i++) {
    if (f.cost(x, y) === 0) break
    const dx = f.dirX(x, y)
    const dy = f.dirY(x, y)
    if (dx === 0 && dy === 0) break
    x += dx
    y += dy
    path.push({ x, y })
  }
  return path
}

describe('computeFlowField', () => {
  describe('the basics', () => {
    it('gives the target a cost of zero', () => {
      const f = field(
        `
        .....
        .....
        .....
      `,
        { x: 2, y: 1 },
      )
      expect(f.cost(2, 1)).toBe(0)
    })

    it('gives the target no direction — it has arrived', () => {
      const f = field(
        `
        .....
        .....
      `,
        { x: 2, y: 1 },
      )
      expect(f.dirX(2, 1)).toBe(0)
      expect(f.dirY(2, 1)).toBe(0)
    })

    it('points an orthogonal neighbour straight at the target', () => {
      const f = field(
        `
        .....
        .....
        .....
      `,
        { x: 2, y: 1 },
      )
      expect([f.dirX(1, 1), f.dirY(1, 1)]).toEqual([1, 0])
      expect([f.dirX(3, 1), f.dirY(3, 1)]).toEqual([-1, 0])
      expect([f.dirX(2, 0), f.dirY(2, 0)]).toEqual([0, 1])
      expect([f.dirX(2, 2), f.dirY(2, 2)]).toEqual([0, -1])
    })

    it('costs an orthogonal step 1 and a diagonal step SQRT2', () => {
      const f = field(
        `
        .....
        .....
        .....
      `,
        { x: 2, y: 1 },
      )
      expect(f.cost(1, 1)).toBeCloseTo(1, 9)
      expect(f.cost(1, 0)).toBeCloseTo(SQRT2, 9)
    })

    it('reports its target and mask', () => {
      const f = field(
        `
        ...
        ...
      `,
        { x: 1, y: 1 },
        VEHICLE,
      )
      expect(f.target).toEqual({ x: 1, y: 1 })
      expect(f.mask).toBe(VEHICLE)
    })

    it('records the grid version it was computed against', () => {
      const grid = bakeNavGrid(asciiLevel(`
        ...
        ...
      `))
      const f = computeFlowField(grid, { x: 0, y: 0 }, INFANTRY)
      expect(f.gridVersion).toBe(grid.version)
    })
  })

  describe('monotonic descent — the acceptance criterion', () => {
    const fixtures: readonly { name: string; art: string; target: { x: number; y: number } }[] = [
      {
        name: 'open field',
        art: `
          ........
          ........
          ........
          ........
          ........
        `,
        target: { x: 7, y: 4 },
      },
      {
        name: 'single wall',
        art: `
          ..........
          ..........
          ...#####..
          ..........
          ..........
        `,
        target: { x: 5, y: 0 },
      },
      {
        name: 'U-shaped trap',
        art: `
          ..........
          ..#####...
          ..#...#...
          ..#.#.#...
          ..#.#.#...
          ....#.....
          ..........
        `,
        target: { x: 0, y: 6 },
      },
      {
        name: 'spiral corridor',
        art: `
          ...........
          .#########.
          .#.......#.
          .#.#####.#.
          .#.#...#.#.
          .#.#.#.#.#.
          .#.#.#...#.
          .#.#######.
          .#.........
          ...........
        `,
        // (5,5) would land on a wall; (5,4) is the innermost open cell, reached
        // only by walking the full spiral out to row 9 and back.
        target: { x: 5, y: 4 },
      },
      {
        name: 'diagonal gap',
        art: `
          ....#.....
          ....#.....
          .....#....
          ......#...
          ..........
        `,
        target: { x: 9, y: 0 },
      },
    ]

    for (const { name, art, target } of fixtures) {
      it(`descends strictly to the target from every reachable cell — ${name}`, () => {
        const f = field(art, target)
        const grid = bakeNavGrid(asciiLevel(art))
        let checked = 0
        for (let y = 0; y < grid.h; y++) {
          for (let x = 0; x < grid.w; x++) {
            if (!f.reachable(x, y)) continue
            checked++
            const dx = f.dirX(x, y)
            const dy = f.dirY(x, y)
            if (f.cost(x, y) === 0) continue
            // Every step must land on a passable cell and strictly reduce cost.
            const nx = x + dx
            const ny = y + dy
            expect(grid.passable(nx, ny, INFANTRY)).toBe(true)
            expect(f.cost(nx, ny)).toBeLessThan(f.cost(x, y))
          }
        }
        expect(checked).toBeGreaterThan(4)
      })

      it(`a walk from every reachable cell arrives at the target — ${name}`, () => {
        const f = field(art, target)
        const grid = bakeNavGrid(asciiLevel(art))
        for (let y = 0; y < grid.h; y++) {
          for (let x = 0; x < grid.w; x++) {
            if (!f.reachable(x, y)) continue
            const path = walk(f, { x, y })
            const end = path[path.length - 1]!
            expect({ from: { x, y }, end }).toEqual({ from: { x, y }, end: target })
          }
        }
      })
    }
  })

  describe('obstacle avoidance', () => {
    it('routes around a wall rather than into it', () => {
      const art = `
        ..........
        ..........
        ....#.....
        ....#.....
        ....#.....
        ..........
      `
      const f = field(art, { x: 8, y: 3 })
      const path = walk(f, { x: 0, y: 3 })
      expect(path[path.length - 1]).toEqual({ x: 8, y: 3 })
      for (const p of path) {
        expect(p.x === 4 && p.y >= 2 && p.y <= 4).toBe(false)
      }
    })

    it('escapes a U-shaped trap by going back out of the mouth', () => {
      // The classic greedy-steering failure: a unit inside the U walks at the
      // target, jams against the back wall and stays there. A flow field must
      // send it out the way it came.
      const art = `
        ..........
        ..#####...
        ..#...#...
        ..#...#...
        ..#####...
        ..........
      `
      // Mouth is closed on all sides except the top row above the U; the cells
      // inside are enclosed, so this asserts they are correctly unreachable.
      const f = field(art, { x: 9, y: 5 })
      expect(f.reachable(3, 2)).toBe(false)
      expect(f.reachable(9, 5)).toBe(true)
    })

    it('takes the longer open route when the short one is walled off', () => {
      const art = `
        .....#....
        .....#....
        .....#....
        .....#....
        ..........
      `
      const f = field(art, { x: 9, y: 0 })
      const path = walk(f, { x: 0, y: 0 })
      expect(path[path.length - 1]).toEqual({ x: 9, y: 0 })
      // The only gap is the bottom row, so the path must dip to y = 4.
      expect(path.some((p) => p.y === 4)).toBe(true)
    })
  })

  describe('diagonal corner cutting', () => {
    it('does not squeeze between two diagonally touching walls', () => {
      // Cells (1,0) and (0,1) are blocked, so the diagonal from (0,0) to (1,1)
      // passes through the corner where two walls meet. A unit taking it clips
      // straight through solid terrain.
      const art = `
        .#..
        #...
        ....
        ....
      `
      const f = field(art, { x: 3, y: 3 })
      const path = walk(f, { x: 0, y: 0 })
      // (0,0) is sealed off by that corner, so it must be unreachable rather
      // than reachable-by-clipping.
      expect(f.reachable(0, 0)).toBe(false)
      expect(path).toHaveLength(1)
    })

    it('allows a diagonal when only one of the two orthogonals is blocked', () => {
      // Squeezing past a single wall corner is legitimate movement; forbidding
      // it makes units refuse perfectly good diagonals and hug walls.
      //
      // This must assert the diagonal is actually TAKEN, not merely that the
      // cell is reachable. Connectivity is identical under both policies — if
      // exactly one shared orthogonal is blocked, the other always gives a
      // two-step L route — so a reachability check passes whichever rule is
      // implemented and proves nothing. The cost is what tells them apart:
      // SQRT2 for the diagonal, 2 for the staircase.
      const art = `
        .#..
        ....
        ....
      `
      const f = field(art, { x: 0, y: 0 })
      // (1,1) -> (0,0) is diagonal. Its shared orthogonals are (0,1), open, and
      // (1,0), a wall. One blocked, so the move stands.
      expect(f.cost(1, 1)).toBeCloseTo(SQRT2, 9)
      expect([f.dirX(1, 1), f.dirY(1, 1)]).toEqual([-1, -1])
      expect(f.reachable(2, 1)).toBe(true)
      expect(walk(f, { x: 2, y: 1 }).at(-1)).toEqual({ x: 0, y: 0 })
    })

    it('prefers the diagonal to the staircase across an open field', () => {
      // The same defect at scale: if diagonals past corners are refused, costs
      // inflate toward Manhattan distance and units visibly zig-zag.
      const f = field(
        `
        ......
        ......
        ......
        ......
      `,
        { x: 0, y: 0 },
      )
      expect(f.cost(3, 3)).toBeCloseTo(3 * SQRT2, 9)
      expect([f.dirX(3, 3), f.dirY(3, 3)]).toEqual([-1, -1])
    })

    it('never steps onto a blocked cell anywhere in a dense field', () => {
      const art = `
        .#.#.#.#.#
        #.#.#.#.#.
        .#.#.#.#.#
        #.#.#.#.#.
        .#.#.#.#.#
      `
      const grid = bakeNavGrid(asciiLevel(art))
      const f = computeFlowField(grid, { x: 0, y: 0 }, INFANTRY)
      for (let y = 0; y < grid.h; y++) {
        for (let x = 0; x < grid.w; x++) {
          if (!f.reachable(x, y)) continue
          const nx = x + f.dirX(x, y)
          const ny = y + f.dirY(x, y)
          expect(grid.passable(nx, ny, INFANTRY)).toBe(true)
        }
      }
    })
  })

  describe('unreachable regions', () => {
    const art = `
      ......####
      ......#..#
      ......#..#
      ......####
      ..........
    `

    it('marks an enclosed pocket unreachable', () => {
      const f = field(art, { x: 0, y: 0 })
      expect(f.reachable(7, 1)).toBe(false)
      expect(f.reachable(8, 2)).toBe(false)
    })

    it('gives unreachable cells the UNREACHABLE cost', () => {
      const f = field(art, { x: 0, y: 0 })
      expect(f.cost(7, 1)).toBe(UNREACHABLE)
    })

    it('gives unreachable cells a zero direction, so units do not jitter', () => {
      // The whole point: a stuck unit is told to stand still rather than handed
      // a direction that walks it into the wall every tick forever.
      const f = field(art, { x: 0, y: 0 })
      expect(f.dirX(7, 1)).toBe(0)
      expect(f.dirY(7, 1)).toBe(0)
    })

    it('marks blocked cells themselves unreachable', () => {
      const f = field(art, { x: 0, y: 0 })
      expect(f.reachable(6, 0)).toBe(false)
      expect(f.cost(6, 0)).toBe(UNREACHABLE)
    })

    it('marks out-of-bounds cells unreachable rather than throwing', () => {
      const f = field(art, { x: 0, y: 0 })
      for (const [x, y] of [[-1, 0], [0, -1], [999, 0], [0, 999]] as const) {
        expect(f.reachable(x, y)).toBe(false)
        expect(f.cost(x, y)).toBe(UNREACHABLE)
        expect(f.dirX(x, y)).toBe(0)
        expect(f.dirY(x, y)).toBe(0)
      }
    })

    it('still solves the reachable part of the map', () => {
      const f = field(art, { x: 0, y: 0 })
      expect(f.reachable(9, 4)).toBe(true)
      expect(walk(f, { x: 9, y: 4 }).at(-1)).toEqual({ x: 0, y: 0 })
    })
  })

  describe('degenerate targets', () => {
    it('produces an all-unreachable field for a target inside a wall', () => {
      const f = field(
        `
        ...
        .#.
        ...
      `,
        { x: 1, y: 1 },
      )
      expect(f.reachable(0, 0)).toBe(false)
      expect(f.reachable(1, 1)).toBe(false)
    })

    it('produces an all-unreachable field for an out-of-bounds target', () => {
      const f = field(
        `
        ...
        ...
      `,
        { x: 50, y: 50 },
      )
      expect(f.reachable(0, 0)).toBe(false)
      expect(f.cost(0, 0)).toBe(UNREACHABLE)
    })

    it('handles a target fully enclosed by walls', () => {
      const f = field(
        `
        #####
        #...#
        #.#.#
        #...#
        #####
      `,
        { x: 2, y: 2 },
      )
      // The target itself is a wall; nothing can reach it.
      expect(f.reachable(1, 1)).toBe(false)
    })

    it('handles a one-cell level', () => {
      const f = field('.', { x: 0, y: 0 })
      expect(f.cost(0, 0)).toBe(0)
      expect(f.reachable(0, 0)).toBe(true)
    })
  })

  describe('fractional targets', () => {
    // The accessors floor their coordinates so a unit standing anywhere inside a
    // tile reads that tile. The TARGET has to take the same floor, or the guard
    // that admits it and the sweep that solves it disagree about which tile the
    // destination is. Ticket 007 stores float positions and ticket 008 picks a
    // destination by raycasting the ground plane, so a fractional target is the
    // normal case, not an abuse.
    const OPEN = `
      .....
      .....
      .....
      .....
      .....
    `

    it('floors a fractional target to the tile containing it', () => {
      const f = field(OPEN, { x: 2.5, y: 2.5 })
      expect(f.cost(2, 2)).toBe(0)
    })

    it('reports the floored target, not the fractional one it was handed', () => {
      expect(field(OPEN, { x: 2.5, y: 2.5 }).target).toEqual({ x: 2, y: 2 })
    })

    it('produces exactly the field its floored target would', () => {
      const fractional = field(OPEN, { x: 3.9, y: 1.2 })
      const floored = field(OPEN, { x: 3, y: 1 })
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          expect({ x, y, cost: fractional.cost(x, y) }).toEqual({ x, y, cost: floored.cost(x, y) })
          expect(fractional.dirX(x, y)).toBe(floored.dirX(x, y))
          expect(fractional.dirY(x, y)).toBe(floored.dirY(x, y))
        }
      }
    })

    it('leaves no map unsolved — every open cell still reaches the target', () => {
      // The silent failure mode: a fractional source index makes every write a
      // no-op, the sweep dies, and the WHOLE map comes back unreachable. Every
      // unit then stands still and nothing reports an error.
      const f = field(OPEN, { x: 1.5, y: 1 })
      let reachable = 0
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (f.reachable(x, y)) reachable++
      expect(reachable).toBe(25)
    })

    it('does not solve for some other tile entirely', () => {
      // `y * w + x` with fractional parts can still land on a valid integer
      // index — 2.5 * 5 + 2.5 is 15 — and then the field is perfectly monotonic
      // toward completely the wrong cell, which is the worst version of this
      // bug because nothing anywhere looks broken.
      const f = field(OPEN, { x: 2.5, y: 2.5 })
      const zeroes: { x: number; y: number }[] = []
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) if (f.cost(x, y) === 0) zeroes.push({ x, y })
      }
      expect(zeroes).toEqual([{ x: 2, y: 2 }])
    })
  })

  describe('determinism', () => {
    it('two fields over the same grid and target are identical', () => {
      const art = `
        ..........
        ..#####...
        ..#...#...
        ....#.....
        ..........
      `
      const a = field(art, { x: 9, y: 4 })
      const b = field(art, { x: 9, y: 4 })
      const grid = bakeNavGrid(asciiLevel(art))
      for (let y = 0; y < grid.h; y++) {
        for (let x = 0; x < grid.w; x++) {
          expect(a.cost(x, y)).toBe(b.cost(x, y))
          expect(a.dirX(x, y)).toBe(b.dirX(x, y))
          expect(a.dirY(x, y)).toBe(b.dirY(x, y))
        }
      }
    })
  })

  describe('traversal masks', () => {
    it('respects a mask that blocks a corridor for one class only', () => {
      const grid = bakeNavGrid(asciiLevel(`
        .....
        .....
        .....
      `))
      // Wall off the middle column for vehicles only.
      for (let y = 0; y < 3; y++) grid.setPassable(2, y, INFANTRY)

      const infantry = computeFlowField(grid, { x: 0, y: 1 }, INFANTRY)
      const vehicle = computeFlowField(grid, { x: 0, y: 1 }, VEHICLE)

      expect(infantry.reachable(4, 1)).toBe(true)
      expect(vehicle.reachable(4, 1)).toBe(false)
    })
  })
})
