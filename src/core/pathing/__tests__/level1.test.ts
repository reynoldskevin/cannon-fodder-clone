import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLevel } from '../../level'
import { bakeNavGrid, INFANTRY } from '../navgrid'
import { computeFlowField } from '../flowfield'
import type { LevelData } from '../../level/types'

/**
 * Ticket 006 — the pathing layer against the REAL level, not an ASCII toy.
 *
 * The ASCII fixtures prove the algorithm. This proves the algorithm survives
 * contact with `tools/mapgen`'s output, which is the thing units will actually
 * walk on. Level 1 is 57x45 with 1481 walkable tiles, and its walkable set is
 * still the brightness HEURISTIC rather than a hand-painted mask
 * (`walkableSource: 'heuristic'`), so its shape is nobody's deliberate design —
 * exactly the sort of input that finds the edge cases a fixture never would.
 *
 * The measured facts this pins, taken from the committed `level1.json`:
 *  - Every avatar and enemy spawn sits in ONE connected component of 1325
 *    tiles. If that ever stops being true the mission is unwinnable, and it
 *    would be unwinnable silently.
 *  - There are 64 walkable components in total, so 63 are small enclosed
 *    pockets inside the jungle. Those are the cells that must come back
 *    UNREACHABLE rather than being handed a direction into a wall.
 */

function level1(): LevelData {
  const path = join(process.cwd(), 'public', 'generated', 'levels', 'level1.json')
  return loadLevel(JSON.parse(readFileSync(path, 'utf8')))
}

describe('level 1 pathing', () => {
  const level = level1()
  const grid = bakeNavGrid(level)

  it('bakes to the level dimensions', () => {
    expect(grid.w).toBe(level.size.w)
    expect(grid.h).toBe(level.size.h)
  })

  it('bakes the same passable count the level declares', () => {
    let walkable = 0
    for (const row of level.walkable) for (const cell of row) if (cell) walkable++
    expect(grid.passableCount(INFANTRY)).toBe(walkable)
  })

  it('every enemy spawn is reachable from the squad', () => {
    // The mission objective is kill_all. If an enemy sits in a pocket the squad
    // cannot enter, the level can never be completed and nothing says so.
    const start = level.spawns.avatars[0]!
    const field = computeFlowField(grid, { x: start.x, y: start.y }, INFANTRY)
    for (const enemy of level.spawns.enemies) {
      expect({ enemy, reachable: field.reachable(enemy.x, enemy.y) }).toEqual({
        enemy,
        reachable: true,
      })
    }
  })

  it('every avatar spawn can reach every other avatar spawn', () => {
    for (const from of level.spawns.avatars) {
      const field = computeFlowField(grid, { x: from.x, y: from.y }, INFANTRY)
      for (const to of level.spawns.avatars) {
        expect(field.reachable(to.x, to.y)).toBe(true)
      }
    }
  })

  it('a walk from every enemy spawn arrives at the squad', () => {
    const start = level.spawns.avatars[0]!
    const target = { x: start.x, y: start.y }
    const field = computeFlowField(grid, target, INFANTRY)
    for (const enemy of level.spawns.enemies) {
      let { x, y } = enemy
      let steps = 0
      while (field.cost(x, y) !== 0 && steps < 10000) {
        const dx = field.dirX(x, y)
        const dy = field.dirY(x, y)
        expect({ enemy, dx, dy }).not.toEqual({ enemy, dx: 0, dy: 0 })
        x += dx
        y += dy
        expect(grid.passable(x, y, INFANTRY)).toBe(true)
        steps++
      }
      expect({ enemy, arrived: { x, y } }).toEqual({ enemy, arrived: target })
    }
  })

  it('marks the enclosed pockets unreachable rather than handing out directions', () => {
    // 63 pockets, measured from the committed level. A unit that ever ends up in
    // one must be told to stand still; a direction would walk it into the wall
    // and, because the field never changes, keep it there for the mission.
    const start = level.spawns.avatars[0]!
    const field = computeFlowField(grid, { x: start.x, y: start.y }, INFANTRY)
    let pocketCells = 0
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (!grid.passable(x, y, INFANTRY)) continue
        if (field.reachable(x, y)) continue
        pocketCells++
        expect(field.dirX(x, y)).toBe(0)
        expect(field.dirY(x, y)).toBe(0)
      }
    }
    // There genuinely are isolated pockets, so this assertion is not vacuous —
    // and they are a small minority, so the map is not mostly stranded.
    expect(pocketCells).toBeGreaterThan(0)
    expect(pocketCells).toBeLessThan(200)
  })

  it('reaches the great majority of walkable tiles from the squad', () => {
    const start = level.spawns.avatars[0]!
    const field = computeFlowField(grid, { x: start.x, y: start.y }, INFANTRY)
    let reachable = 0
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) if (field.reachable(x, y)) reachable++
    }
    expect(reachable).toBe(1325)
  })

  it('never points a reachable cell at a blocked one', () => {
    const start = level.spawns.avatars[0]!
    const field = computeFlowField(grid, { x: start.x, y: start.y }, INFANTRY)
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (!field.reachable(x, y) || field.cost(x, y) === 0) continue
        const nx = x + field.dirX(x, y)
        const ny = y + field.dirY(x, y)
        expect({ x, y, nx, ny, passable: grid.passable(nx, ny, INFANTRY) }).toEqual({
          x,
          y,
          nx,
          ny,
          passable: true,
        })
      }
    }
  })

  it('descends strictly toward the target everywhere', () => {
    const start = level.spawns.avatars[0]!
    const field = computeFlowField(grid, { x: start.x, y: start.y }, INFANTRY)
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (!field.reachable(x, y) || field.cost(x, y) === 0) continue
        const next = field.cost(x + field.dirX(x, y), y + field.dirY(x, y))
        expect(next).toBeLessThan(field.cost(x, y))
      }
    }
  })

  it('computes a whole-map field fast enough to do several per tick', () => {
    // 2565 cells. This is the number that justified flow fields over per-unit
    // A*, so it is worth a guard rather than an assumption. Generous by design:
    // the point is to catch an accidental O(n^2), not to police milliseconds.
    const start = level.spawns.avatars[0]!
    const began = performance.now()
    for (let i = 0; i < 20; i++) {
      computeFlowField(grid, { x: start.x + (i % 3), y: start.y }, INFANTRY)
    }
    const perField = (performance.now() - began) / 20
    expect(perField).toBeLessThan(15)
  })
})
