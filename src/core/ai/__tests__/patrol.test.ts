import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'
import type { AiOptions } from '../index'

/**
 * Ticket 018 — patrol routes.
 *
 * PATROL IS AN `idle` BEHAVIOUR AND NOTHING MORE. It is what a man does when he
 * has nothing better to do, and it must not survive contact: an enemy who kept
 * walking his beat while being shot at would be worse than one who stood still,
 * because the player would read it as the AI not noticing him.
 *
 * THE REGRESSION THAT MATTERS MOST is the routeless enemy. Every enemy in the
 * game today has no route — level 1's three included — and they hold position.
 * A patrol system that made them wander would retune a shipped level, and it
 * would look like a bug in the AI rather than a new feature.
 */

describe('a routeless enemy holds position', () => {
  it('does not wander', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(4, 5, 'enemy')
    const before = r.tileOf(enemy.id)
    r.run(300)
    expect(r.tileOf(enemy.id)).toEqual(before)
  })

  it('is given no orders at all', () => {
    // Stronger than "did not move": an enemy ordered to the tile he is standing
    // on would also not move, while flooding the squad system every tick.
    const r = rig(OPEN)
    r.spawn(4, 5, 'enemy')
    r.run(300)
    expect(r.spy.orders).toEqual([])
  })
})

describe('a routed enemy walks his beat', () => {
  it('sets off toward the first waypoint', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(60)
    expect(r.tileOf(enemy.id).x).toBeGreaterThan(2)
  })

  it('arrives, then turns round for the next one', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 8, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(300)
    const far = r.tileOf(enemy.id).x
    r.run(300)
    expect({ reached: far >= 7, cameBack: r.tileOf(enemy.id).x < far }).toEqual({
      reached: true,
      cameBack: true,
    })
  })

  it('loops rather than stopping at the end', () => {
    // A route is a beat, not a one-way trip. Stopping at the last waypoint would
    // make every patrol in the game a slow march to a new post.
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 8, y: 5 },
      { x: 2, y: 5 },
    ])
    const visited = new Set<number>()
    for (let i = 0; i < 40; i += 1) {
      r.run(30)
      visited.add(r.tileOf(enemy.id).x)
    }
    // Both ends seen more than once over a long enough run means he is going
    // round, not settling.
    expect(visited.has(2) || visited.has(3)).toBe(true)
    expect([...visited].some((x) => x >= 7)).toBe(true)
  })

  it('a single waypoint is a post to stand at, not a crash', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    expect(() => r.ai.assignPatrol(enemy.id, [{ x: 9, y: 5 }])).not.toThrow()
    r.run(300)
    expect(r.tileOf(enemy.id).x).toBeGreaterThan(7)
  })

  it('an empty route is no route', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(4, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [])
    const before = r.tileOf(enemy.id)
    r.run(200)
    expect(r.tileOf(enemy.id)).toEqual(before)
  })

  it('does not re-issue the same order every tick', () => {
    /**
     * `SquadSystem.order` re-plans a flow field, and doing that sixty times a
     * second for a man already walking where he was told is the performance bug
     * ticket 012 wrote its own "does not re-order every tick" case for. A patrol
     * must not reintroduce it through a different door.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(120)
    expect(r.spy.orders.length).toBeLessThan(10)
  })

  it('ignores a route for an id that names nothing', () => {
    const r = rig(OPEN)
    expect(() => r.ai.assignPatrol(99_999, [{ x: 4, y: 4 }])).not.toThrow()
  })

  it('never patrols a player unit', () => {
    // The AI drives one team. A route assigned to an avatar must not take the
    // squad out of the player's hands.
    const r = rig(OPEN)
    const man = r.spawn(2, 5, 'player')
    r.ai.assignPatrol(man.id, [{ x: 14, y: 5 }])
    const before = r.tileOf(man.id)
    r.run(200)
    expect(r.tileOf(man.id)).toEqual(before)
  })
})

describe('contact interrupts the beat', () => {
  it('a patrolling man who sees the enemy stops patrolling', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(30)
    r.spawn(6, 5, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('and plants his feet rather than walking his route into the firefight', () => {
    // The visible failure: a man strolling past the squad while shooting at it.
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(30)
    r.spawn(6, 5, 'player', 10_000)
    r.run(20)
    const planted = r.tileOf(enemy.id)
    r.run(60)
    expect(r.tileOf(enemy.id)).toEqual(planted)
  })

  it('resumes once the shooting stops', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    r.run(30)
    const man = r.spawn(6, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    const stopped = r.tileOf(enemy.id)

    r.world.despawn(man.id)
    r.run(400)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    expect(r.tileOf(enemy.id)).not.toEqual(stopped)
  })

  it('resumes toward the nearest waypoint, not back to the top of the list', () => {
    /**
     * A guard interrupted three quarters of the way along a wall must not walk
     * all the way back to the corner before carrying on. Restarting at index 0
     * is the obvious implementation and it makes every interruption visible as a
     * long, purposeless walk backwards.
     *
     * He is placed near the SECOND waypoint and interrupted there; resuming
     * correctly means continuing east, not marching west to the first.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 2, y: 5 },
      { x: 18, y: 5 },
    ])
    r.place(enemy.id, 13, 5)
    const man = r.spawn(13, 9, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')

    /**
     * SAMPLED AT THE MOMENT HE RESUMES, not at a fixed distance later. The first
     * draft ran 400 ticks and asserted on where he ended up — but at 0.05 tiles
     * a tick that is twenty tiles of travel on a fourteen-tile loop, so he had
     * gone east, reached the far waypoint, turned, and come most of the way back
     * before the assertion looked. It read as "resumed backwards" when the
     * resumption was correct and only the clock was wrong.
     *
     * The claim is about DIRECTION at the point of resumption, so that is what
     * is measured: wait for `idle`, note where he is, and give him a short walk.
     */
    r.world.despawn(man.id)
    let resumed = false
    for (let i = 0; i < 60 && !resumed; i += 1) {
      r.run(10)
      resumed = r.ai.stateOf(enemy.id) === 'idle'
    }
    expect(resumed).toBe(true)
    const from = r.tileOf(enemy.id).x
    r.run(40) // two tiles' worth, well short of the five to the east waypoint
    expect({ from, movedEast: r.tileOf(enemy.id).x > from }).toEqual({ from, movedEast: true })
  })
})

