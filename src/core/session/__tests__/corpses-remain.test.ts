import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'
import { frameAt } from '../../render-state/animation'
import type { LevelData } from '../../level/types'

/**
 * Ticket 049 — the dead stay on the field.
 *
 * A body used to be drawn for exactly as long as its death clip ran: four frames
 * at 8 fps, half a second, and then it was pruned. THE CLIP'S LAST FRAME IS THE
 * FALLEN POSE, so the corpse vanished at the moment it became the thing worth
 * looking at, and a firefight left no trace of itself.
 *
 * THE HOLD WAS ALREADY BUILT AND NOTHING HERE ADDS IT. `frameAt` clamps a
 * non-looping clip to `frameCount - 1` and says why in capitals — a looping death
 * animation resurrects corpses every half second. So this ticket is a deletion:
 * the pruning goes, and the pose that was always going to be held gets long
 * enough to be seen. The cases below assert the WHOLE path anyway, `frameAt`
 * included, because "the session keeps the corpse" and "the renderer draws the
 * right frame" being separately true is exactly the two-functions-that-agree
 * shape this project has shipped defects from four times.
 */

/** The `die` clip as `tools/spritegen` emits it: four frames at 8 fps, one-shot. */
const DIE_CLIP = { frameCount: 4, fps: 8, loop: false } as const

const ARENA = (): LevelData =>
  makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })

/**
 * Run until somebody dies, and report who and when.
 *
 * A GENEROUS BUDGET RATHER THAN A CLAIM ABOUT TIMING, for the two reasons
 * `render-entities.test.ts` gives: the first round is 45 ticks late (the reaction
 * beat, ticket 012a) and a round is a chance rather than a certainty since 011b.
 */
function fightUntilADeath(s: ReturnType<typeof createSession>) {
  let deadId = -1
  let team = ''
  let frames = 0
  for (; frames < 300 && deadId < 0; frames += 1) {
    s.advance(1 / 60)
    for (const e of s.events()) {
      if (e.type !== 'UnitDied') continue
      deadId = e.id
      team = e.team
    }
  }
  expect(deadId).toBeGreaterThanOrEqual(0)
  return { deadId, team, frames }
}

/** Advance `n` frames, draining events so nothing backs up. */
function run(s: ReturnType<typeof createSession>, n: number): void {
  for (let f = 0; f < n; f += 1) {
    s.advance(1 / 60)
    s.events()
  }
}

describe('a body is still there long after it fell', () => {
  it('ten seconds later, which is twenty times the clip', () => {
    /**
     * THE TICKET. This case previously existed INVERTED — `render-entities.test.ts`
     * asserted that a corpse was gone 120 frames after death, and that was the
     * behaviour, not an accident. It has been rewritten there rather than left to
     * contradict this.
     */
    const s = createSession(ARENA())
    const { deadId } = fightUntilADeath(s)
    run(s, 600)
    const drawn = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect(drawn).toBeDefined()
    expect(drawn?.animation).toBe('die')
  })

  it('and he is genuinely dead, not merely still in the world', () => {
    // The control. A corpse drawn because the sim never removed the entity would
    // satisfy the case above and mean something completely different.
    const s = createSession(ARENA())
    const { deadId } = fightUntilADeath(s)
    run(s, 600)
    expect(s.world.isAlive(deadId)).toBe(false)
    expect(s.world.entities.some((e) => e.id === deadId)).toBe(false)
  })
})

describe('and he is holding the last frame of the death cycle', () => {
  it('frame 3 of 4, which is what the whole ticket is for', () => {
    /**
     * THE END-TO-END ASSERTION, and the reason this file does not stop at "the
     * corpse is in the list".
     *
     * The session decides `animationStart`; `frameAt` turns the elapsed time
     * since it into an index; the renderer samples the atlas with that index. A
     * corpse kept for ten seconds whose frame came out 0 would be a man lying at
     * the instant he was hit, for ever — present, and wrong, with every case
     * above still green.
     */
    const s = createSession(ARENA())
    const { deadId } = fightUntilADeath(s)
    run(s, 600)
    const drawn = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect(drawn).toBeDefined()
    // The renderer's clock and the sim's agree here; `main.ts` passes its own
    // elapsed seconds, and the corpse's start is stamped in sim time.
    const now = s.world.tickCount / 60
    expect(frameAt(DIE_CLIP, now - (drawn?.animationStart ?? 0))).toBe(DIE_CLIP.frameCount - 1)
  })

  it('having actually played the earlier frames on the way', () => {
    /**
     * THE GUARD ON THE CASE ABOVE. A corpse pinned to frame 3 from the instant of
     * death would pass it — and would be a man who snaps flat rather than falls.
     * `animationStart` has to be the death, so the frame walks 0, 1, 2, 3.
     */
    const s = createSession(ARENA())
    const { deadId } = fightUntilADeath(s)
    const drawn = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect(drawn).toBeDefined()
    const start = drawn?.animationStart ?? 0
    const seen = [0, 0.13, 0.26, 0.4].map((offset) => frameAt(DIE_CLIP, offset))
    expect(seen).toEqual([0, 1, 2, 3])
    // And the start really is the death rather than zero-by-default, which is
    // what every LIVING entity reports.
    expect(start).toBeGreaterThan(0)
  })
})

