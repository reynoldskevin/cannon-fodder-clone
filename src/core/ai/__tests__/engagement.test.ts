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

const RANGE = WEAPONS[RIFLE]!.rangeTiles

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
    // PAST THE REACTION BEAT (ticket 012a), which is what makes `before` a real
    // baseline: he now holds fire for `reactionTicks` after entering `engage`,
    // so ten ticks caught him mid-beat with no order issued and the assertion
    // below would have measured nothing against nothing.
    r.run(60)
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
    // Past the beat, for the reason the case above gives: killed mid-beat he
    // would never have had a standing order to keep, and "fires no further
    // rounds" would pass on a man who had fired none.
    r.run(60)
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

describe('the half-tile convention', () => {
  /**
   * THE TRAP THAT HAS COST THIS PROJECT TWO REVIEW CYCLES, asserted at last.
   *
   * Integer tile coordinates name tile CENTRES, so the world-to-tile index is
   * `floor(worldX + w / 2)`. The wrong spelling — `floor(worldX + (w - 1) / 2)`
   * — is off by half a tile and reads perfectly well.
   *
   * WHY EVERY OTHER TEST IN THIS FILE IS BLIND TO IT. `clearFractionAlong`
   * FLOORS both endpoints and walks tile to tile; the fractional part is thrown
   * away. A unit standing on a tile centre sits at `tile + 0.5` under the right
   * spelling and at `tile + 0.0` under the wrong one, and those floor to the SAME
   * tile. Every sightline between two centres therefore gives the same answer
   * either way, which is exactly what a suite of centre-to-centre fixtures
   * proves nothing about. (A reviewer substituted the wrong spelling and all 951
   * tests passed.)
   *
   * The discriminator is a unit OFF centre — which, mid-stride, is nearly always.
   * At fractional tile 8.7 the right spelling floors to 9 and the wrong one to 8,
   * and here tile 8 is the wall. So under the wrong spelling this soldier
   * believes he is standing INSIDE the rock he is pressed against, and
   * `clearFractionAlong` answers 0 for a rifle inside a rock: he never sees the
   * man three tiles in front of him and never fires a round all mission.
   */
  it('a soldier hugging a wall can still see along it', () => {
    const r = rig(WALLED)
    const enemy = r.spawn(10, 5, 'enemy')
    // Pressed against the east face of the wall at x=8 — inside tile 9, six
    // tenths of a tile west of its centre. A man who has just taken cover.
    r.place(enemy.id, 8.7, 5)
    r.spawn(12, 5, 'player', 1000)
    const events = r.run(120)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(shotsBy(events, enemy.id).length).toBeGreaterThan(0)
  })

  it('and the wall on his other side still blocks him', () => {
    // The control. Without it, a conversion that had collapsed to "everything is
    // visible" would sail through the case above.
    const r = rig(WALLED)
    const enemy = r.spawn(10, 5, 'enemy')
    r.place(enemy.id, 8.7, 5)
    r.spawn(6, 5, 'player', 1000) // the far side of the wall
    const events = r.run(120)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })
})

describe('a target that dies is not a target that got away', () => {
  /**
   * THE TICKET'S HEADLINE DECISION, and it had no test until a reviewer deleted
   * the branch and watched all 951 pass.
   *
   * Losing sight of a man leaves a question — where did he go? — and `pursue` is
   * the answer to it. A dead man leaves no question. Without this, an enemy
   * either walks onto the corpse or stands over it pouring rounds into the
   * ground, and both are things the player watches happen and reads as broken.
   */
  const setup = () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    /**
     * THREE tiles, inside the shipped closing distance of 3.84 (ticket 037), so
     * he engages from the first tick. At the four tiles this used to be he now
     * walks in first, and "does not walk over to look" below would be counting
     * the APPROACH rather than a march onto the corpse — the order it exists to
     * rule out would be buried among orders that are perfectly correct.
     */
    const player = r.spawn(7, 5, 'player') // one hit point, like every soldier
    const events = r.run(120)
    return { r, enemy, player, events }
  }

  it('killed him, which is the premise', () => {
    const { r, player, events } = setup()
    expect(r.world.get(player.id)).toBeUndefined()
    expect(events.some((e) => e.type === 'UnitDied' && e.id === player.id)).toBe(true)
  })

  it('goes back to idle rather than pursuing a corpse', () => {
    const { r, enemy } = setup()
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('stops shooting at the spot where he fell', () => {
    const { r, enemy } = setup()
    expect(r.combat.isFiring(enemy.id)).toBe(false)
  })

  it('and does not walk over to look', () => {
    // `pursue` would issue a march order. `idle` issues none, so the count of
    // marches over the whole engagement is the evidence.
    const { r } = setup()
    expect(r.spy.orders).toEqual([])
  })

  it('but picks up the next man immediately, because sight outranks memory', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player')
    const second = r.spawn(7, 6, 'player', 1000)
    const events = r.run(200)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(r.world.get(second.id)!.health).toBeLessThan(1000)
    expect(shotsBy(events, enemy.id).length).toBeGreaterThan(1)
  })
})

describe('a tie is broken on the lower id, not on iteration order', () => {
  it('shoots the man who spawned first', () => {
    // The determinism-relevant half of the target rule, and "takes the nearest"
    // never reaches it: that case uses strictly unequal distances, so the
    // tie-break can be deleted outright and it still passes. Two men exactly
    // three tiles either side is the only shape that tests it.
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    const first = r.spawn(7, 5, 'player', 1000)
    const second = r.spawn(13, 5, 'player', 1000)
    r.run(60)
    expect({
      first: r.world.get(first.id)!.health < 1000,
      second: r.world.get(second.id)!.health < 1000,
      lower: first.id < second.id,
      shooter: r.ai.stateOf(enemy.id),
    }).toEqual({ first: true, second: false, lower: true, shooter: 'engage' })
  })
})
