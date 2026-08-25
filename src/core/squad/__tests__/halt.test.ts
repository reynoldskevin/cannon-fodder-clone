import { describe, it, expect } from 'vitest'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { createSquadSystem } from '../index'
import { tileToWorld } from '../../view/projection'
import { World } from '../../world/world'

/**
 * `SquadSystem.halt` — added by ticket 012, because the AI needs it.
 *
 * WHY THIS IS A MISSING PRIMITIVE AND NOT A CONVENIENCE. An enemy that acquires
 * a target has to plant its feet and shoot. Without `halt` the only way to stop
 * a unit is to order it to the tile it is standing on — and an order aims at a
 * tile CENTRE, so the man shuffles up to 0.71 tiles sideways at the exact
 * moment he is supposed to have stopped. Ordering a stop and getting a step is
 * not a stop.
 *
 * THE STATE RESET IS HALF THE POINT, and the easier half to leave out. Movement
 * writes `entity.state` every tick it runs, so a unit dropped out of its
 * detachment keeps whatever the last step wrote. Halt a walking man without
 * clearing it and he stands perfectly still, walk-animating on the spot,
 * forever — which is the bug ticket 011a's idle animation was introduced to
 * fix, arriving again through a different door.
 */

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

function rig() {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 1 })
  const squad = createSquadSystem(bakeNavGrid(level), {})
  world.addSystem(squad)
  return {
    world,
    squad,
    spawn(tileX: number, tileY: number) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team: 'player', x: p.x, z: p.z, health: 1000 })
    },
    run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) world.tick()
    },
  }
}

describe('halt stops a unit where it stands', () => {
  it('the unit was moving first', () => {
    // Its own case, so that a halt which "worked" because the man never set off
    // could not pass the assertions below.
    const r = rig()
    const a = r.spawn(2, 5)
    const before = r.world.get(a.id)!.x
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(30)
    expect(r.world.get(a.id)!.x).toBeGreaterThan(before + 0.5)
  })

  it('it stops moving', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(30)
    r.squad.halt([a.id])
    r.run(1)
    const at = { x: r.world.get(a.id)!.x, z: r.world.get(a.id)!.z }
    r.run(120)
    expect({ x: r.world.get(a.id)!.x, z: r.world.get(a.id)!.z }).toEqual(at)
  })

  it('it stops where it was, not at the nearest tile centre', () => {
    // The specific failure that ordering-a-stop produces. Halted mid-stride, a
    // man must not finish the stride.
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(25) // an arbitrary count, so he is somewhere between tile centres
    const at = r.world.get(a.id)!.x
    r.squad.halt([a.id])
    r.run(60)
    expect(Math.abs(r.world.get(a.id)!.x - at)).toBeLessThan(1e-9)
  })

  it('its state is idle, not moving', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(30)
    expect(r.world.get(a.id)!.state).toBe('moving')
    r.squad.halt([a.id])
    r.run(1)
    expect(r.world.get(a.id)!.state).toBe('idle')
  })

  it('it can be ordered again afterwards', () => {
    // Halt takes a unit out of command; it must not blacklist it.
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(30)
    r.squad.halt([a.id])
    r.run(5)
    const at = r.world.get(a.id)!.x
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(30)
    expect(r.world.get(a.id)!.x).toBeGreaterThan(at + 0.5)
  })
})

describe('halt names units, not the whole world', () => {
  it('leaves another detachment marching', () => {
    const r = rig()
    const a = r.spawn(2, 3)
    const b = r.spawn(2, 8)
    r.squad.order([a.id], { x: 16, y: 3 })
    r.squad.order([b.id], { x: 16, y: 8 })
    r.run(30)
    const bAt = r.world.get(b.id)!.x
    r.squad.halt([a.id])
    r.run(60)
    expect(r.world.get(b.id)!.x).toBeGreaterThan(bAt + 0.5)
  })

  it('halts only the named members of a shared detachment', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    const b = r.spawn(3, 5)
    r.squad.order([a.id, b.id], { x: 16, y: 5 })
    r.run(30)
    const bAt = r.world.get(b.id)!.x
    r.squad.halt([a.id])
    r.run(1)
    const aAt = r.world.get(a.id)!.x
    r.run(60)
    expect({
      aMoved: Math.abs(r.world.get(a.id)!.x - aAt) > 1e-9,
      bMoved: r.world.get(b.id)!.x > bAt + 0.5,
    }).toEqual({ aMoved: false, bMoved: true })
  })

  it('ignores ids that name nothing living', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(10)
    expect(() => r.squad.halt([99_999, -1])).not.toThrow()
    r.run(20)
    // And the order it did not name is still being carried out.
    expect(r.world.get(a.id)!.state).toBe('moving')
  })

  it('is harmless on a unit that was never under command', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    const before = { x: r.world.get(a.id)!.x, z: r.world.get(a.id)!.z }
    r.squad.halt([a.id])
    r.run(10)
    expect({ x: r.world.get(a.id)!.x, z: r.world.get(a.id)!.z }).toEqual(before)
  })

  it('drops the halted unit from the detachment count when it empties', () => {
    const r = rig()
    const a = r.spawn(2, 5)
    r.squad.order([a.id], { x: 16, y: 5 })
    r.run(5)
    expect(r.squad.detachmentCount).toBe(1)
    r.squad.halt([a.id])
    r.run(2)
    expect(r.squad.detachmentCount).toBe(0)
    expect(r.squad.targetOf(a.id)).toBeUndefined()
  })
})
