import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../../ai/archetypes'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 012a — the beat, measured where the player feels it.
 *
 * `reaction.test.ts` pins the timer against an injected table, which is how a
 * timing rule should be tested. This file asks the only question that table
 * cannot answer: does the shipped game give a man a moment between being seen
 * and being shot at?
 *
 * MEASURED AS TICKS TO THE FIRST ROUND, not as survival. Ticket 011b already
 * made survival a probability, so a squad that lived longer might have lived
 * longer because the dice were kind. When the first shot is FIRED is a fact
 * about this ticket alone, and it is what the player is reacting inside.
 */

/** One rifleman each, `apart` tiles apart on a clear line. */
const duelLevel = (apart: number) =>
  makeLevel({
    avatars: [{ x: 4, y: 7 }],
    enemies: [{ x: 4 + apart, y: 7 }],
  })

/**
 * The frame the first round of the mission was fired on, or `null`.
 *
 * Five tiles apart: inside the rifle's eight from the first frame, so the enemy
 * engages immediately and this measures the beat rather than the walk.
 */
function firstShotFrame(seed: number, apart = 5): number | null {
  const session = createSession(duelLevel(apart), { seed })
  for (let frame = 0; frame < 600; frame += 1) {
    session.advance(1 / 60)
    for (const event of session.events()) {
      if (event.type === 'ShotFired') return frame
    }
  }
  return null
}

const SEEDS = [1, 2, 3, 4, 5, 6]

describe('the shipped game gives the player a moment', () => {
  it('the first round is not fired on the first frame of contact', () => {
    /**
     * The whole complaint, inverted into an assertion. Before this ticket the
     * enemy issued `orderFire` on the tick he entered `engage`, so on a fixture
     * already inside his range the first round left the barrel on frame 0 or 1
     * and the player had nothing to react to at all.
     */
    for (const seed of SEEDS) {
      const at = firstShotFrame(seed)
      expect({ seed, fired: at !== null }).toEqual({ seed, fired: true })
      expect({ seed, early: (at ?? 0) < 10 }).toEqual({ seed, early: false })
    }
  })

  it('and it lands about where the rifleman`s own table says it should', () => {
    /**
     * Not merely "later than before". Pinned to the archetype the level actually
     * spawns, so a delay that were real but wired to some other number — a
     * hardcoded constant, the wrong row — fails here rather than passing as
     * "slower, therefore correct".
     *
     * A frame is a tick at the fixed timestep, and the band allows for the tick
     * acquisition happens on plus the fixed-step accumulator's own rounding.
     */
    const expected = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]?.reactionTicks ?? 0
    expect(expected).toBeGreaterThan(0)
    for (const seed of SEEDS) {
      const at = firstShotFrame(seed) ?? -1
      expect({ seed, ok: at >= expected - 1 && at <= expected + 4 }).toEqual({ seed, ok: true })
    }
  })

  it('a man is still being shot at well before the mission times out', () => {
    // The guard on the other side: a beat is a beat, not a ceasefire. Under a
    // second on a fixture where the enemy starts in range.
    for (const seed of SEEDS) {
      expect(firstShotFrame(seed) ?? 999).toBeLessThan(60)
    }
  })
})

describe('the beat survives the walk, not just the standing start', () => {
  /**
   * The case the game actually produces: the enemy notices at twelve tiles,
   * walks to eight, and only then engages. The beat has to start when he
   * ENGAGES, not when he first saw the squad — otherwise it is spent during the
   * approach and the player gets nothing at the end of it.
   *
   * MEASURED AS THE GAP BETWEEN TWO OBSERVED FRAMES, because that is the only
   * honest way to state it. A first draft compared the near and far fixtures and
   * wrote `far - (far - near)`, which is just `near` — a tautology dressed up as
   * arithmetic, and the fourth test on this project that could not have failed.
   * `Session.ai` exposes `stateOf`, so the tick he enters `engage` on is a fact
   * that can be read rather than inferred.
   */

  /** The frames he entered `engage` on and first fired on, from one mission. */
  function engageAndFire(apart: number, seed = 1): { engaged: number; fired: number } {
    const session = createSession(duelLevel(apart), { seed })
    const enemy = session.world.entities.filter((e) => e.team === 'enemy')[0]
    if (enemy === undefined) throw new Error('no enemy spawned')
    let engaged = -1
    let fired = -1
    for (let frame = 0; frame < 600; frame += 1) {
      session.advance(1 / 60)
      if (fired < 0 && session.events().some((e: SimEvent) => e.type === 'ShotFired')) {
        fired = frame
      }
      if (engaged < 0 && session.ai.stateOf(enemy.id) === 'engage') engaged = frame
      if (fired >= 0) break
    }
    return { engaged, fired }
  }

  it('the gap between engaging and firing is the archetype`s beat, whether he walked or not', () => {
    const expected = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]?.reactionTicks ?? 0
    expect(expected).toBeGreaterThan(0)
    for (const apart of [5, 9]) {
      const { engaged, fired } = engageAndFire(apart)
      expect({ apart, engaged: engaged >= 0, fired: fired >= 0 }).toEqual({
        apart,
        engaged: true,
        fired: true,
      })
      const gap = fired - engaged
      expect({ apart, ok: gap >= expected - 1 && gap <= expected + 3 }).toEqual({ apart, ok: true })
    }
  })

  it('and the one who had to walk really did walk, so the case above is two cases', () => {
    // The control. Without it both rows could be the standing start, and the
    // claim about the approach would rest on nothing.
    expect(engageAndFire(9).engaged).toBeGreaterThan(engageAndFire(5).engaged)
  })
})

describe('a mission still replays exactly', () => {
  it('the same seed twice is the same mission', () => {
    // `reactionTicks` is a tick count, not a roll — no rng and no wall clock, so
    // it advances on the sim's own clock like every other timeout in `tuning.ts`.
    const run = (): string => {
      const session = createSession(duelLevel(9), { seed: 31 })
      for (let frame = 0; frame < 600; frame += 1) session.advance(1 / 60)
      return String(session.world.stateHash())
    }
    expect(run()).toBe(run())
  })

  it('and the shot pattern is identical, not merely the end state', () => {
    /**
     * A hash at the end can agree while the route there differed — two men dead
     * either way. The sequence of frames rounds were fired on is the finer
     * reading, and it is the one a delay wired to something non-deterministic
     * would break.
     */
    const pattern = (): string => {
      const session = createSession(duelLevel(9), { seed: 31 })
      const marks: string[] = []
      for (let frame = 0; frame < 600; frame += 1) {
        session.advance(1 / 60)
        const fired = session.events().some((e: SimEvent) => e.type === 'ShotFired')
        marks.push(fired ? '1' : '0')
      }
      return marks.join('')
    }
    const first = pattern()
    expect(first).toBe(pattern())
    // And it is not the empty pattern, which would make the assertion vacuous.
    expect(first).toContain('1')
  })
})