describe('the leash bounds a chase, it does not forbid one', () => {
  /**
   * `aggression` scales how far from his post a man will chase before giving up.
   * BOUNDING a pursuit is the feature; PREVENTING one is a bug, and the
   * difference is invisible unless a routeless enemy is measured beside a routed
   * one in the same breath.
   *
   * The failure this catches, found by adversarial review and then measured to be
   * worse than first diagnosed: a routed enemy dropped to `idle` the instant it
   * lost sight — not only before its first patrol step, but after one too —
   * because the leash was anchored somewhere other than where the man actually
   * stands. A patrolling guard was therefore strictly WORSE at his job than a
   * static one: he would see you, shoot at you, and forget you completely the
   * moment you stepped behind a tree.
   */
  const BIG = '\n' + Array.from({ length: 60 }, () => '  ' + '.'.repeat(60)).join('\n') + '\n'

  /**
   * THE CLOSING DISTANCE IS HELD AT 1 ACROSS THIS BLOCK (ticket 037), which
   * reproduces the pre-037 halt-at-maximum-range behaviour exactly.
   *
   * An experimental control, not a workaround. Every case here is about the
   * LEASH — how far from his post a man will be drawn before he gives up — and
   * each one begins by getting him into `engage` and then taking his target
   * away. At the shipped 0.6 the rifleman halts at 3.84 tiles, so `chase()`'s
   * six-tile contact is a `pursue`, the fixture's own `throw new Error('fixture
   * never engaged')` fires, and the suite stops measuring the leash at all.
   *
   * Where a man STOPS is `closing-distance.test.ts`'s subject. Holding it fixed
   * here is what keeps these two suites from testing each other's variable.
   */
  const HOLD: Partial<AiOptions> = { closeToFraction: 1 }

  /** Engage a man, then move him out of sight, and report the state that follows. */
  function chase(route: readonly { x: number; y: number }[] | null, stepFirst: boolean): string {
    const r = rig(BIG, HOLD)
    const enemy = r.spawn(2, 2, 'enemy')
    if (route !== null) r.ai.assignPatrol(enemy.id, route)
    if (stepFirst) r.run(20)
    // Six tiles. Seven was inside the rifle until ticket 036 shortened the
    // enemy's to 6.4; at seven the fixture never reaches `engage` and throws
    // below before it can measure anything about the leash.
    const man = r.spawn(8, 2, 'player', 10_000)
    r.run(10)
    if (r.ai.stateOf(enemy.id) !== 'engage') throw new Error('fixture never engaged')
    r.place(man.id, 38, 38) // out of sight, and still alive
    r.run(9)
    return String(r.ai.stateOf(enemy.id))
  }

  it('a man with no route pursues, which is the behaviour to match', () => {
    expect(chase(null, false)).toBe('pursue')
  })

  it('a routed man standing on his post pursues too', () => {
    // His post is the waypoint he is standing on, so he is zero tiles from it
    // and nothing about a leash should stop him.
    expect(chase([{ x: 2, y: 2 }, { x: 20, y: 2 }], false)).toBe('pursue')
  })

  it('and so does one who has already set off along his beat', () => {
    // The other half. The first diagnosis of this bug was that only the
    // not-yet-stepped case failed; both did, so both are pinned.
    expect(chase([{ x: 2, y: 2 }, { x: 20, y: 2 }], true)).toBe('pursue')
  })

  /**
   * Lure him `steps` times toward the eastern edge with a target that stays just
   * inside his sight, then take the target away, and report what he does.
   *
   * The lure is what puts real distance between him and his post: the leash is
   * consulted on the PURSUIT of a target he can no longer see, never on the
   * engagement of one in front of him — a man being shot at does not turn his
   * back and walk home because he is off his beat.
   */
  function lureThenVanish(steps: number): { away: number; state: string } {
    const r = rig(BIG, HOLD)
    const enemy = r.spawn(2, 2, 'enemy')
    r.ai.assignPatrol(enemy.id, [{ x: 2, y: 2 }, { x: 20, y: 2 }])
    const bait = r.spawn(9, 2, 'player', 10_000)
    r.run(10)
    for (let i = 0; i < steps; i += 1) {
      // Tile space, not world. Feeding `entity.x` to a tile-space `place` is the
      // units mix-up that made an earlier probe of this silently do nothing.
      r.place(bait.id, Math.min(38, r.tileOf(enemy.id).x + 9), 2)
      r.run(30)
    }
    const away = r.tileOf(enemy.id).x - 2
    r.place(bait.id, 38, 38)
    r.run(9)
    return { away, state: String(r.ai.stateOf(enemy.id)) }
  }

  it('gives up on a chase that has taken him far from his post', () => {
    /**
     * `aggression` IS THE TICKET'S ONE GENUINELY NEW KNOB, and adversarial
     * review found it had no behavioural test whatsoever — `offTheLeash` could be
     * made to `return false` unconditionally and the whole suite stayed green.
     * That is exactly how the anchor bug above survived to review.
     *
     * A leash that never bites is not a leash: a guard would ratchet across the
     * map one contact at a time and never see his beat again.
     */
    const far = lureThenVanish(16)
    expect(far.away).toBeGreaterThan(12)
    expect(far.state).toBe('idle')
  })

  it('a man standing on his own route is never already off the leash', () => {
    /**
     * THE DEAD ZONE, and it is the same player-visible symptom as the anchor bug
     * one layer up: a guard who will not fight.
     *
     * Anchoring the post at the NEAREST WAYPOINT fixed the map-centre bug but
     * left a subtler one, because nothing guarantees a waypoint is within the
     * leash. Halfway along a leg longer than twice the leash, a man standing
     * exactly where he was authored to stand is already outside it — so he sees
     * an enemy, shoots, and abandons the chase the instant sight breaks.
     * Measured before the fix: legs of 6, 18 and 22 pursued; 24, 32 and 40 did
     * not, the boundary landing exactly at 2 x the rifleman's 12-tile leash.
     *
     * The earlier leash cases could not see it because they LURE him off the
     * route; this failure is a man still on it. So the post is anchored at where
     * he actually stands when contact takes him off his beat, which is the
     * distance `aggression` was always meant to bound and has no dead zone at
     * any leg length.
     */
    const legs = [6, 18, 24, 40]
    const outcomes = legs.map((legLen) => {
      const r = rig(BIG, HOLD)
      const start = 2
      const end = start + legLen
      const mid = Math.round((start + end) / 2)
      const enemy = r.spawn(mid, 5, 'enemy')
      r.ai.assignPatrol(enemy.id, [
        { x: start, y: 5 },
        { x: end, y: 5 },
      ])
      const man = r.spawn(mid + 6, 5, 'player', 10_000)
      r.run(10)
      if (r.ai.stateOf(enemy.id) !== 'engage') throw new Error(`leg ${String(legLen)} never engaged`)
      r.place(man.id, 58, 58)
      r.run(9)
      return { legLen, state: String(r.ai.stateOf(enemy.id)) }
    })
    expect(outcomes).toEqual(legs.map((legLen) => ({ legLen, state: 'pursue' })))
  })

  it('does not inherit a post from a contact at the far end of his beat', () => {
    /**
     * The post is released on the return to `idle`. Without that release a guard
     * ambushed at one end of a long route carries that post for the rest of the
     * mission, and by the time his beat has taken him to the other end he is
     * permanently off the leash — the dead zone above, arriving by a different
     * door and lasting the whole mission rather than one leg.
     *
     * The system's own comment argues for this release; nothing pinned it, and a
     * mutant that never released survived the whole suite.
     */
    const r = rig(BIG, HOLD)
    const enemy = r.spawn(4, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 4, y: 5 },
      { x: 40, y: 5 },
    ])
    // Contact at the western end, then let him go back to his beat.
    const first = r.spawn(10, 5, 'player', 10_000)
    r.run(10)
    r.world.despawn(first.id)
    let idle = false
    for (let i = 0; i < 60 && !idle; i += 1) {
      r.run(10)
      idle = r.ai.stateOf(enemy.id) === 'idle'
    }
    expect(idle).toBe(true)

    // Walk him a long way east, then ambush him again where he now stands.
    r.run(500)
    const now = r.tileOf(enemy.id).x
    expect(now).toBeGreaterThan(20)
    const second = r.spawn(now + 6, 5, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.place(second.id, 58, 58)
    r.run(9)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
  })

  it('but not on one that has barely moved him', () => {
    // The other side of the same number, and the half that stops "gives up" from
    // being satisfied by a man who gives up always.
    for (const steps of [0, 3, 6]) {
      const near = lureThenVanish(steps)
      expect({ steps, away: near.away < 12, state: near.state }).toEqual({
        steps,
        away: true,
        state: 'pursue',
      })
    }
  })
})

describe('determinism', () => {
  it('two identical patrols walk identically', () => {
    const walk = () => {
      const r = rig(OPEN)
      const a = r.spawn(2, 5, 'enemy')
      const b = r.spawn(2, 8, 'enemy')
      r.ai.assignPatrol(a.id, [
        { x: 14, y: 5 },
        { x: 2, y: 5 },
      ])
      r.ai.assignPatrol(b.id, [
        { x: 14, y: 8 },
        { x: 2, y: 8 },
      ])
      const seen: string[] = []
      for (let i = 0; i < 30; i += 1) {
        r.run(10)
        seen.push(`${JSON.stringify(r.tileOf(a.id))}${JSON.stringify(r.tileOf(b.id))}`)
      }
      return seen.join('|')
    }
    expect(walk()).toBe(walk())
  })

  it('draws nothing from the world`s PRNG', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 14, y: 5 },
      { x: 2, y: 5 },
    ])
    const before = r.world.rng.getState()
    r.run(200)
    expect(r.world.rng.getState()).toBe(before)
  })
})
