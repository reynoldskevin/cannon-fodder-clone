import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import type { Entity } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem, WEAPONS, RIFLE } from '../index'
import type { CombatSystem } from '../index'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 011a — the player squad holds fire until told.
 *
 * Ticket 011 made every unit engage anything in range, which is right for the
 * enemy and wrong for the player: the owner wants to choose when his men shoot.
 * So auto-engagement becomes a per-TEAM policy, and a team outside it fires only
 * on a standing order.
 *
 * TWO THINGS THAT LOOK LIKE THE SAME TEST AND ARE NOT. "Does a commanded unit
 * fire" and "does an uncommanded unit hold" are different failures with
 * different consequences: the first is a control that does nothing, which the
 * player notices in a second; the second is men who shoot on their own, which
 * the player only notices when a firefight starts somewhere they did not want
 * one. Both are asserted, in both directions, for both teams.
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

interface Rig {
  readonly world: World
  readonly combat: CombatSystem
  spawn(tileX: number, tileY: number, team: 'player' | 'enemy', health?: number): Entity
  run(ticks: number): SimEvent[]
  aim(tileX: number, tileY: number): { x: number; y: number }
}

function rig(art = OPEN, autoEngageTeams?: readonly ('player' | 'enemy')[]): Rig {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const combat = createCombatSystem(grid, autoEngageTeams ? { autoEngageTeams } : {})
  world.addSystem(combat)
  world.drainEvents()
  return {
    world,
    combat,
    spawn(tileX, tileY, team, health) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn(
        health === undefined
          ? { kind: 'rifleman', team, x: p.x, z: p.z }
          : { kind: 'rifleman', team, x: p.x, z: p.z, health },
      )
    },
    run(ticks) {
      const events: SimEvent[] = []
      for (let i = 0; i < ticks; i++) {
        world.tick()
        events.push(...world.drainEvents())
      }
      return events
    },
    aim: (tileX, tileY) => ({ x: tileX, y: tileY }),
  }
}

const shots = (events: readonly SimEvent[]): SimEvent[] =>
  events.filter((e) => e.type === 'ShotFired')

/** Only the player holds fire; the enemy still engages on its own. */
const COMMANDED = ['enemy'] as const

describe('the default is unchanged', () => {
  it('still auto-engages both teams when no policy is given', () => {
    // Ticket 011's entire contract rests on this. A default that quietly changed
    // would be a second, invisible edit to a merged ticket.
    const r = rig()
    r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    expect(shots(r.run(5)).length).toBeGreaterThan(0)
  })
})

describe('a team outside the auto-engage policy holds fire', () => {
  it('does not shoot an enemy in plain sight, at point-blank range', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(5, 4, 'enemy', 1000)
    const fired = shots(r.run(200)).filter(
      (e) => e.type === 'ShotFired' && e.shooterId === me.id,
    )
    expect(fired).toEqual([])
  })

  it('holds fire even while being shot at', () => {
    // No automatic return fire. The men stand there and take it until ordered,
    // which is exactly what "not automatic" costs and what the owner asked for.
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    const events = r.run(200)
    expect(shots(events).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id)).toEqual([])
    // Non-vacuous: the enemy was definitely shooting.
    expect(shots(events).length).toBeGreaterThan(0)
  })

  it('leaves the enemy team engaging on its own', () => {
    const r = rig(OPEN, COMMANDED)
    r.spawn(4, 4, 'player', 1000)
    const enemy = r.spawn(6, 4, 'enemy', 1000)
    const fired = shots(r.run(60)).filter((e) => e.type === 'ShotFired' && e.shooterId === enemy.id)
    expect(fired.length).toBeGreaterThan(0)
  })
})

