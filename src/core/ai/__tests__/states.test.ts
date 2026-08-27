import { describe, it, expect } from 'vitest'
import { rig, OPEN, WALLED, shotsBy, WEST, EAST } from './rig'
import type { AiOptions } from '../index'
import { AI_STATES } from '../index'
import { DEFAULT_ALERT_RADIUS_TILES, DEFAULT_PURSUE_TIMEOUT_TICKS } from '../tuning'
import { weaponFor } from '../../combat'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../archetypes'

/**
 * Every enemy this suite spawns is faced at its own fixture (ticket 038).
 *
 * These cases were written when sight was a disc, so they park their player due
 * east or west of the enemy — 90 degrees off the shipped southward default, at
 * which nothing is acquired and every assertion here becomes a test of the
 * vision cone instead of a test of its own subject. The arc has its own suite in
 * `vision-cone.test.ts`, which runs on the shipped default.
 */
const arena = (art = OPEN, options: Partial<AiOptions> = {}) => rig(art, options, WEST)


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

/**
 * The reach of the weapon THE HUNTER HOLDS. Every fixture in this file spawns
 * its hunter on the enemy team, and since ticket 036 that is the shorter
 * `ENEMY_RIFLE` — 6.4 tiles against the squad's 8. Read from the table rather
 * than typed, which is the whole point of the assertion at the bottom of the
 * file: if the machine ever hardcoded a range, a retune here would stop
 * matching what the men do.
 */
const RANGE = weaponFor('rifleman', 'enemy')!.rangeTiles

/**
 * The fraction of that range he actually walks to before halting (ticket 037).
 * Read from the shipped row for the same reason `RANGE` is read from the weapon
 * table: a fixture that restated either number could not tell "the machine used
 * the table" apart from "the machine and the fixture happen to agree".
 */
const CLOSE_TO = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]!.closeToFraction

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
    const r = arena()
    const enemy = r.spawn(16, 5, 'enemy')
    r.spawn(1, 5, 'player') // 15 tiles: beyond the 12 of sight
    r.run(120)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('does not move, and does not shoot', () => {
    const r = arena()
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
    const r = arena()
    const enemy = r.spawn(10, 5, 'enemy')
    // THREE tiles, not the four this used to be. Ticket 037 stopped the enemy
    // at `closeToFraction` of his range rather than at the edge of it, and at
    // the shipped 0.6 of a 6.4-tile rifle that is 3.84 — so four tiles is now a
    // `pursue` and this case would be asserting the approach, not the label.
    r.spawn(7, 5, 'player', 1000)
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('fires on cooldown while it lasts', () => {
    const r = arena()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(7, 5, 'player', 1000) // inside the closing distance — see above
    const events = r.run(220)
    /**
     * Asserted as a floor rather than a number, because the exact count depends
     * on which tick acquisition lands on and pinning it would make this a test
     * of the scheduling rather than of the state.
     *
     * THE WINDOW GREW WITH TICKET 036 AND THE FLOOR DID NOT. The enemy's
     * cooldown went 32 → 52, so 120 ticks — which used to hold three or four
     * rounds — now holds two once the 45-tick reaction beat is paid, and this
     * failed for exactly the reason the ticket intends. Widening the window
     * keeps the assertion about "he keeps firing" instead of quietly converting
     * it into an assertion about the rate, which `standoff.test.ts` owns.
     */
    expect(shotsBy(events, enemy.id).length).toBeGreaterThanOrEqual(3)
  })

  it('halts where it stands rather than closing further', () => {
    const r = arena()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(7, 5, 'player', 1000) // inside the closing distance — see above
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
    const r = arena()
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
    // EAST, against this suite's westward default: these blocks put their player
    // on the other side of the enemy. See the note on `arena`.
    const r = rig(WALLED, {}, EAST)
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
    const r = arena(OPEN, { pursueTimeoutTicks: 30 })
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
    // EAST, against this suite's westward default: these blocks put their player
    // on the other side of the enemy. See the note on `arena`.
    const r = rig(WALLED, {}, EAST)
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
    const r = arena()
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
    const r = arena()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(7, 5, 'player', 1000) // inside the closing distance — see above
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.ai.hear([r.shotAt(14, 5)])
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })
})

describe('what the machine never does', () => {
  it('holds no state for a unit that is dead', () => {
    const r = arena()
    const enemy = r.spawn(10, 5, 'enemy')
    r.spawn(7, 5, 'player', 1000) // inside the closing distance — see above
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.world.despawn(enemy.id)
    r.run(2)
    expect(r.ai.stateOf(enemy.id)).toBeUndefined()
  })

  it('holds no state for a unit that never existed', () => {
    const r = arena()
    expect(r.ai.stateOf(99_999)).toBeUndefined()
  })

  it('commands no player unit — ever', () => {
    // The AI shares one `SquadSystem` with the player's pointer. An `order` that
    // named a player id would take the squad off the march the owner gave it,
    // and it would look like the controls fighting back.
    const r = arena()
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
    const r = arena()
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
    const near = arena()
    const nearEnemy = near.spawn(10, 5, 'enemy')
    // ENTRY IS THE CLOSING DISTANCE SINCE TICKET 037, not the full range — but
    // both numbers still come out of the weapon table rather than out of this
    // machine, which is what this case is actually about.
    near.spawn(Math.round(10 - (RANGE * CLOSE_TO - 1)), 5, 'player', 1000)
    near.run(4)

    const far = arena()
    const farEnemy = far.spawn(16, 5, 'enemy')
    far.spawn(Math.round(16 - (RANGE + 2)), 5, 'player', 1000)
    far.run(4)

    expect({ near: near.ai.stateOf(nearEnemy.id), far: far.ai.stateOf(farEnemy.id) }).toEqual({
      near: 'engage',
      far: 'pursue',
    })
  })
})
