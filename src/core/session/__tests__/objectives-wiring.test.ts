import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { FIXED_TIMESTEP } from '../../world'
import { tileToWorld } from '../../view/projection'
import type { LevelObjective } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 013 — the objective system, wired into a real session.
 *
 * ASSERTED THROUGH `advance`, like every other wiring test in this directory.
 * The failure mode is not "does the evaluator work" — `core/objectives` has its
 * own suite for that — it is "is the evaluator actually running, over the world
 * the player is looking at, in the right place in the tick". A session that
 * builds the system correctly and forgets to register it, or registers it before
 * combat so a mission ends one tick late, passes any test that reads its
 * configuration back.
 *
 * A MISSION IS PLAYED TO A WIN AND TO A LOSS HERE, end to end, because that is
 * the acceptance criterion the whole ticket exists for and it is the one thing
 * no unit test of the evaluator can claim.
 */

/** One avatar against one enemy, three tiles apart and in plain sight. */
const duel = (objectives?: readonly LevelObjective[]) =>
  makeLevel({
    avatars: [{ x: 8, y: 7 }],
    enemies: [{ x: 11, y: 7 }],
    ...(objectives === undefined ? {} : { objectives }),
  })

function play(s: ReturnType<typeof createSession>, frames: number): SimEvent[] {
  const seen: SimEvent[] = []
  for (let f = 0; f < frames; f += 1) {
    s.advance(1 / 60)
    seen.push(...s.events())
  }
  return seen
}

describe('the objective system runs inside the session', () => {
  it('is registered last, after the systems whose results it judges', () => {
    // A mission is judged on the world as it stands at the END of the tick, so
    // the last enemy killed by this tick's combat pass ends the mission in this
    // tick rather than the next. Registered anywhere earlier and every mission
    // ends one tick late — invisible, and wrong.
    expect(createSession(duel()).systemOrder).toEqual(['ai', 'squad', 'combat', 'ordnance', 'objectives'])
  })

  it('reports the level`s objectives, in the level`s order', () => {
    const s = createSession(duel([{ type: 'kill_all' }, { type: 'reach_area', x: 2, y: 2, radius: 2 }]))
    expect(s.objectives.progress().map((p) => p.type)).toEqual(['kill_all', 'reach_area'])
  })

  it('starts out playing', () => {
    expect(createSession(duel()).outcome()).toBe('playing')
  })
})