describe('orderFire', () => {
  it('makes a held-fire unit shoot', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    expect(shots(r.run(5)).length).toBeGreaterThan(0)
  })

  it('reports that the unit is firing', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    expect(r.combat.isFiring(me.id)).toBe(false)
    r.combat.orderFire([me.id], r.aim(6, 4))
    expect(r.combat.isFiring(me.id)).toBe(true)
  })

  it('keeps firing across ticks while the order stands', () => {
    // The order is a STANCE, not a trigger: the player holds the button down and
    // the men keep shooting. One shot per cooldown, not one shot ever.
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    const mine = shots(r.run(200)).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id)
    expect(mine.length).toBeGreaterThan(3)
  })

  it('obeys the cooldown rather than firing every tick', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    const spec = WEAPONS[RIFLE]!
    const mine = shots(r.run(180)).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id)
    expect(mine.length).toBeLessThanOrEqual(Math.ceil(180 / spec.cooldownTicks) + 1)
  })

  it('orders exactly the units named', () => {
    const r = rig(OPEN, COMMANDED)
    const ordered = r.spawn(4, 4, 'player', 1000)
    const idle = r.spawn(4, 6, 'player', 1000)
    r.spawn(6, 5, 'enemy', 1000)
    r.combat.orderFire([ordered.id], r.aim(6, 5))
    const events = shots(r.run(120))
    expect(events.some((e) => e.type === 'ShotFired' && e.shooterId === ordered.id)).toBe(true)
    expect(events.some((e) => e.type === 'ShotFired' && e.shooterId === idle.id)).toBe(false)
  })

  it('ignores dead and unknown ids without throwing', () => {
    const r = rig(OPEN, COMMANDED)
    const dead = r.spawn(4, 4, 'player')
    r.world.despawn(dead.id)
    expect(() => {
      r.combat.orderFire([dead.id, 9999], r.aim(6, 4))
      r.run(10)
    }).not.toThrow()
  })

  it('does not leak the order when the unit dies', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    r.world.despawn(me.id)
    r.run(5)
    expect(r.combat.isFiring(me.id)).toBe(false)
  })
})

describe('ceaseFire', () => {
  it('stops a unit firing', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    expect(shots(r.run(120)).length).toBeGreaterThan(0)
    r.combat.ceaseFire([me.id])
    expect(r.combat.isFiring(me.id)).toBe(false)
    expect(shots(r.run(200)).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id)).toEqual(
      [],
    )
  })

  it('stops exactly the units named', () => {
    const r = rig(OPEN, COMMANDED)
    const stopped = r.spawn(4, 3, 'player', 1000)
    const carriesOn = r.spawn(4, 5, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([stopped.id, carriesOn.id], r.aim(6, 4))
    r.combat.ceaseFire([stopped.id])
    const events = shots(r.run(150))
    expect(events.some((e) => e.type === 'ShotFired' && e.shooterId === stopped.id)).toBe(false)
    expect(events.some((e) => e.type === 'ShotFired' && e.shooterId === carriesOn.id)).toBe(true)
  })

  it('is harmless on a unit that was never firing', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player')
    expect(() => {
      r.combat.ceaseFire([me.id, 4242])
    }).not.toThrow()
  })
})

