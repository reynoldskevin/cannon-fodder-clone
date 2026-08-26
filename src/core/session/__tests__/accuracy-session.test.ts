import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { WEAPONS, RIFLE, hitChanceAt } from '../../combat'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 011b — the session is what opts the game into the roll.
 *
 * `CombatOptions.hitPolicy` defaults to `'certain'` so that the four hundred
 * tests written before this ticket behave exactly as they did. That default is
 * only correct if SOMETHING turns it on, and the session is the same place that
 * already overrides `autoEngageTeams` — one file, one line, one comment saying
 * which game it is running. Without this suite, a perfectly correct accuracy
 * model could ship switched off and every test in `combat/` would still pass.
 *
 * THE FIXTURE IS OFF THE CONVENIENT VALUE, deliberately. An enemy placed inside
 * the rifle's eight tiles would be shooting at close range, where the curve is
 * near-certain by design and a miss is rare enough that a small sample proves
 * nothing. Everything below engages at the FAR end of the envelope, which is
 * where the ticket's whole claim lives — that reaching your maximum range is
 * survivable and closing on someone is not.
 */

/** One rifleman each, `apart` tiles apart on a clear line, nobody else. */
const duelLevel = (apart: number) =>
  makeLevel({
    avatars: [{ x: 4, y: 7 }],
    enemies: [{ x: 4 + apart, y: 7 }],
  })

const rifle = () => {
  const spec = WEAPONS[RIFLE]
  if (spec === undefined) throw new Error('no rifle')
  return spec
}

/**
 * Run a mission and report every shot fired at the player's man, in order.
 *
 * Nine tiles apart: outside the rifle's range, inside the rifleman's twelve
 * tiles of sight, so the enemy notices, closes to eight and opens fire there.
 */
