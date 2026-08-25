import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { FIXED_TIMESTEP, MAX_STEPS_PER_FRAME } from '../../world/gameloop'

/**
 * Ticket 008a — driving the fixed-timestep loop from real frame deltas.
 *
 * Ticket 005 built the accumulator and tested it in isolation; nothing has ever
 * driven it. The interesting part is not the arithmetic — that is 005's — but
 * the ORDER of what happens around it: commands must be applied before the
 * systems that read them, and the frame's leftover alpha must be the one the
 * renderer is handed, or the interpolation smooths toward a state the sim has
 * not computed yet.
 */

describe('advance', () => {
  it('runs no step for a frame shorter than the timestep', () => {
    const s = createSession(makeLevel())
    const before = s.world.tickCount
    s.advance(FIXED_TIMESTEP / 4)
    expect(s.world.tickCount).toBe(before)
  })

  it('runs exactly one step for a frame of one timestep', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP)
    expect(s.world.tickCount).toBe(1)
  })

  it('runs the right number of steps for a long frame', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP * 4)
    expect(s.world.tickCount).toBe(4)
  })

  it('accumulates fractional frames into whole steps', () => {
    const s = createSession(makeLevel())
    for (let i = 0; i < 4; i++) s.advance(FIXED_TIMESTEP / 2)
    expect(s.world.tickCount).toBe(2)
  })

  it('clamps a very long frame rather than spiralling', () => {
    // The classic death: a backgrounded tab returns, the accumulator holds ten
    // seconds, the sim runs 600 steps, the frame takes longer than the last one,
    // and the accumulator grows again. The cap is the whole point.
    const s = createSession(makeLevel())
    s.advance(10)
    expect(s.world.tickCount).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME)
  })

  it('does not keep running the backlog on later frames', () => {
    const s = createSession(makeLevel())
    s.advance(10)
    const after = s.world.tickCount
    s.advance(FIXED_TIMESTEP)
    expect(s.world.tickCount).toBe(after + 1)
  })

  it('ignores a zero or negative frame', () => {
    const s = createSession(makeLevel())
    s.advance(0)
    s.advance(-1)
    expect(s.world.tickCount).toBe(0)
  })

  it('ignores a non-finite frame', () => {
    const s = createSession(makeLevel())
    expect(() => {
      s.advance(Number.NaN)
      s.advance(Number.POSITIVE_INFINITY)
    }).not.toThrow()
    expect(s.world.tickCount).toBe(0)
  })
})

describe('alpha', () => {
  it('is in [0, 1)', () => {
    const s = createSession(makeLevel())
    for (const dt of [0.001, 0.008, FIXED_TIMESTEP, 0.05, 0.3, 7]) {
      const alpha = s.advance(dt)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('reports the fraction of a step already accumulated', () => {
    const s = createSession(makeLevel())
    expect(s.advance(FIXED_TIMESTEP / 2)).toBeCloseTo(0.5, 6)
  })

  it('is near zero straight after a whole number of steps', () => {
    const s = createSession(makeLevel())
    expect(s.advance(FIXED_TIMESTEP * 3)).toBeCloseTo(0, 6)
  })

  it('is not always the hardcoded 1 that main.ts used to pass', () => {
    // The specific regression: `built.entities.update(elapsed, 1)` was honest
    // while no sim existed and becomes a lie the moment one does — it pins every
    // frame to the latest tick and throws the interpolation away.
    const s = createSession(makeLevel())
    const alphas = [0.004, 0.011, 0.02].map((dt) => s.advance(dt))
    expect(alphas.every((a) => a === 1)).toBe(false)
  })
})

describe('commands are applied before the systems that read them', () => {
  it('a command pushed between frames takes effect on the next step', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP)
    expect(s.squad.targetOf(id)).toEqual({ x: 17, y: 7 })
  })

  it('drains the queue, so a command is applied exactly once', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP)
    expect(s.queue.size).toBe(0)
    // A second order that is never pushed must not somehow re-apply the first.
    s.squad.order([id], { x: 2, y: 1 })
    s.advance(FIXED_TIMESTEP * 10)
    expect(s.squad.targetOf(id)).toEqual({ x: 2, y: 1 })
  })

  it('moves the squad over a whole second of frames', () => {
    // The end-to-end shape of the ticket: push a command, run frames, look.
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    const startX = s.world.get(id)!.x
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    for (let f = 0; f < 120; f++) s.advance(1 / 60)
    expect(s.world.get(id)!.x).toBeGreaterThan(startX + 3)
  })

  it('applies commands queued during a multi-step frame at the first step', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    const startX = s.world.get(id)!.x
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP * 5)

    // FIVE steps of movement, not one. If the order were applied after the
    // steps ran, the unit would not have moved at all this frame; if it were
    // applied once per frame but the steps ran first, it would have moved less.
    // At the default 3 tiles/sec a step is 0.05 tiles, so five is about 0.25.
    const moved = s.world.get(id)!.x - startX
    expect(moved).toBeGreaterThan(0.15)
    expect(moved).toBeLessThan(0.4)
    expect(s.squad.targetOf(id)).toEqual({ x: 17, y: 7 })
    expect(s.queue.size).toBe(0)
  })

  it('drops a command naming a unit that died earlier in the same frame', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.world.despawn(id)
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    expect(() => {
      s.advance(FIXED_TIMESTEP)
    }).not.toThrow()
    expect(s.squad.detachmentCount).toBe(0)
  })
})

describe('system order', () => {
  it('runs squad movement before combat', () => {
    // Asserted rather than assumed. Combat last means a unit that moved this
    // tick shoots from where it now stands, which is what a player watching the
    // screen expects — and it is also the order in which a unit can step into
    // line of sight and fire in the same tick.
    expect(createSession(makeLevel()).systemOrder).toEqual(['squad', 'combat'])
  })
})

describe('events', () => {
  it('hands back what the tick emitted, then empties', () => {
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })
    const s = createSession(level)
    let sawShot = false
    for (let f = 0; f < 30 && !sawShot; f++) {
      s.advance(1 / 60)
      sawShot = s.events().some((e) => e.type === 'ShotFired')
    }
    expect(sawShot).toBe(true)
    // Drained: asking again in the same frame yields nothing.
    expect(s.events()).toEqual([])
  })

  it('does not lose the events of a multi-step frame', () => {
    // The hazard: draining inside the step loop and overwriting the buffer each
    // time, so a frame that ran eight steps reports only the eighth step's
    // events. Compared against the same eight steps run one frame at a time,
    // which cannot lose anything.
    const level = () => makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })

    const oneBig = createSession(level())
    oneBig.advance(FIXED_TIMESTEP * 8)
    const fromOneFrame = oneBig.events()

    const eightSmall = createSession(level())
    const fromEightFrames = []
    for (let i = 0; i < 8; i++) {
      eightSmall.advance(FIXED_TIMESTEP)
      fromEightFrames.push(...eightSmall.events())
    }

    expect(fromOneFrame.length).toBeGreaterThan(0) // non-vacuous
    expect(fromOneFrame.map((e) => e.type)).toEqual(fromEightFrames.map((e) => e.type))
  })
})
