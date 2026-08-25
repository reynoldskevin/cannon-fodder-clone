import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import type { Command } from '../../command'

/**
 * Ticket 008a — the whole sim, replayed.
 *
 * Every layer under this one has its own determinism suite; this is the one that
 * matters, because it is the only one that runs them TOGETHER against real frame
 * deltas. The individual guarantees compose only if nothing in the wiring
 * introduces order-dependence — a `Set` of ids iterated to build render state, a
 * corpse list keyed on a `Map`, systems registered in a different order.
 *
 * The frame deltas are deliberately ragged. A test that feeds a clean 1/60 every
 * frame never exercises the accumulator, and the accumulator is the one place
 * where real frame timing leaks into the simulation.
 */

/** Frame deltas that look like a real, slightly janky browser. */
const FRAMES = [
  0.0166, 0.0171, 0.0083, 0.0332, 0.0159, 0.0166, 0.0201, 0.0143, 0.25, 0.0166, 0.0169, 0.0158,
]

/**
 * The one level every run in this file uses.
 *
 * A function rather than a constant so each session gets its own document, and
 * shared so the COMMAND SCRIPT is derived from the same roster the run uses. An
 * earlier version built the script from `makeLevel()`'s two-avatar default while
 * `play` ran a four-avatar level: frames 2 and 40 then addressed the same two
 * men, the other two were never ordered at all, nobody closed to within the
 * rifle's 8 tiles, and the "not vacuous" assertion failed for want of a corpse.
 * The run was perfectly deterministic and completely uneventful, which is the
 * least useful thing a determinism test can be.
 */
const battlefield = () =>
  makeLevel({
    avatars: [
      { x: 3, y: 5 },
      { x: 3, y: 6 },
      { x: 4, y: 5 },
      { x: 4, y: 6 },
    ],
    enemies: [
      { x: 14, y: 5 },
      { x: 14, y: 7 },
      { x: 15, y: 6 },
    ],
    blocked: new Set(['9,4', '9,5', '9,6', '9,7']),
  })

function play(commandsAtFrame: ReadonlyMap<number, Command[]>, frames: number): unknown {
  const session = createSession(battlefield())
  const eventTypes: string[] = []

  for (let f = 0; f < frames; f++) {
    for (const command of commandsAtFrame.get(f) ?? []) session.queue.push(command)
    session.advance(FRAMES[f % FRAMES.length]!)
    for (const e of session.events()) eventTypes.push(e.type)
  }

  return {
    tick: session.world.tickCount,
    entities: session.world.entities.map((e) => ({
      id: e.id,
      x: e.x,
      z: e.z,
      health: e.health,
      state: e.state,
    })),
    eventTypes,
  }
}

/** The same script both times: an initial order, then a split halfway through. */
function script(): ReadonlyMap<number, Command[]> {
  const players = [...createSession(battlefield()).selection()]
  return new Map<number, Command[]>([
    [2, [{ type: 'move', unitIds: players, target: { x: 16, y: 6 } }]],
    [40, [{ type: 'move', unitIds: players.slice(0, 2), target: { x: 3, y: 1 } }]],
  ])
}

describe('session determinism', () => {
  it('two sessions given the same commands and frames end identically', () => {
    const commands = script()
    expect(play(commands, 120)).toEqual(play(commands, 120))
  })

  it('stays identical at every checkpoint, not just the end', () => {
    const commands = script()
    for (const frames of [1, 5, 23, 60, 120, 200]) {
      expect({ frames, state: play(commands, frames) }).toEqual({
        frames,
        state: play(commands, frames),
      })
    }
  })

  it('is not vacuous — the run actually does something', () => {
    const commands = script()
    const result = play(commands, 200) as {
      tick: number
      entities: unknown[]
      eventTypes: string[]
    }
    expect(result.tick).toBeGreaterThan(100)
    expect(result.eventTypes.length).toBeGreaterThan(0)
    // Somebody died: the two sides really did meet.
    expect(result.eventTypes).toContain('UnitDied')
  })

  it('does not depend on the render state having been read', () => {
    // `renderEntities` must be a pure READ. If it lazily updated anything the
    // sim later consults — a corpse list, a facing cache — then a headless
    // replay would diverge from a rendered one, and the bug would only appear
    // in the actual game.
    const commands = script()

    const withReads = (): unknown => {
      const level = makeLevel({
        avatars: [
          { x: 3, y: 5 },
          { x: 3, y: 6 },
        ],
        enemies: [{ x: 14, y: 5 }],
      })
      const session = createSession(level)
      for (let f = 0; f < 150; f++) {
        for (const c of commands.get(f) ?? []) session.queue.push(c)
        session.advance(FRAMES[f % FRAMES.length]!)
        session.events()
        session.renderEntities(() => 0) // the extra read
      }
      return session.world.entities.map((e) => ({ id: e.id, x: e.x, z: e.z, health: e.health }))
    }

    const withoutReads = (): unknown => {
      const level = makeLevel({
        avatars: [
          { x: 3, y: 5 },
          { x: 3, y: 6 },
        ],
        enemies: [{ x: 14, y: 5 }],
      })
      const session = createSession(level)
      for (let f = 0; f < 150; f++) {
        for (const c of commands.get(f) ?? []) session.queue.push(c)
        session.advance(FRAMES[f % FRAMES.length]!)
        session.events()
      }
      return session.world.entities.map((e) => ({ id: e.id, x: e.x, z: e.z, health: e.health }))
    }

    expect(withReads()).toEqual(withoutReads())
  })

  it('gives the same render state for the same sim state', () => {
    const level = makeLevel()
    const a = createSession(level)
    const b = createSession(level)
    for (let f = 0; f < 90; f++) {
      a.advance(FRAMES[f % FRAMES.length]!)
      b.advance(FRAMES[f % FRAMES.length]!)
    }
    expect(a.renderEntities(() => 0)).toEqual(b.renderEntities(() => 0))
  })
})
