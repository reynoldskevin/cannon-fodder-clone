import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { weaponFor } from '../../combat'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../../ai/archetypes'

/**
 * Ticket 093 — ONE difficulty reaches BOTH systems, or the enemy is incoherent.
 *
 * THIS IS THE CONTRACT TEST, AND IT IS THE ONLY THING IN THE SUITE THAT CATCHES
 * THE FAILURE IT IS FOR. `combat/system.ts` and `ai/system.ts` each call
 * `weaponFor` INDEPENDENTLY — combat to decide whether a round reaches and when
 * the rifle is ready again, the AI to decide where to stop walking. Each takes
 * its own `difficulty` option, and each is perfectly testable in isolation while
 * being wrong about the other:
 *
 *   - difficulty to COMBAT only: he closes to 0.6 of 6.4 tiles as usual, then
 *     shoots as though he held eight and reloads as though he held forty ticks.
 *   - difficulty to the AI only: he walks to 4.8 tiles believing he can reach,
 *     and fires on the normal 46-tick cooldown from a rifle that covers 6.4.
 *
 * Neither is a crash and neither shows up in a unit test of either system: each
 * is internally consistent and merely wrong about its partner. The disagreement
 * lives in the wiring, which is `createSession`.
 *
 * TWO SIGNALS, BECAUSE ONE DOES NOT COVER BOTH DIRECTIONS. The distance he
 * settles at is the AI's answer and catches "combat only"; the gap between his
 * first two rounds is combat's answer and catches "AI only". A test asserting
 * only that hard differs from normal would pass with either half wired.
 *
 * OBSERVED THROUGH BEHAVIOUR, NOT BY READING THE OPTIONS BACK. Asserting that
 * the session passed `difficulty` to both constructors would pass against a
 * system that accepted the field and ignored it, which is the likelier bug.
 */

/** One rifleman each, nine tiles apart on a clear line, the enemy facing him. */
const duel = () =>
  makeLevel({
    avatars: [{ x: 4, y: 7 }],
    enemies: [{ x: 13, y: 7, facing: 'W' }],
  })

interface Fight {
  /** How far apart the two men stood when the enemy fired his FIRST round. */
  readonly firstShotAt: number
  /** Ticks between his first and second rounds — his cooldown, observed. */
  readonly shotGap: number
  /** Every round he fired resolved onto a target rather than into the air. */
  readonly allOnTarget: boolean
}

/**
 * Run the duel and report what the enemy actually did.
 *
 * MEASURED AT THE MOMENT HE FIRES, not at the end. `INFANTRY_HEALTH` is 1 and
 * the session rolls the weapon's curve, so the squaddie falls after a round or
 * two and both men's positions stop meaning anything — an end-state measurement
 * would read `gone` and assert nothing. Two shots is all either signal needs.
 */
function fight(difficulty?: 'normal' | 'hard'): Fight {
  const session = createSession(duel(), {
    seed: 7,
    ...(difficulty === undefined ? {} : { difficulty }),
  })
  const shots: { tick: number; onTarget: boolean; gap: number | null }[] = []
  for (let frame = 0; frame < 1200; frame += 1) {
    session.advance(1 / 60)
    for (const event of session.events()) {
      if (event.type !== 'ShotFired') continue
      const enemy = [...session.world.entities].find((e) => e.team === 'enemy')
      const mine = [...session.world.entities].find((e) => e.team === 'player')
      if (shots.length === 0) {
        if (enemy === undefined || mine === undefined) throw new Error('shot with nobody standing')
        shots.push({
          tick: frame,
          onTarget: event.targetId !== null,
          gap: Math.hypot(enemy.x - mine.x, enemy.z - mine.z),
        })
      } else {
        shots.push({ tick: frame, onTarget: event.targetId !== null, gap: null })
      }
    }
  }
  const first = shots[0]
  const second = shots[1]
  if (first === undefined || second === undefined) throw new Error('the enemy never fired twice')
  return {
    firstShotAt: first.gap ?? 0,
    shotGap: second.tick - first.tick,
    allOnTarget: shots.every((s) => s.onTarget),
  }
}

