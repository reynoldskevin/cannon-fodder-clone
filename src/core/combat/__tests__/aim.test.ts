import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem } from '../index'

/**
 * Ticket 025a — `CombatSystem.aimOf`.
 *
 * WHY THIS IS EXPOSED RATHER THAN RECOMPUTED. The renderer needs to turn a
 * firing soldier toward the point he is shooting at, and it must be the point
 * the SYSTEM is actually using. Deriving a second answer from the pointer, or
 * from the nearest enemy, is the dual-source mistake ticket 012 spent a design
 * section avoiding: two rules agree until they don't, and when they diverge the
 * man faces one way and his rounds go another — which looks like a targeting
 * bug and is really a bookkeeping one.
 *
 * The order already holds this value (`FireOrder.worldX/worldZ`). This is a
 * read, and only a read.
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
`

function rig() {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 1 })
  const combat = createCombatSystem(bakeNavGrid(level), { autoEngageTeams: [] })
  world.addSystem(combat)
  return {
    world,
    combat,
    level,
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy', health = 1000) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    /** The world point a tile's centre sits at — what `aimOf` must report. */
    at(tileX: number, tileY: number) {
      const p = tileToWorld(tileX, tileY, level.size)
      return { x: p.x, z: p.z }
    },
    run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) world.tick()
    },
  }
}

describe('aimOf reports the standing order`s aim point', () => {
  it('is undefined before any order', () => {
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    expect(r.combat.aimOf(u.id)).toBeUndefined()
  })

  it('is the aimed tile`s centre, in world units', () => {
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 9, y: 2 })
    expect(r.combat.aimOf(u.id)).toEqual(r.at(9, 2))
  })

  it('survives across ticks, because the order does', () => {
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 9, y: 2 })
    r.run(120)
    expect(r.combat.aimOf(u.id)).toEqual(r.at(9, 2))
  })

  it('moves when the order is re-aimed', () => {
    // Dragging the pointer while the button is held. The man must follow the
    // cursor, not the tile he was first pointed at.
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 9, y: 2 })
    r.run(10)
    r.combat.orderFire([u.id], { x: 1, y: 7 })
    expect(r.combat.aimOf(u.id)).toEqual(r.at(1, 7))
  })

  it('is cleared by ceaseFire', () => {
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 9, y: 2 })
    r.combat.ceaseFire([u.id])
    expect(r.combat.aimOf(u.id)).toBeUndefined()
  })

  it('is cleared when the unit dies, rather than leaking', () => {
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 9, y: 2 })
    r.run(2)
    r.world.despawn(u.id)
    r.run(2)
    expect(r.combat.aimOf(u.id)).toBeUndefined()
  })

  it('is undefined for a unit that never existed', () => {
    expect(rig().combat.aimOf(99_999)).toBeUndefined()
  })

  it('answers per unit, not for whoever fired last', () => {
    const r = rig()
    const a = r.spawn(4, 4, 'player')
    const b = r.spawn(5, 4, 'player')
    r.combat.orderFire([a.id], { x: 9, y: 2 })
    r.combat.orderFire([b.id], { x: 1, y: 7 })
    expect({ a: r.combat.aimOf(a.id), b: r.combat.aimOf(b.id) }).toEqual({
      a: r.at(9, 2),
      b: r.at(1, 7),
    })
  })
})

describe('aimOf agrees with where the rounds actually go', () => {
  it('reports the aim point even when there is nothing there to hit', () => {
    // Suppressing fire. The man is still looking somewhere, and it is the place
    // the player pointed at — a facing derived from "the nearest enemy" would
    // have nothing to work with here and would leave him staring at the ground.
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.combat.orderFire([u.id], { x: 12, y: 4 })
    const events: unknown[] = []
    r.run(60)
    for (const e of r.world.drainEvents()) if (e.type === 'ShotFired') events.push(e)
    expect(events.length).toBeGreaterThan(0)
    expect(r.combat.aimOf(u.id)).toEqual(r.at(12, 4))
  })

  it('is the AIM, not the victim — they are different points', () => {
    /**
     * The distinction that makes this worth exposing separately from the target.
     * `AIM_TOLERANCE_TILES` lets a round aimed near a man hit him, so the aim
     * point and the man's position are routinely a tile or two apart. The
     * shooter should face where the PLAYER pointed; anything else makes the
     * sprite twitch toward a target the player never selected.
     */
    const r = rig()
    const u = r.spawn(4, 4, 'player')
    r.spawn(8, 4, 'enemy')
    r.combat.orderFire([u.id], { x: 9, y: 4 }) // a tile past the enemy
    r.run(4)
    expect(r.combat.aimOf(u.id)).toEqual(r.at(9, 4))
  })
})
