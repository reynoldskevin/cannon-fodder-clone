import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import type { LevelData, SpawnPoint } from '../../level/types'

/**
 * Ticket 018 — routes reach the right men.
 *
 * WHY THIS FILE EXISTS AT ALL: adversarial review found the session wiring
 * completely uncovered. Two different pairing bugs — an off-by-one, and pairing
 * by raw ENTITY index instead of enemy ordinal — both left the whole suite
 * green. The second is wrong in the shipped game rather than hypothetically:
 * level 1 spawns two avatars before three enemies, so entity indices 2, 3 and 4
 * would read spawn indices 2, 3 and 4 of a three-element array, handing one
 * enemy a route meant for another and two enemies nothing at all.
 *
 * `World.spawnFromLevel` spawns avatars THEN enemies, each in level order. That
 * is the invariant the pairing rests on, and the point of these cases is that
 * the pairing must be counted rather than assumed — an id offset that happens to
 * work today is a bug waiting for the first level that spawns a different number
 * of avatars.
 */

/**
 * A level whose enemies carry distinct routes, with avatars spawned FIRST — the
 * ordering the pairing depends on.
 *
 * BIG, AND WITH THE SQUAD PARKED IN THE FAR CORNER, deliberately. These cases
 * measure how far each enemy MOVED, and an enemy that catches sight of an avatar
 * moves for reasons of its own — it pursues. The first draft put the squad four
 * tiles from the enemies, well inside the twelve-tile sight range, so contact
 * rather than patrol was driving the numbers. Every route below stays more than
 * twelve tiles from the corner at its closest approach.
 */
function levelWithRoutes(enemies: readonly SpawnPoint[]): LevelData {
  const base = makeLevel({
    w: 40,
    h: 30,
    avatars: [
      { x: 38, y: 0 },
      { x: 37, y: 0 },
    ],
    enemies: [{ x: 0, y: 0 }],
    objectives: [{ type: 'kill_all' }],
  })
  return { ...base, spawns: { ...base.spawns, enemies } }
}

/** Every enemy id, in spawn order. */
const enemyIds = (s: ReturnType<typeof createSession>): number[] =>
  s.world.entities.filter((e) => e.team === 'enemy').map((e) => e.id)

/** Run frames and report how far each enemy moved from where it started. */
function movement(s: ReturnType<typeof createSession>, frames: number): number[] {
  const ids = enemyIds(s)
  const start = ids.map((id) => ({ x: s.world.get(id)?.x ?? 0, z: s.world.get(id)?.z ?? 0 }))
  for (let f = 0; f < frames; f += 1) s.advance(1 / 60)
  return ids.map((id, i) => {
    const now = s.world.get(id)
    const was = start[i]
    if (now === undefined || was === undefined) return 0
    return Math.hypot(now.x - was.x, now.z - was.z)
  })
}

describe('a route in the level document reaches the enemy it was written for', () => {
  it('the routed one walks', () => {
    const s = createSession(
      levelWithRoutes([
        {
          x: 2,
          y: 12,
          patrol: [
            { x: 2, y: 12 },
            { x: 14, y: 12 },
          ],
        },
      ]),
    )
    expect(movement(s, 240)[0] ?? 0).toBeGreaterThan(1)
  })

  it('and an unrouted one beside him does not', () => {
    // The control, and the shape of the pairing bug: give exactly one of two
    // enemies a route and check the RIGHT one moved.
    const s = createSession(
      levelWithRoutes([
        { x: 2, y: 12 },
        {
          x: 2,
          y: 18,
          patrol: [
            { x: 2, y: 18 },
            { x: 14, y: 18 },
          ],
        },
      ]),
    )
    const moved = movement(s, 240)
    expect({
      first: (moved[0] ?? 0) > 1,
      second: (moved[1] ?? 0) > 1,
    }).toEqual({ first: false, second: true })
  })

  it('is counted past the avatars, not offset by a guessed number of them', () => {
    /**
     * THE MUTANT THAT IS WRONG IN THE SHIPPED GAME. Two avatars spawn before any
     * enemy, so an implementation pairing the nth ENTITY with the nth enemy
     * SPAWN reads past the end of a short list and mis-assigns the rest. Here the
     * LAST of three enemies holds the only route: pairing by entity index would
     * look for spawn 4 of a 3-element array and nobody would move at all.
     */
    const s = createSession(
      levelWithRoutes([
        { x: 2, y: 12 },
        { x: 2, y: 18 },
        {
          x: 2,
          y: 24,
          patrol: [
            { x: 2, y: 24 },
            { x: 14, y: 24 },
          ],
        },
      ]),
    )
    const moved = movement(s, 240)
    expect({
      first: (moved[0] ?? 0) > 1,
      second: (moved[1] ?? 0) > 1,
      third: (moved[2] ?? 0) > 1,
    }).toEqual({ first: false, second: false, third: true })
  })

  it('an off-by-one would hand the route to the wrong man', () => {
    // The FIRST of three holds it. With the case above, the two together bracket
    // the list from both ends, so neither a +1 nor a -1 offset survives.
    const s = createSession(
      levelWithRoutes([
        {
          x: 2,
          y: 12,
          patrol: [
            { x: 2, y: 12 },
            { x: 14, y: 12 },
          ],
        },
        { x: 2, y: 18 },
        { x: 2, y: 24 },
      ]),
    )
    const moved = movement(s, 240)
    expect({
      first: (moved[0] ?? 0) > 1,
      second: (moved[1] ?? 0) > 1,
      third: (moved[2] ?? 0) > 1,
    }).toEqual({ first: true, second: false, third: false })
  })
})

describe('a hand-authored route is not trusted', () => {
  const malformed = [
    'north-then-east',
    42,
    null,
    [{ x: 'four', y: 6 }],
    [{ x: 4 }],
    [null],
    {},
  ]

  it('a malformed route is no route, and never a crash', () => {
    // `patrol` arrives as `unknown` from a document somebody typed. The failure
    // to avoid is a level that refuses to load, or an enemy walking to NaN.
    for (const patrol of malformed) {
      const s = createSession(levelWithRoutes([{ x: 2, y: 12, patrol }]))
      expect(() => movement(s, 60)).not.toThrow()
      const enemy = s.world.entities.find((e) => e.team === 'enemy')
      expect({
        patrol: JSON.stringify(patrol),
        finite: Number.isFinite(enemy?.x) && Number.isFinite(enemy?.z),
      }).toEqual({ patrol: JSON.stringify(patrol), finite: true })
    }
  })

  it('a malformed route leaves the man standing, rather than half-walking one', () => {
    // A route half-accepted — the good waypoints kept, the bad ones skipped — is
    // worse than none: the guard walks a beat nobody authored.
    const s = createSession(
      levelWithRoutes([{ x: 2, y: 12, patrol: [{ x: 2, y: 12 }, null, { x: 14, y: 12 }] }]),
    )
    expect(movement(s, 240)[0] ?? 0).toBeLessThan(0.5)
  })

  it('level 1`s enemies, which name no route at all, hold position', () => {
    // The regression that matters most, stated at session level: every enemy in
    // the shipped game is routeless.
    const s = createSession(makeLevel({ w: 40, h: 30, avatars: [{ x: 38, y: 0 }], enemies: [{ x: 2, y: 24 }] }))
    expect(movement(s, 300)[0] ?? 0).toBeLessThan(0.5)
  })
})