/** What the tables say, so the expectations below are read rather than typed. */
const reach = (d: 'normal' | 'hard'): number => {
  const spec = weaponFor(DEFAULT_ARCHETYPE_NAME, 'enemy', d)
  if (spec === null) throw new Error('no enemy rifle')
  return spec.rangeTiles
}
const rate = (d: 'normal' | 'hard'): number => {
  const spec = weaponFor(DEFAULT_ARCHETYPE_NAME, 'enemy', d)
  if (spec === null) throw new Error('no enemy rifle')
  return spec.cooldownTicks
}
const closeTo = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]?.closeToFraction ?? 1

describe('the AI stops at a distance drawn from the SAME table combat shoots from', () => {
  it('on the default he settles at his own closing fraction of 6.4 tiles', () => {
    // Read from the two tables rather than typed, so a retune of either moves
    // this expectation with it instead of turning it red.
    expect(fight().firstShotAt).toBeCloseTo(reach('normal') * closeTo, 1)
  })

  it('and on hard at the same fraction of eight — FURTHER out', () => {
    /**
     * THE ASSERTION THAT CATCHES "COMBAT ONLY". `closeToFraction` is a fraction
     * OF THE WEAPON, so a longer rifle means he plants his feet sooner. A
     * session that handed the difficulty to `createCombatSystem` and not to
     * `createAiSystem` leaves this identical to the default.
     */
    const hard = fight('hard')
    expect(hard.firstShotAt).toBeCloseTo(reach('hard') * closeTo, 1)
    expect(hard.firstShotAt).toBeGreaterThan(fight().firstShotAt)
  })
})

describe('and reloads on the cooldown from that same table', () => {
  it('46 ticks on the default', () => {
    expect(fight().shotGap).toBe(rate('normal'))
  })

  it('and 40 on hard', () => {
    /**
     * THE ASSERTION THAT CATCHES "AI ONLY", and it is why the settling distance
     * above is not enough on its own. With the difficulty wired to the AI alone
     * he really does walk to 4.8 tiles — so the case above PASSES — while
     * `markFired` still holds the normal spec and he reloads at 46. The
     * observed gap is the only thing that separates those two worlds.
     */
    expect(fight('hard').shotGap).toBe(rate('hard'))
    expect(fight('hard').shotGap).toBeLessThan(fight().shotGap)
  })
})

describe('and the two answers are coherent, whichever difficulty is running', () => {
  it('every round he fires from where he settled finds its man', () => {
    /**
     * A man who stops walking at a distance his rifle does not cover fires
     * rounds that resolve to no target. On a clear line with one man opposite,
     * a settled enemy shooting at nothing means the two systems hold different
     * ranges — and unlike the cases above, this one fails whichever way round
     * the disagreement runs.
     */
    expect(fight().allOnTarget).toBe(true)
    expect(fight('hard').allOnTarget).toBe(true)
  })

  it('and he never settles outside the reach of the rifle he is holding', () => {
    for (const d of ['normal', 'hard'] as const) {
      expect({ d, settledInside: fight(d).firstShotAt <= reach(d) }).toEqual({
        d,
        settledInside: true,
      })
    }
  })
})

describe('and the default is what a session with no difficulty gets', () => {
  it('an absent option and an explicit normal play identically', () => {
    // The property that makes every other suite in the repo — none of which
    // names a difficulty — a test of the shipped game.
    expect(fight()).toEqual(fight('normal'))
  })

  it('and that is the 6.4-tile, 46-tick enemy, not ticket 092`s', () => {
    // Stated once, concretely, so "identical to normal" cannot be satisfied by
    // both paths being wrong together.
    const shipped = fight()
    expect(shipped.shotGap).toBe(46)
    expect(shipped.firstShotAt).toBeCloseTo(3.84, 1)
  })
})
