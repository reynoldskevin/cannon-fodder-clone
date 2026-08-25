import { describe, it, expect } from 'vitest'
import { applyCommand, createCommandQueue } from '../index'
import type { Command } from '../index'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { createSquadSystem } from '../../squad'
import { tileToWorld, worldToTile } from '../../view/projection'

/**
 * Ticket 008 — applying a command to the world.
 *
 * WHY THIS DRIVES A REAL SQUAD. The queue and the squad system are two sides of
 * a boundary, and the cheap way to test each is to fake the other: assert the
 * queue emits a `move`, and separately assert the squad accepts one. Both fakes
 * then agree with themselves and can still disagree with each other about the
 * shape they exchange — the target in tile or world coordinates, the id list
 * filtered or raw — and every test passes while clicking the ground does
 * nothing. So the end-to-end cases below construct a real `World`, a real
 * `SquadSystem`, and tick them.
 *
 * VALIDATION LIVES HERE, NOT IN THE QUEUE. Dead ids, empty id lists and targets
 * off the map are dropped at apply time. That is the only place with a `World`
 * to ask, and it keeps the queue a buffer you can trust to hand back what you
 * put in.
 */

const MAP = `
  ....................
  ....................
  .........####.......
  .........####.......
  ....................
  ....................
  ....................
  ....................
`

interface Rig {
  readonly world: World
  readonly squad: ReturnType<typeof createSquadSystem>
  readonly apply: (command: Command) => boolean
  spawn(tileX: number, tileY: number): number
  tileOf(id: number): { x: number; y: number }
  run(ticks: number): void
}

function rig(): Rig {
  const level = asciiLevel(MAP)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const squad = createSquadSystem(grid, { speedTilesPerSecond: 3 })
  world.addSystem(squad)
  return {
    world,
    squad,
    apply: (command) => applyCommand(command, { world, squad, grid }),
    spawn(tileX, tileY) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team: 'player', x: p.x, z: p.z }).id
    },
    tileOf(id) {
      const e = world.get(id)
      if (!e) throw new Error(`no entity ${String(id)}`)
      return worldToTile(e.x, e.z, level.size)
    },
    run(ticks) {
      for (let i = 0; i < ticks; i++) world.tick()
    },
  }
}

const move = (unitIds: readonly number[], x: number, y: number): Command => ({
  type: 'move',
  unitIds,
  target: { x, y },
})

describe('applyCommand — move', () => {
  it('re-targets a real squad, verified by ticking it', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(r.apply(move([a], 17, 5))).toBe(true)
    r.run(500)
    expect(r.tileOf(a).x).toBeGreaterThan(14)
  })

  it('reports that it did nothing when every id is unknown', () => {
    const r = rig()
    expect(r.apply(move([4242], 5, 5))).toBe(false)
  })

  it('drops dead ids but honours the living remainder', () => {
    const r = rig()
    const alive = r.spawn(2, 5)
    const dead = r.spawn(2, 6)
    r.world.despawn(dead)
    expect(r.apply(move([dead, alive], 17, 5))).toBe(true)
    r.run(500)
    expect(r.tileOf(alive).x).toBeGreaterThan(14)
    expect(r.squad.leaderOf(alive)).toBe(alive)
  })

  it('does not throw on an unknown id', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(() => r.apply(move([a, 9999], 6, 5))).not.toThrow()
  })

  it('drops a move whose id list is empty', () => {
    const r = rig()
    r.spawn(2, 5)
    expect(r.apply(move([], 6, 5))).toBe(false)
  })

  it('creates no detachment for a dropped move', () => {
    const r = rig()
    r.spawn(2, 5)
    r.apply(move([4242], 6, 5))
    r.run(1)
    expect(r.squad.detachmentCount).toBe(0)
  })
})

