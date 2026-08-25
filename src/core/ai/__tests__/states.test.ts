import { describe, it, expect } from 'vitest'
import { rig, OPEN, WALLED, shotsBy } from './rig'
import { AI_STATES } from '../index'
import { DEFAULT_ALERT_RADIUS_TILES, DEFAULT_PURSUE_TIMEOUT_TICKS } from '../tuning'
import { RIFLE, WEAPONS } from '../../combat'

/**
 * Ticket 012 — the enemy state machine, one test per EDGE.
 *
 * The acceptance criteria are written as a transition table, and this file is
 * that table made executable: every row is a state the machine can be in, a
 * trigger applied to it, and the state it must land in. Asserting the states in
 * isolation ("an enemy near a player engages") would leave the interesting half
 * untested — the machine is only worth having if the EDGES are right, and the
 * edge that matters most is the one where two triggers apply at once.
 *
 * WHY `stateOf` IS ASSERTED AND NOT JUST THE BEHAVIOUR. Both, in fact, and
 * throughout: a machine whose reported state says `engage` while the man stands
 * silent is a bug that only the behaviour catches, and a machine that fires from
 * `idle` is a bug that only the state catches. `engagement.test.ts` is where the
 * consequences live; this file is where the labels do.
 */

const RANGE = WEAPONS[RIFLE].rangeTiles

describe('the states are a closed, enumerable set', () => {
  it('is exactly idle, alert, engage and pursue', () => {
    // Enumerable because a HUD, a debug overlay (ticket 014) and any later
    // behaviour tree all need to name them, and because a fifth state added
    // without a decision is the way a small machine stops being small.
    expect([...AI_STATES].sort()).toEqual(['alert', 'engage', 'idle', 'pursue'])
  })
})

describe('an enemy with nothing to do', () => {
  it('is idle, and stays idle', () => {
    const r = rig()
    const enemy = r.spawn(16, 5, 'enemy')
    r.spawn(1, 5, 'player') // 15 tiles: beyond the 12 of sight
    r.run(120)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('does not move, and does not shoot', () => {
    const r = rig()
    const enemy = r.spawn(16, 5, 'enemy')
    r.spawn(1, 5, 'player')
    const before = { x: r.world.get(enemy.id)!.x, z: r.world.get(enemy.id)!.z }
    const events = r.run(120)
    expect(r.world.get(enemy.id)!.x).toBe(before.x)
    expect(r.world.get(enemy.id)!.z).toBe(before.z)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })
})

describe('idle → engage: a target in sight and in range', () => {
  it('enters engage', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000) // 4 tiles: inside the rifle's 8
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('fires on cooldown while it lasts', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    const events = r.run(120)
    // Two seconds at a 32-tick cooldown is three or four rounds. Asserted as a
    // range rather than a number, because the exact count depends on which tick
    // acquisition lands on and pinning it would make this a test of the
    // scheduling rather than of the state.
    expect(shotsBy(events, enemy.id).length).toBeGreaterThanOrEqual(3)
  })

  it('halts where it stands rather than closing further', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    const startX = r.world.get(enemy.id)!.x
    r.run(120)
    // A man who walks into his own weapon's range and keeps walking ends the
    // engagement in knife range, which wastes every piece of cover the level
    // contains. Within a tile of where he started is "he planted his feet".
    expect(Math.abs(r.world.get(enemy.id)!.x - startX)).toBeLessThan(1)
  })
})

describe('idle → pursue: a target in sight but out of range', () => {
  const setup = () => {
    const r = rig()
    const enemy = r.spawn(16, 5, 'enemy')
    // 5 to 16 is 11 tiles: inside the 12 of sight, outside the rifle's 8.
    r.spawn(5, 5, 'player', 1000)
    return { r, enemy }
  }

  it('enters pursue rather than engage', () => {
    const { r, enemy } = setup()
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
  })

  it('closes the distance', () => {
    const { r, enemy } = setup()
    const startX = r.world.get(enemy.id)!.x
    r.run(30)
    expect(r.world.get(enemy.id)!.x).toBeLessThan(startX - 0.5)
  })

  it('does not fire while it is still out of range', () => {
    const { r, enemy } = setup()
    // Half a second. At 3 tiles a second he covers 1.5 of the 3 tiles he needs
    // to be in range, so every tick in this window is an out-of-range tick.
    const events = r.run(30)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })

  it('and then engages once it is close enough', () => {
    const { r, enemy } = setup()
    const events = r.run(300)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(shotsBy(events, enemy.id).length).toBeGreaterThan(0)
  })
})