describe('a mission played to a win', () => {
  /**
   * The player is given a tough body double and the fire order to use it with.
   *
   * BOTH HALVES ARE FORCED BY THE TUNING, not by convenience. At
   * `INFANTRY_HEALTH = 1` the avatar the level supplies dies to the first round
   * the enemy fires, so a session left to run itself is a LOSS every time and
   * the winning path could never be reached. And since ticket 011a the player
   * squad holds fire until ordered, so somebody has to pull the trigger.
   */
  const winning = () => {
    const level = duel()
    const s = createSession(level)
    const at = tileToWorld(9, 7, level.size)
    const hero = s.world.spawn({
      kind: 'rifleman',
      team: 'player',
      x: at.x,
      z: at.z,
      health: 10_000,
    })
    s.queue.push({
      type: 'fire',
      unitIds: [hero.id],
      ordnance: 'rifle',
      target: { x: 11, y: 7 },
    })
    return { s, hero }
  }

  it('kills the last enemy and emits MissionComplete exactly once', () => {
    const { s } = winning()
    const events = play(s, 600)
    expect(s.world.entities.filter((e) => e.team === 'enemy')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(1)
  })

  it('reports the outcome afterwards', () => {
    const { s } = winning()
    play(s, 600)
    expect(s.outcome()).toBe('complete')
  })

  it('keeps stepping after the mission is over', () => {
    // Freezing the sim on the winning tick would cut off the death animation of
    // the man who won it. The app decides what to show; the sim stops caring,
    // not ticking.
    const { s } = winning()
    play(s, 600)
    const before = s.world.tickCount
    play(s, 30)
    expect(s.world.tickCount).toBeGreaterThan(before)
  })

  it('and emits nothing further', () => {
    const { s } = winning()
    play(s, 600)
    const after = play(s, 300)
    expect(after.filter((e) => e.type === 'MissionComplete' || e.type === 'MissionFailed')).toEqual(
      [],
    )
  })
})

describe('a mission played to a loss', () => {
  it('the squad is wiped out and MissionFailed is emitted exactly once', () => {
    // No fire order, so the player's one avatar stands there and is shot — which
    // is exactly what the game does to a player who never touches the right
    // mouse button, and worth having asserted.
    const s = createSession(duel())
    const events = play(s, 600)
    expect(s.world.entities.filter((e) => e.team === 'player')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'MissionFailed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(0)
    expect(s.outcome()).toBe('failed')
  })

  it('does not fail before the last man falls', () => {
    const s = createSession(
      makeLevel({
        avatars: [
          { x: 14, y: 2 }, // two tiles from the enemy: dead within the second
          { x: 1, y: 13 }, // 18.6 tiles away: outside the AI's 12 of sight
        ],
        enemies: [{ x: 16, y: 2 }],
      }),
    )
    /**
     * THE SECOND MAN HAS TO BE GENUINELY OUT OF REACH, and the first draft of
     * this test got that wrong: it put him 10.3 tiles from the enemy on a 20x15
     * map, inside `DEFAULT_SIGHT_RANGE_TILES` of 12, so the enemy walked over
     * and killed him too and the mission failed after all. The number is checked
     * rather than eyeballed now — 18.6 tiles, half a map away.
     */
    const events = play(s, 200)
    expect(s.world.entities.filter((e) => e.team === 'player').length).toBeGreaterThan(0)
    expect(events.filter((e) => e.type === 'MissionFailed')).toHaveLength(0)
    expect(s.outcome()).toBe('playing')
  })
})

describe('the mission timer', () => {
  /**
   * NOT `duel()`, and the reason is worth writing down: the timer STOPS when the
   * mission resolves (`objectives/__tests__/mission-end.test.ts` pins that), and
   * in a duel the avatar is dead on tick 1 — one hit point, an enemy three tiles
   * away in plain sight with its weapon off cooldown. Timing a mission that
   * ended before the second frame measures nothing. These two are nineteen tiles
   * apart, well outside the AI's twelve of sight, so nothing happens to either
   * of them and the clock is the only thing moving.
   */
  const quiet = () => makeLevel({ avatars: [{ x: 2, y: 2 }], enemies: [{ x: 18, y: 13 }] })

  it('is the simulation`s own clock, in ticks', () => {
    const s = createSession(quiet())
    for (let f = 0; f < 60; f += 1) s.advance(FIXED_TIMESTEP)
    expect({ ticks: s.objectives.elapsedTicks, outcome: s.outcome() }).toEqual({
      ticks: 60,
      outcome: 'playing',
    })
  })

  it('does not advance on a frame too short to step', () => {
    // The whole reason it is not a wall clock: a stalled or sub-step frame must
    // not age a mission that did not advance.
    const s = createSession(quiet())
    s.advance(FIXED_TIMESTEP)
    const at = s.objectives.elapsedTicks
    s.advance(FIXED_TIMESTEP / 8)
    expect(s.objectives.elapsedTicks).toBe(at)
  })
})

describe('determinism survives the objective system', () => {
  it('two identical missions end the same way on the same tick', () => {
    const run = (): string => {
      const s = createSession(duel(), { seed: 3 })
      let ended = 'none'
      for (let f = 0; f < 600; f += 1) {
        s.advance(1 / 60)
        for (const e of s.events()) {
          if (e.type === 'MissionComplete') ended = `complete@${e.tick}`
          if (e.type === 'MissionFailed') ended = `failed@${e.tick}`
        }
      }
      return ended
    }
    const first = run()
    expect(first).not.toBe('none') // the mission actually resolved
    expect(run()).toBe(first)
  })
})
