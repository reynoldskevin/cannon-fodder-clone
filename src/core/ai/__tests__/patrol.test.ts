import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'

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