function shotsAtTheSquad(seed: number, apart = 9): readonly SimEvent[] {
  const session = createSession(duelLevel(apart), { seed })
  const shots: SimEvent[] = []
  for (let frame = 0; frame < 1200; frame += 1) {
    session.advance(1 / 60)
    for (const event of session.events()) {
      if (event.type === 'ShotFired') shots.push(event)
    }
    if (session.outcome() !== 'playing') break
  }
  return shots
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

describe('the session runs the game with the roll switched on', () => {
  it('a soldier is sometimes shot at more than once before he falls', () => {
    /**
     * THE OBSERVABLE THAT DISTINGUISHES THE TWO POLICIES, and it is the player's
     * own experience stated as a number. Under `'certain'` the first round that
     * reaches a man kills him, so the count of shots taken at him is EXACTLY ONE
     * on every seed without exception. Any seed showing two is proof the session
     * asked for the weapon's curve.
     *
     * Sampled across twelve seeds rather than one because a single seed can
     * legitimately open with a hit — that is what a probability means — and a
     * test pinned to one seed would be pinned to the rng's stream rather than to
     * the behaviour.
     */
    const counts = SEEDS.map((seed) => shotsAtTheSquad(seed).length)
    expect(counts.every((n) => n > 0)).toBe(true)
    expect(counts.some((n) => n > 1)).toBe(true)
  })

  it('and misses are reported as misses', () => {
    // The event half: `hit` is on the wire and false at least somewhere across
    // the sample. A roll that never reported a miss would be a roll nothing
    // downstream — FX, the debug overlay — could ever see.
    const all = SEEDS.flatMap((seed) => shotsAtTheSquad(seed))
    const missed = all.filter((s) => s.type === 'ShotFired' && !s.hit)
    expect(all.length).toBeGreaterThan(0)
    expect(missed.length).toBeGreaterThan(0)
  })

  it('at a range where the curve says most rounds should miss', () => {
    /**
     * Not merely "some missed" — the observed rate must be in the neighbourhood
     * the weapon table promises at the range the fight is actually happening at.
     * The enemy closes to the rifle's maximum range and stops, so that is the
     * distance being sampled.
     *
     * A generous band, because this is a small sample taken through a whole
     * simulation rather than a direct measurement of the roll — `accuracy.test.ts`
     * does the tight one. What it has to catch is the mutant that lands every
     * round, or none.
     */
    const all = SEEDS.flatMap((seed) => shotsAtTheSquad(seed))
    const observed = all.filter((s) => s.type === 'ShotFired' && s.hit).length / all.length
    const expected = hitChanceAt(rifle(), rifle().rangeTiles)
    expect(observed).toBeLessThan(expected + 0.35)
    expect(observed).toBeGreaterThan(0)
  })
})

describe('reaching maximum range is survivable; closing is not', () => {
  it('a squad engaged at arm`s length dies faster than one engaged across the field', () => {
    /**
     * THE PLAY CLAIM, END TO END. This is the sentence the ticket exists to make
     * true — "an enemy who has just reached the edge of his range mostly misses,
     * and the player gets to react to being shot at rather than to being dead" —
     * measured through the whole sim rather than off the table.
     *
     * Measured in ROUNDS FIRED at him, not in ticks: a man engaged from further
     * away is also walked toward for longer, so a tick count would be measuring
     * the approach as much as the shooting.
     */
    const rounds = (apart: number): number => {
      const totals = SEEDS.map((seed) => shotsAtTheSquad(seed, apart).length)
      return totals.reduce((a, b) => a + b, 0) / totals.length
    }
    // Two tiles apart: the enemy is on him before he has taken a step, and the
    // curve is at its most lethal.
    expect(rounds(2)).toBeLessThan(rounds(9))
  })
})

describe('a mission still replays exactly', () => {
  it('the same seed twice is the same mission', () => {
    /**
     * The roll draws from `world.rng`, which is seeded — so this must hold, and
     * it is the assertion that catches a draw taken from `Math.random` or from a
     * source outside the world. `core`'s purity tests forbid `Math.random` by
     * scanning the source; this catches the same mistake made through an
     * injected function they cannot see.
     */
    const run = (): string => {
      const session = createSession(duelLevel(9), { seed: 21 })
      for (let frame = 0; frame < 900; frame += 1) session.advance(1 / 60)
      return String(session.world.stateHash())
    }
    expect(run()).toBe(run())
  })

  it('and a different seed is a different mission', () => {
    // Without this, a roll that ignored the rng entirely would satisfy the test
    // above perfectly — the same trap `accuracy.test.ts` names.
    const run = (seed: number): string => {
      const session = createSession(duelLevel(9), { seed })
      for (let frame = 0; frame < 900; frame += 1) session.advance(1 / 60)
      return String(session.world.stateHash())
    }
    expect(run(21)).not.toBe(run(22))
  })
})

describe('the level still reacts to gunfire that missed', () => {
  it('a man who cannot see the fight still comes to look when a round goes wide', () => {
    /**
     * A MISSED SHOT IS STILL A SHOT. The AI reacts to `ShotFired`, not to a
     * death, so this needs no production code — which is exactly why it needs a
     * test. "The garrison stopped investigating gunfire once rounds could miss"
     * is the kind of regression that arrives as a level feeling asleep, with
     * nothing in any suite to say what broke.
     *
     * TWO WAYS THE FIRST DRAFT WAS WRONG, both worth recording because both are
     * traps this project keeps walking into:
     *
     *   - It never established that anything MISSED. A review set the session
     *     back to `hitPolicy: 'certain'` and it still passed, so it was guarding
     *     the criterion while blind to the only thing the criterion is about.
     *   - The listener was placed at 11.4 tiles from the player — INSIDE his
     *     twelve tiles of sight. He was walking because he could SEE the squad,
     *     and hearing had nothing to do with it. A probe I ran to "confirm" the
     *     fixture measured the same wrong thing and reported success.
     *
     * So he now stands nineteen tiles along the line: fifteen from the player,
     * which is outside sight, and six from the shooter, which is inside the
     * fourteen-tile alert radius. Gunfire is the only thing that can reach him.
     */
    const level = makeLevel({
      avatars: [{ x: 4, y: 7 }],
      enemies: [
        { x: 13, y: 7 },
        { x: 19, y: 7 },
      ],
    })

    /** Play one seed and report what the listener did and why he could have. */
    function watch(seed: number): { firstShotMissed: boolean; moved: boolean } {
      const session = createSession(level, { seed })
      const listener = session.world.entities.filter((e) => e.team === 'enemy')[1]
      if (listener === undefined) throw new Error('no listener spawned')
      const startX = listener.x
      const startZ = listener.z
      let firstShot: boolean | undefined
      let moved = false
      for (let frame = 0; frame < 900; frame += 1) {
        session.advance(1 / 60)
        for (const event of session.events()) {
          if (event.type === 'ShotFired' && firstShot === undefined) firstShot = event.hit
        }
        const now = session.world.get(listener.id)
        if (now === undefined) break
        if (Math.abs(now.x - startX) + Math.abs(now.z - startZ) > 1) {
          moved = true
          break
        }
      }
      return { firstShotMissed: firstShot === false, moved }
    }

    const runs = SEEDS.map(watch)
    // The precondition, stated as a real one: there must BE a run whose opening
    // round went wide, or this test has not looked at a miss at all.
    const openedWithAMiss = runs.filter((r) => r.firstShotMissed)
    expect(openedWithAMiss.length).toBeGreaterThan(0)
    // And in every one of those, the man who could only have heard it came.
    for (const run of openedWithAMiss) expect(run.moved).toBe(true)
  })
})