describe('what a commanded shot hits', () => {
  it('kills an enemy at the aim point', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    const enemy = r.spawn(6, 4, 'enemy')
    r.combat.orderFire([me.id], r.aim(6, 4))
    r.run(10)
    expect(r.world.isAlive(enemy.id)).toBe(false)
  })

  it('picks the enemy nearest the AIM POINT, not the one nearest the shooter', () => {
    // The whole reason aim is carried on the order. Right-clicking one man in a
    // crowd must shoot the one pointed at; picking by distance from the shooter
    // would shoot whoever happened to be closest, which is not what was clicked.
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(2, 4, 'player', 1000)
    const near = r.spawn(4, 4, 'enemy')
    const far = r.spawn(8, 4, 'enemy')
    r.combat.orderFire([me.id], r.aim(8, 4))
    r.run(10)
    expect(r.world.isAlive(far.id)).toBe(false)
    expect(r.world.isAlive(near.id)).toBe(true)
  })

  it('fires at nothing rather than silently doing nothing', () => {
    // With no ordnance and no FX, the event and the animation are the ONLY
    // feedback a right-click on empty ground produces. Silence reads as a
    // broken control.
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.combat.orderFire([me.id], r.aim(7, 4))
    const fired = shots(r.run(10)).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id)
    expect(fired.length).toBeGreaterThan(0)
    expect(fired[0]!.type === 'ShotFired' && fired[0]!.targetId).toBeNull()
  })

  it('aims suppressing fire at the point it was given', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.combat.orderFire([me.id], r.aim(7, 6))
    const fired = shots(r.run(5))[0]!
    const where = tileToWorld(7, 6, { w: 20, h: 10 })
    expect(fired.type === 'ShotFired' && fired.targetX).toBeCloseTo(where.x, 6)
    expect(fired.type === 'ShotFired' && fired.targetZ).toBeCloseTo(where.z, 6)
  })

  it('still respects the weapon`s range', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(1, 4, 'player', 1000)
    const far = r.spawn(1 + WEAPONS[RIFLE]!.rangeTiles + 4, 4, 'enemy')
    r.combat.orderFire([me.id], r.aim(1 + WEAPONS[RIFLE]!.rangeTiles + 4, 4))
    r.run(120)
    expect(r.world.isAlive(far.id)).toBe(true)
  })

  it('still respects line of sight', () => {
    const WALL = `
      ....#....
      ....#....
      ....#....
    `
    const r = rig(WALL, COMMANDED)
    const me = r.spawn(1, 1, 'player', 1000)
    const hidden = r.spawn(7, 1, 'enemy')
    r.combat.orderFire([me.id], r.aim(7, 1))
    r.run(120)
    expect(r.world.isAlive(hidden.id)).toBe(true)
  })

  it('does not shoot its own team, even when aimed at them', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    const mate = r.spawn(6, 4, 'player')
    r.combat.orderFire([me.id], r.aim(6, 4))
    r.run(120)
    expect(r.world.isAlive(mate.id)).toBe(true)
  })
})

describe('re-aiming', () => {
  it('takes the newest aim point', () => {
    // Dragging the pointer while the button is held re-issues the order.
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(2, 4, 'player', 1000)
    const first = r.spawn(4, 4, 'enemy')
    const second = r.spawn(6, 4, 'enemy')
    r.combat.orderFire([me.id], r.aim(4, 4))
    r.combat.orderFire([me.id], r.aim(6, 4))
    r.run(10)
    expect(r.world.isAlive(second.id)).toBe(false)
    expect(r.world.isAlive(first.id)).toBe(true)
  })

  it('does not restart the cooldown, so dragging is not a rapid-fire exploit', () => {
    const r = rig(OPEN, COMMANDED)
    const me = r.spawn(4, 4, 'player', 1000)
    r.spawn(6, 4, 'enemy', 1000)
    r.combat.orderFire([me.id], r.aim(6, 4))
    const spec = WEAPONS[RIFLE]!
    let fired = 0
    for (let t = 0; t < 180; t++) {
      r.combat.orderFire([me.id], r.aim(6, 4)) // re-aimed every single tick
      fired += shots(r.run(1)).filter((e) => e.type === 'ShotFired' && e.shooterId === me.id).length
    }
    expect(fired).toBeLessThanOrEqual(Math.ceil(180 / spec.cooldownTicks) + 1)
  })
})

describe('determinism', () => {
  it('two identical commanded worlds produce identical event streams', () => {
    const build = (): SimEvent[] => {
      const r = rig(OPEN, COMMANDED)
      const a = r.spawn(3, 4, 'player', 5)
      const b = r.spawn(3, 6, 'player', 5)
      r.spawn(7, 4, 'enemy', 5)
      r.spawn(7, 6, 'enemy', 5)
      r.combat.orderFire([a.id, b.id], r.aim(7, 5))
      return r.run(300)
    }
    const first = build()
    expect(first.length).toBeGreaterThan(4) // non-vacuous
    expect(first).toEqual(build())
  })
})
