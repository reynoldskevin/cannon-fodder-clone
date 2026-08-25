import { describe, it, expect } from 'vitest'
import { rig, OPEN, WALLED, shots, shotsBy } from './rig'
import { RIFLE, WEAPONS } from '../../combat'

/**
 * Ticket 012 — what the machine's decisions actually DO to the world.
 *
 * `states.test.ts` asserts the labels; this file asserts the consequences, and
 * the two are separated because the failures are different. A machine that
 * reports `engage` and never pulls the trigger passes every state assertion
 * ever written. A machine that kills the player from `idle`, through a wall,
 * from across the map, passes them too.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: an enemy round is subject to exactly the
 * constraints a player's round is — range and line of sight — because the AI
 * shoots by giving `CombatSystem` an order, not by reaching past it. A dying
 * player must always be able to point at the wall or the distance that killed
 * him.
 */

const RANGE = WEAPONS[RIFLE].rangeTiles

describe('a round the machine fires is a real round', () => {
  it('damages the man it was aimed at', () => {
    const r = rig()
    r.spawn(10, 5, 'enemy')
    const player = r.spawn(6, 5, 'player', 1000)
    r.run(120)
    expect(r.world.get(player.id)!.health).toBeLessThan(1000)
  })

  it('kills an ordinary soldier outright', () => {
    // One hit point, one round. The whole tension of the game is in this line,
    // and it must be as true of an enemy's round as of the player's.
    const r = rig()
    r.spawn(10, 5, 'enemy')
    const player = r.spawn(6, 5, 'player')
    const events = r.run(120)
    expect(r.world.get(player.id)).toBeUndefined()
    expect(events.some((e) => e.type === 'UnitDied' && e.id === player.id)).toBe(true)
  })

  it('reports the shooter as the enemy that decided to fire', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    const events = r.run(120)
    expect(shots(events).every((e) => e.type === 'ShotFired' && e.shooterId === enemy.id)).toBe(true)
  })
})

describe('never through a wall', () => {
  it('does not fire at a target it cannot see', () => {
    const r = rig(WALLED)
    const enemy = r.spawn(10, 5, 'enemy')
    // Three tiles apart and the wall at x=8 between them. Well inside both the
    // rifle's range and the machine's sight; the ONLY thing stopping this shot
    // is the sightline.
    r.spawn(7, 5, 'player', 1000)
    const events = r.run(300)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })

  it('leaves that target unharmed', () => {
    const r = rig(WALLED)
    r.spawn(10, 5, 'enemy')
    const player = r.spawn(7, 5, 'player', 1000)
    r.run(300)
    expect(r.world.get(player.id)!.health).toBe(1000)
  })

  it('and the same pair with the wall removed does fire — so the setup was live', () => {
    /**
     * The control. Without it, a rig that failed to spawn anybody, an AI that
     * was never registered, or a target on the wrong team would make both cases
     * above pass for reasons that have nothing to do with line of sight — which
     * is the most common way a negative assertion rots.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(7, 5, 'player', 1000)
    const events = r.run(300)
    expect(shotsBy(events, enemy.id).length).toBeGreaterThan(0)
  })
})

describe('never beyond the weapon', () => {
  it('does not fire at a target further away than the rifle reaches', () => {
    const r = rig()
    const enemy = r.spawn(16, 5, 'enemy')
    // Two tiles beyond the rifle, inside the machine's sight. He will close the
    // distance — that is what `pursue` is for — so the window is short enough
    // that every tick in it is an out-of-range tick.
    r.spawn(16 - (RANGE + 2), 5, 'player', 1000)
    const events = r.run(20)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })

  it('does not fire at a target beyond sight at all', () => {
    const r = rig()
    const enemy = r.spawn(18, 5, 'enemy')
    r.spawn(1, 5, 'player', 1000)
    const events = r.run(300)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })
})

describe('who it shoots at when there is a choice', () => {
  it('takes the nearest', () => {
    // The same rule `CombatSystem` uses for auto-engage, deliberately: two
    // target-choice rules in one codebase disagree eventually, and the
    // disagreement is invisible because the man fires either way.
    const r = rig()
    r.spawn(10, 5, 'enemy')
    const near = r.spawn(7, 5, 'player', 1000)
    const far = r.spawn(4, 5, 'player', 1000)
    r.run(60)
    expect({
      near: r.world.get(near.id)!.health < 1000,
      far: r.world.get(far.id)!.health < 1000,
    }).toEqual({ near: true, far: false })
  })
})

describe('death is cleaned up, not leaked', () => {
  it('a killed enemy stops issuing orders', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    r.run(10)
    const before = r.spy.fires.length + r.spy.orders.length
    expect(before).toBeGreaterThan(0)

    r.world.despawn(enemy.id)
    r.run(120)
    expect(r.spy.fires.length + r.spy.orders.length).toBe(before)
  })

  it('a killed enemy fires no further rounds', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    r.run(10)
    r.world.despawn(enemy.id)
    const events = r.run(300)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })

  it('two enemies are tracked independently', () => {
    // One entry per unit, and killing one must not disturb the other. A machine
    // keyed on anything shakier than the entity id — an index into the entity
    // array, say, which `despawn` compacts — fails exactly here.
    const r = rig()
    const a = r.spawn(10, 5, 'enemy')
    const b = r.spawn(10, 8, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    r.spawn(6, 8, 'player', 1000)
    r.run(10)
    expect({ a: r.ai.stateOf(a.id), b: r.ai.stateOf(b.id) }).toEqual({
      a: 'engage',
      b: 'engage',
    })

    r.world.despawn(a.id)
    const events = r.run(120)
    expect(r.ai.stateOf(a.id)).toBeUndefined()
    expect(r.ai.stateOf(b.id)).toBe('engage')
    expect(shotsBy(events, b.id).length).toBeGreaterThan(0)
  })
})

describe('the player team is not driven by this system', () => {
  it('a player unit with an enemy in plain sight still holds fire', () => {
    // The AI commands one team. If it ever grew a second, the player's squad
    // would start fighting on its own and ticket 011a's whole decision — that
    // the owner chooses when his men shoot — would be undone from a new file.
    const r = rig()
    r.spawn(10, 5, 'enemy', 1000)
    const player = r.spawn(6, 5, 'player', 1000)
    const events = r.run(200)
    expect(shotsBy(events, player.id)).toHaveLength(0)
    expect(r.ai.stateOf(player.id)).toBeUndefined()
  })

  it('and does not walk anywhere on its own', () => {
    const r = rig()
    r.spawn(16, 5, 'enemy', 1000)
    const player = r.spawn(6, 5, 'player', 1000)
    const before = { x: r.world.get(player.id)!.x, z: r.world.get(player.id)!.z }
    r.run(60)
    expect({ x: r.world.get(player.id)!.x, z: r.world.get(player.id)!.z }).toEqual(before)
  })
})