describe('engage → pursue: the target goes out of sight', () => {
  /**
   * The player is moved behind the wall by hand rather than walked there. What
   * is under test is the machine's reaction to LOSING a target, and walking him
   * out of sight would make this a test of the squad system's pathing as well —
   * two things failing into one assertion.
   */
  const setup = () => {
    const r = rig(WALLED)
    const enemy = r.spawn(12, 5, 'enemy')
    const player = r.spawn(15, 5, 'player', 1000)
    r.run(4)
    return { r, enemy, player }
  }

  it('was engaging first', () => {
    // Stated as its own case so that a setup which silently stopped producing an
    // engagement could not make every assertion below vacuously true.
    const { r, enemy } = setup()
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('enters pursue when sight is broken', () => {
    const { r, enemy, player } = setup()
    r.place(player.id, 3, 5) // the far side of the wall at x=8
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
  })

  it('walks to where the target was last SEEN, not to where it now is', () => {
    const { r, enemy, player } = setup()
    r.place(player.id, 3, 5)
    r.run(200)
    const at = r.tileOf(enemy.id)
    // Last seen at (15,5), three tiles east of him. The wall at x=8 stands
    // between him and the live position at (3,5), so a machine chasing THAT
    // would have spent these 200 ticks walking west into it.
    expect(at.x).toBeGreaterThanOrEqual(14)
  })

  it('gives up once the errand is done', () => {
    const { r, enemy, player } = setup()
    r.place(player.id, 3, 5)
    r.run(200)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('gives up on the timeout even when it never arrives', () => {
    /**
     * THE TIMEOUT ON ITS OWN. The case above reaches the last-known position and
     * gives up because the errand is over, which would pass with no timeout in
     * the machine at all — so it proves nothing about one. Here the target is
     * eleven tiles away and removed from the world entirely, so at three tiles a
     * second the walk takes ~220 ticks and the timeout is the ONLY thing that
     * can end it.
     */
    const r = rig(OPEN, { pursueTimeoutTicks: 30 })
    const enemy = r.spawn(16, 5, 'enemy')
    const player = r.spawn(5, 5, 'player', 1000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')

    r.world.despawn(player.id)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue') // not yet
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('idle') // now
  })

  it('holds the default timeout well clear of a tick or two', () => {
    // The case above supplies its own timeout, so nothing there would notice if
    // the DEFAULT collapsed to zero and every pursuit ended the tick it began.
    expect(DEFAULT_PURSUE_TIMEOUT_TICKS).toBeGreaterThan(60)
  })

  it('stops firing the moment it loses the target', () => {
    const { r, enemy, player } = setup()
    r.place(player.id, 3, 5)
    const events = r.run(200)
    expect(shotsBy(events, enemy.id)).toHaveLength(0)
  })
})

describe('pursue → engage: acquisition outranks memory', () => {
  it('re-engages a target that reappears mid-pursuit', () => {
    // The failure this guards against is a machine that walks its errand out
    // before looking up. Nothing about `pursue` should survive a live target
    // standing in front of the man.
    const r = rig(WALLED)
    const enemy = r.spawn(12, 5, 'enemy')
    const player = r.spawn(15, 5, 'player', 1000)
    r.run(4)
    r.place(player.id, 3, 5)
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')

    r.place(player.id, 14, 5)
    const events = r.run(60)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(shotsBy(events, enemy.id).length).toBeGreaterThan(0)
  })
})

describe('idle → alert: gunfire within earshot', () => {
  /**
   * The trigger is an EVENT, not a position, which is why these are the only
   * tests in the file that call `hear` directly. `rig.run` already feeds the AI
   * every event the tick emitted, exactly as the session does; these cases add
   * a shot that no unit on the map actually fired, so that the audible radius
   * can be probed on both sides without arranging a firefight to produce it.
   */
  const lonely = () => {
    const r = rig()
    const enemy = r.spawn(16, 5, 'enemy')
    return { r, enemy }
  }

  it('goes to alert on a shot inside the radius', () => {
    const { r, enemy } = lonely()
    r.ai.hear([r.shotAt(16 - (DEFAULT_ALERT_RADIUS_TILES - 2), 5)])
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBe('alert')
  })

  it('and walks toward it', () => {
    const { r, enemy } = lonely()
    const startX = r.world.get(enemy.id)!.x
    r.ai.hear([r.shotAt(16 - (DEFAULT_ALERT_RADIUS_TILES - 2), 5)])
    r.run(30)
    expect(r.world.get(enemy.id)!.x).toBeLessThan(startX - 0.5)
  })

  it('ignores a shot outside the radius', () => {
    const { r, enemy } = lonely()
    const startX = r.world.get(enemy.id)!.x
    // Two tiles beyond earshot. Deliberately close to the boundary: a radius
    // that had quietly become "the whole map" would pass a distant-shot test
    // written at the far corner.
    r.ai.hear([r.shotAt(16 - (DEFAULT_ALERT_RADIUS_TILES + 2), 5)])
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    expect(r.world.get(enemy.id)!.x).toBe(startX)
  })

  it('does not alert on its own gunfire', () => {
    // Otherwise a man who fires walks toward himself, which reads as an engaged
    // soldier drifting off his firing position for no reason the player can see.
    const { r, enemy } = lonely()
    const startX = r.world.get(enemy.id)!.x
    r.ai.hear([r.shotAt(10, 5, enemy.id)])
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    expect(r.world.get(enemy.id)!.x).toBe(startX)
  })

  it('returns to idle after the errand', () => {
    const { r, enemy } = lonely()
    r.ai.hear([r.shotAt(12, 5)])
    r.run(400)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('does not interrupt an engagement', () => {
    // `alert` is what a man does when he has nothing better to do. A shot from
    // across the map must not pull him off a target he can see.
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.ai.hear([r.shotAt(14, 5)])
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })
})

describe('what the machine never does', () => {
  it('holds no state for a unit that is dead', () => {
    const r = rig()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(6, 5, 'player', 1000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.world.despawn(enemy.id)
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBeUndefined()
  })

  it('holds no state for a unit that never existed', () => {
    const r = rig()
    expect(r.ai.stateOf(99_999)).toBeUndefined()
  })

  it('commands no player unit — ever', () => {
    // The AI shares one `SquadSystem` with the player's pointer. An `order` that
    // named a player id would take the squad off the march the owner gave it,
    // and it would look like the controls fighting back.
    const r = rig()
    r.spawn(10, 5, 'enemy')
    r.spawn(16, 8, 'enemy')
    const a = r.spawn(6, 5, 'player', 1000)
    const b = r.spawn(5, 8, 'player', 1000)
    r.run(200)
    const players = new Set([a.id, b.id])
    const named = [
      ...r.spy.orders.flatMap((o) => o.unitIds),
      ...r.spy.halts.flat(),
      ...r.spy.fires.flatMap((f) => f.unitIds),
      ...r.spy.ceases.flat(),
    ]
    expect(named.filter((id) => players.has(id))).toEqual([])
    expect(named.length).toBeGreaterThan(0) // it did command SOMETHING
  })

  it('does not re-issue an order it has already given', () => {
    // One `order` per tick per pursuing man is a flow-field lookup per tick per
    // man, and it rebuilds a detachment each time. Re-issued only when the
    // destination TILE changes.
    const r = rig()
    r.spawn(16, 5, 'enemy')
    r.spawn(5, 5, 'player', 1000)
    r.run(60)
    expect(r.spy.orders.length).toBeGreaterThan(0)
    expect(r.spy.orders.length).toBeLessThan(20)
  })
})

describe('range is the rifle`s, not a number of its own', () => {
  it('engages at the weapon`s range and pursues past it', () => {
    // Two sessions differing only in one tile of separation, straddling the
    // range the rifle actually declares. If the machine ever hardcoded an eight,
    // a retune in `weapons.ts` would silently stop matching what the men do.
    const near = rig()
    const nearEnemy = near.spawn(10, 5, 'enemy')
    near.spawn(10 - (RANGE - 1), 5, 'player', 1000)
    near.run(4)

    const far = rig()
    const farEnemy = far.spawn(16, 5, 'enemy')
    far.spawn(16 - (RANGE + 2), 5, 'player', 1000)
    far.run(4)

    expect({ near: near.ai.stateOf(nearEnemy.id), far: far.ai.stateOf(farEnemy.id) }).toEqual({
      near: 'engage',
      far: 'pursue',
    })
  })
})