describe('a body keeps what identified it', () => {
  it('the tint of the side he fought for', () => {
    /**
     * A field of untinted bodies is a field of nobody's men. The team comes off
     * `UnitDied`, which is the last thing that knew it — the entity is gone.
     *
     * ASSERTED AGAINST THE TEAM, not against the corpse's own earlier value. A
     * first draft compared the tint ten seconds in with the tint twenty seconds
     * in, which passes on `undefined === undefined` — so it would have gone green
     * on a corpse that had lost its tint at the moment it was created.
     */
    /**
     * A BRAWL RATHER THAN A DUEL, and the fixture is load-bearing. A first draft
     * took whoever fell first in a 1v1 — which is usually one of ours, and ours
     * are untinted — so `tint: undefined` on every corpse in the game passed it.
     * The second draft asked that fixture for an ENEMY death, which never comes:
     * the lone player loses. The third made it eight a side and still saw none —
     * `autoEngageTeams` defaults to `['enemy']`, so a player squad with no orders
     * stands there and is shot. THE SQUAD HAS TO BE TOLD TO FIRE, and then both
     * sides lose men: measured at 8 player and 5 enemy deaths over these 900
     * frames. Mutation-checked: dropping the corpse tint fails here now.
     */
    const s = createSession(
      makeLevel({
        avatars: Array.from({ length: 8 }, (_v, i) => ({ x: 6, y: 3 + i })),
        enemies: Array.from({ length: 8 }, (_v, i) => ({ x: 9, y: 3 + i })),
      }),
    )
    const teamOf = new Map<number, string>()
    for (let f = 0; f < 900; f += 1) {
      // Re-issued periodically rather than once: an order is dropped when its
      // target dies, and this fixture kills the man it was aimed at.
      if (f % 60 === 0) {
        for (const unit of s.world.entities) {
          if (unit.team !== 'player') continue
          s.queue.push({
            type: 'fire',
            unitIds: [unit.id],
            ordnance: 'rifle',
            target: { x: 9, y: 6 },
          })
        }
      }
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'UnitDied') teamOf.set(e.id, e.team)
    }
    const bodies = s.renderEntities(FLAT).filter((r) => r.animation === 'die')
    const byTeam = (team: string) => bodies.filter((b) => teamOf.get(b.id) === team)
    // Both sides really lost men, or the comparison below has nothing to compare.
    expect(byTeam('enemy').length).toBeGreaterThan(0)
    expect(byTeam('player').length).toBeGreaterThan(0)
    expect(byTeam('enemy').every((b) => b.tint !== undefined)).toBe(true)
    expect(byTeam('player').every((b) => b.tint === undefined)).toBe(true)
  })

  it('and the spot he fell on, which never drifts', () => {
    const s = createSession(ARENA())
    const { deadId } = fightUntilADeath(s)
    const fell = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect(fell).toBeDefined()
    run(s, 900)
    const later = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect({ x: later?.x, z: later?.z }).toEqual({ x: fell?.x, z: fell?.z })
  })
})

describe('the field fills up, but only with the men who died on it', () => {
  it('never more bodies than there were soldiers, and never a duplicate', () => {
    /**
     * THE BOUND, now that nothing prunes. It is not a capacity — it is that a man
     * dies once and ids are never reused within a mission (`world.ts` states
     * both), so the list cannot exceed the roll. A corpse pushed twice, or a
     * living man drawn beside his own body, fails here.
     */
    const s = createSession(
      makeLevel({
        avatars: Array.from({ length: 8 }, (_v, i) => ({ x: 6, y: 3 + i })),
        enemies: Array.from({ length: 8 }, (_v, i) => ({ x: 9, y: 3 + i })),
      }),
    )
    run(s, 900)
    const drawn = s.renderEntities(FLAT)
    const ids = drawn.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const bodies = drawn.filter((r) => r.animation === 'die')
    expect(bodies.length).toBeLessThanOrEqual(16)
    // And the fixture really produced casualties, or this bounds nothing.
    expect(bodies.length).toBeGreaterThan(0)
  })

  it('and a fresh mission opens on clean ground', () => {
    /**
     * BY CONSTRUCTION RATHER THAN BY A RESET, and worth pinning either way.
     * `main.ts`'s `startMission` builds a NEW session per mission, so the corpse
     * list dies with the old one — there is no `corpses.length = 0` to forget to
     * call. The day a session is reused instead, this is what fails.
     */
    const s = createSession(ARENA())
    fightUntilADeath(s)
    run(s, 300)
    expect(s.renderEntities(FLAT).some((r) => r.animation === 'die')).toBe(true)
    const next = createSession(ARENA())
    expect(next.renderEntities(FLAT).some((r) => r.animation === 'die')).toBe(false)
  })
})

describe('and none of it reaches the simulation', () => {
  it('a mission hashes the same whether or not anybody drew the bodies', () => {
    /**
     * CORPSES ARE PRESENTATION. They are built from `UnitDied` after the fact and
     * the entity is already out of `world.entities`, so nothing about keeping
     * them can move a mission — and `renderEntities` is a pure read, which is the
     * property that could break if a corpse were ever pruned from inside it.
     *
     * Keeping them for a whole mission makes that list hundreds of times longer
     * than it was, so it is worth re-asserting at the new size rather than
     * trusting the ticket-025 version of this argument.
     */
    const play = (draw: boolean): number => {
      const s = createSession(ARENA(), { seed: 4 })
      for (let f = 0; f < 900; f += 1) {
        s.advance(1 / 60)
        s.events()
        if (draw) s.renderEntities(FLAT)
      }
      return s.world.stateHash()
    }
    expect(play(true)).toBe(play(false))
  })
})