describe('applyCommand — target validation', () => {
  it('rejects a target beyond the east edge', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(r.apply(move([a], 20, 5))).toBe(false)
  })

  it('rejects a negative target', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(r.apply(move([a], -1, 5))).toBe(false)
    expect(r.apply(move([a], 5, -1))).toBe(false)
  })

  it('rejects a non-finite target', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(r.apply(move([a], Number.NaN, 5))).toBe(false)
    expect(r.apply(move([a], Number.POSITIVE_INFINITY, 5))).toBe(false)
  })

  it('does NOT clamp an out-of-bounds target into the level', () => {
    // Clamping is the tempting fix and it is wrong: a click past the east edge
    // becomes an order to the edge tile, which may be a wall, and the squad
    // trudges off to press itself against it. Rejecting is honest — the click
    // was not on the map, so it was not an order.
    const r = rig()
    const a = r.spawn(2, 5)
    r.apply(move([a], 100, 5))
    r.run(200)
    expect(r.tileOf(a)).toEqual({ x: 2, y: 5 })
  })

  it('retargets a click on a blocked tile to the nearest passable one', () => {
    // Clicking a tree should walk the squad to the tree, not do nothing. Doing
    // nothing is the failure players read as "the game ignored me".
    const r = rig()
    const a = r.spawn(2, 5)
    expect(r.apply(move([a], 10, 2))).toBe(true) // (10,2) is inside the #### block
    const target = r.squad.targetOf(a)
    expect(target).toBeDefined()
    expect(r.squad.targetOf(a)).not.toEqual({ x: 10, y: 2 })
  })

  it('walks the squad to a tile adjacent to the blocked one it was given', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.apply(move([a], 10, 2))
    r.run(700)
    const p = r.tileOf(a)
    expect(Math.hypot(p.x - 10, p.y - 2)).toBeLessThan(3)
  })

  it('rejects a blocked target with no passable tile anywhere near it', () => {
    const sealed = `
      ###
      ###
      ###
    `
    const level = asciiLevel(sealed)
    const world = new World(level, { seed: 1 })
    const grid = bakeNavGrid(level)
    const squad = createSquadSystem(grid, {})
    world.addSystem(squad)
    const p = tileToWorld(1, 1, level.size)
    const id = world.spawn({ kind: 'rifleman', team: 'player', x: p.x, z: p.z }).id
    expect(applyCommand(move([id], 1, 1), { world, squad, grid })).toBe(false)
  })
})

describe('applyCommand — the other variants', () => {
  it('accepts a fire command naming a living unit', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    expect(
      r.apply({ type: 'fire', unitIds: [a], ordnance: 'rifle', target: { x: 6, y: 5 } }),
    ).toBe(true)
  })

  it('drops a fire command naming only the dead', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.world.despawn(a)
    expect(
      r.apply({ type: 'fire', unitIds: [a], ordnance: 'rifle', target: { x: 6, y: 5 } }),
    ).toBe(false)
  })

  it('accepts an ordnance selection, which names no units at all', () => {
    const r = rig()
    expect(r.apply({ type: 'selectOrdnance', ordnance: 'grenade' })).toBe(true)
  })

  it('does not throw on any variant against an empty world', () => {
    const r = rig()
    expect(() => {
      r.apply(move([1], 5, 5))
      r.apply({ type: 'fire', unitIds: [1], ordnance: 'rifle', target: { x: 5, y: 5 } })
      r.apply({ type: 'selectOrdnance', ordnance: 'rifle' })
    }).not.toThrow()
  })
})

describe('the whole path, end to end', () => {
  it('a queued move actually relocates a squad', () => {
    // The one assertion that would have caught a pointer emitting `unitIds: []`
    // and an `applyCommand` dutifully refusing it: every unit test green, and
    // clicking the ground doing nothing. Push, drain, apply, tick, look.
    const r = rig()
    const squad = [r.spawn(2, 5), r.spawn(2, 6), r.spawn(3, 5)]
    const q = createCommandQueue()
    q.push(move(squad, 17, 6))
    for (const c of q.drain()) r.apply(c)
    r.run(600)
    for (const id of squad) expect(r.tileOf(id).x).toBeGreaterThan(13)
  })
})

describe('queue and apply together', () => {
  it('drains a frame of commands and applies them in order', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    const q = createCommandQueue()
    q.push(move([a], 17, 5))
    q.push(move([a], 2, 1)) // the player changed their mind
    for (const c of q.drain()) r.apply(c)
    r.run(600)
    // The LAST order wins, which is only true if they applied in FIFO order.
    const p = r.tileOf(a)
    expect(p).toEqual({ x: 2, y: 1 })
  })
})
