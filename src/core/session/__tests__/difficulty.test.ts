import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 093 — ONE difficulty reaches BOTH systems, or the enemy is incoherent.
 *
 * THIS IS THE CONTRACT TEST, AND IT IS THE ONLY THING IN THE SUITE THAT CATCHES
 * THE FAILURE IT IS FOR. `combat/system.ts` and `ai/system.ts` each call
 * `weaponFor` INDEPENDENTLY — combat to decide whether a round reaches, the AI
 * to decide where to stop walking. Each takes its own `difficulty` option, and
 * each is perfectly testable in isolation while being wrong about the other:
 *
 *   - difficulty to combat only: he closes to 0.6 of 6.4 tiles, then shoots as
 *     though he held eight. Harder than intended and for no visible reason.
 *   - difficulty to the AI only: he halts at 4.8 tiles believing he can reach,
 *     and fires rounds that stop 1.6 tiles short of the squad. EASIER than
 *     normal, from the option that is supposed to make it harder.
 *
 * Neither is a crash. Neither shows up in a unit test of either system, because
 * each system is internally consistent — the disagreement lives in the wiring
 * between them, which is `createSession`. So this observes ONE session and
 * asserts the two answers agree, rather than asserting each in isolation.
 *
 * OBSERVED THROUGH BEHAVIOUR, NOT BY READING THE OPTIONS BACK. Asserting that
 * the session passed `difficulty` to both constructors would pass against a
 * system that accepted the field and ignored it, which is the more likely bug of
 * the two.
 */

/** One rifleman each, `apart` tiles apart on a clear line, the enemy facing him. */
const duel = (apart: number) =>
  makeLevel({
    avatars: [{ x: 4, y: 7 }],
    enemies: [{ x: 4 + apart, y: 7, facing: 'W' }],
  })

/** Every shot the enemy fires in `frames`, and which of them found the squad. */
function fight(apart: number, hard: boolean, frames = 900) {
  const session = createSession(duel(apart), {
    seed: 7,
    ...(hard ? { difficulty: 'hard' as const } : {}),
  })
  const shots: SimEvent[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    session.advance(1 / 60)
    for (const event of session.events()) if (event.type === 'ShotFired') shots.push(event)
  }
  const enemyShots = shots.filter((e) => e.type === 'ShotFired' && e.shooterId !== 1)
  const enemy = [...session.world.entities].find((e) => e.team === 'enemy')
  const mine = [...session.world.entities].find((e) => e.team === 'player')
  return {
    fired: enemyShots.length,
    /** Shots that actually resolved onto a target rather than into the air. */
    onTarget: enemyShots.filter((e) => e.type === 'ShotFired' && e.targetId !== null).length,
    /** Where he settled, which is the AI's answer to "how far can I shoot". */
    settled:
      enemy === undefined || mine === undefined
        ? null
        : Math.hypot(enemy.x - mine.x, enemy.z - mine.z),
  }
}

describe('the two systems agree about how far the enemy shoots', () => {
  it('on the default, every round he fires from where he settles finds its man', () => {
    /**
     * THE ASSERTION THAT CATCHES "AI ONLY". If the AI believed in eight tiles
     * while combat held 6.4, he would halt at 4.8 and — no. He would halt at
     * 0.6 × 8 = 4.8, which is INSIDE 6.4, so the default direction of that bug
     * is invisible here. It is the hard case below that catches it, and this
     * case is what proves the fixture reports a real firefight rather than
     * silence.
     */
    const normal = fight(9, false)
    expect(normal.fired).toBeGreaterThan(0)
    expect(normal.onTarget).toBeGreaterThan(0)
  })

  it('and on hard likewise — he never settles somewhere he cannot reach', () => {
    /**
     * THE ASSERTION THAT CATCHES "COMBAT ONLY" AND "AI ONLY" BOTH.
     *
     * A man who stops walking at a distance his rifle does not cover fires
     * rounds that resolve to no target. On a clear line with one man opposite,
     * a settled enemy firing at nothing means the two systems hold different
     * ranges — whichever way round.
     */
    const hard = fight(9, true)
    expect(hard.fired).toBeGreaterThan(0)
    expect(hard.onTarget).toBe(hard.fired)
    expect(hard.settled).not.toBeNull()
  })

  it('and the same is true on the default, at the distance he chose', () => {
    const normal = fight(9, false)
    expect(normal.onTarget).toBe(normal.fired)
  })
})

describe('hard actually changes the fight', () => {
  it('he settles FURTHER out than on the default', () => {
    /**
     * The AI half of the wiring, observed rather than read back. `closeToFraction`
     * is a fraction OF THE WEAPON, so a longer rifle means he stops sooner — the
     * single clearest signal that the difficulty reached `ai/system.ts`.
     *
     * A session that passed the difficulty to combat alone leaves these two
     * identical.
     */
    const normal = fight(9, false)
    const hard = fight(9, true)
    expect(normal.settled).not.toBeNull()
    expect(hard.settled).not.toBeNull()
    expect(hard.settled ?? 0).toBeGreaterThan(normal.settled ?? 0)
  })

  it('and gets more rounds away in the same window', () => {
    // The combat half. A session that passed the difficulty to the AI alone
    // leaves these two equal.
    const normal = fight(9, false)
    const hard = fight(9, true)
    expect(hard.fired).toBeGreaterThan(normal.fired)
  })
})

describe('and the default is what a session with no difficulty gets', () => {
  it('an absent option and an explicit normal play identically', () => {
    // The property that makes every other suite in the repo — none of which
    // names a difficulty — a test of the shipped game.
    const absent = createSession(duel(9), { seed: 3 })
    const explicit = createSession(duel(9), { seed: 3, difficulty: 'normal' })
    const drain = (s: ReturnType<typeof createSession>): string => {
      const out: string[] = []
      for (let frame = 0; frame < 600; frame += 1) {
        s.advance(1 / 60)
        for (const event of s.events()) {
          if (event.type === 'ShotFired') out.push(`${String(event.shooterId)}:${String(event.targetId)}`)
        }
      }
      return out.join('|')
    }
    expect(drain(absent)).toBe(drain(explicit))
  })
})
