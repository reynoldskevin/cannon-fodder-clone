import { describe, it, expect } from 'vitest'
import { createGameLoop, FIXED_TIMESTEP, MAX_STEPS_PER_FRAME } from '../gameloop'

/**
 * Ticket 005 — the fixed-timestep accumulator.
 *
 * `ARCHITECTURE.md` ("Determinism"): the sim runs at a fixed 60 Hz regardless of
 * display rate, and the renderer interpolates. That separation is what lets the
 * same mission play out identically on a 60 Hz laptop and a 144 Hz monitor —
 * without it, frame timing leaks into simulation results and determinism (and
 * every test above it) is a fiction.
 *
 * This module is deliberately engine-free and pure: `advance(dt)` is a function
 * of real elapsed time and returns how many whole sim steps to run, exactly the
 * way `core/view/orientation.ts` holds the camera maths that `render/camera-rig`
 * merely plumbs. `app/` owns the requestAnimationFrame call; none of it is here.
 */

describe('FIXED_TIMESTEP', () => {
  it('is 60 Hz', () => {
    expect(FIXED_TIMESTEP).toBeCloseTo(1 / 60, 10)
  })
})

describe('createGameLoop', () => {
  describe('step accumulation', () => {
    it('runs no step for a frame shorter than one timestep', () => {
      const loop = createGameLoop()
      expect(loop.advance(FIXED_TIMESTEP / 2)).toBe(0)
    })

    it('runs exactly one step for exactly one timestep', () => {
      const loop = createGameLoop()
      expect(loop.advance(FIXED_TIMESTEP)).toBe(1)
    })

    it('runs two steps for a frame worth two timesteps', () => {
      const loop = createGameLoop()
      expect(loop.advance(FIXED_TIMESTEP * 2)).toBe(2)
    })

    it('carries the remainder into the next frame', () => {
      const loop = createGameLoop()
      // Three-quarters of a step twice = 1.5 steps: one step, then one more.
      expect(loop.advance(FIXED_TIMESTEP * 0.75)).toBe(0)
      expect(loop.advance(FIXED_TIMESTEP * 0.75)).toBe(1)
      expect(loop.advance(FIXED_TIMESTEP * 0.75)).toBe(1)
    })

    it('does not lose or invent time over a long uneven run', () => {
      // The property that matters: total steps tracks total elapsed time. A
      // rounding bug here shows up as a mission that drifts slowly out of sync.
      const loop = createGameLoop()
      const frames = [0.016, 0.017, 0.0083, 0.0331, 0.012, 0.021, 0.0166, 0.009]
      let steps = 0
      let elapsed = 0
      for (let i = 0; i < 500; i++) {
        const dt = frames[i % frames.length]!
        elapsed += dt
        steps += loop.advance(dt)
      }
      const expected = Math.floor(elapsed / FIXED_TIMESTEP)
      expect(Math.abs(steps - expected)).toBeLessThanOrEqual(1)
    })

    it('produces 60 steps for one second of 144 Hz frames', () => {
      const loop = createGameLoop()
      let steps = 0
      for (let i = 0; i < 144; i++) steps += loop.advance(1 / 144)
      expect(steps).toBe(60)
    })

    it('produces 60 steps for one second of 30 Hz frames', () => {
      const loop = createGameLoop()
      let steps = 0
      for (let i = 0; i < 30; i++) steps += loop.advance(1 / 30)
      expect(steps).toBe(60)
    })
  })

  describe('spiral-of-death protection', () => {
    it('caps the steps run for one enormous frame', () => {
      // A tab restored after a minute in the background hands us dt = 60s. Left
      // uncapped that is 3600 sim steps in one frame, which blocks the main
      // thread long enough to produce the next enormous frame — the spiral.
      const loop = createGameLoop()
      expect(loop.advance(60)).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME)
    })

    it('discards the unrunnable backlog rather than deferring it', () => {
      // Carrying the backlog forward just moves the spiral to the next frame.
      const loop = createGameLoop()
      loop.advance(60)
      expect(loop.advance(FIXED_TIMESTEP)).toBe(1)
    })

    it('MAX_STEPS_PER_FRAME leaves room for an ordinary slow frame', () => {
      // Must not clamp so hard that a legitimate 100ms hitch loses time.
      expect(MAX_STEPS_PER_FRAME).toBeGreaterThanOrEqual(6)
    })
  })

  describe('interpolation alpha', () => {
    it('starts at zero', () => {
      expect(createGameLoop().alpha).toBe(0)
    })

    it('stays within [0, 1)', () => {
      const loop = createGameLoop()
      for (let i = 0; i < 1000; i++) {
        loop.advance((i % 17) * 0.003)
        expect(loop.alpha).toBeGreaterThanOrEqual(0)
        expect(loop.alpha).toBeLessThan(1)
      }
    })

    it('reports the fraction of a step already elapsed', () => {
      const loop = createGameLoop()
      loop.advance(FIXED_TIMESTEP * 0.25)
      expect(loop.alpha).toBeCloseTo(0.25, 6)
      loop.advance(FIXED_TIMESTEP * 0.25)
      expect(loop.alpha).toBeCloseTo(0.5, 6)
    })

    it('wraps back toward zero after a step is consumed', () => {
      const loop = createGameLoop()
      loop.advance(FIXED_TIMESTEP * 1.25)
      expect(loop.alpha).toBeCloseTo(0.25, 6)
    })

    it('is zero after an exact whole number of steps', () => {
      const loop = createGameLoop()
      loop.advance(FIXED_TIMESTEP * 3)
      expect(loop.alpha).toBeCloseTo(0, 6)
    })

    it('is finite after a capped enormous frame', () => {
      const loop = createGameLoop()
      loop.advance(600)
      expect(Number.isFinite(loop.alpha)).toBe(true)
      expect(loop.alpha).toBeGreaterThanOrEqual(0)
      expect(loop.alpha).toBeLessThan(1)
    })
  })

  describe('hostile input', () => {
    it('ignores a negative frame time rather than rewinding', () => {
      const loop = createGameLoop()
      expect(loop.advance(-5)).toBe(0)
      expect(loop.alpha).toBe(0)
      expect(loop.advance(FIXED_TIMESTEP)).toBe(1)
    })

    it('ignores NaN without poisoning the accumulator', () => {
      const loop = createGameLoop()
      expect(loop.advance(Number.NaN)).toBe(0)
      expect(loop.advance(FIXED_TIMESTEP)).toBe(1)
      expect(Number.isFinite(loop.alpha)).toBe(true)
    })

    it('ignores Infinity without running unbounded steps', () => {
      const loop = createGameLoop()
      expect(loop.advance(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME)
      expect(Number.isFinite(loop.alpha)).toBe(true)
    })

    it('accepts a zero frame time', () => {
      const loop = createGameLoop()
      expect(loop.advance(0)).toBe(0)
      expect(loop.alpha).toBe(0)
    })
  })

  describe('reset', () => {
    it('clears the accumulator and alpha', () => {
      const loop = createGameLoop()
      loop.advance(FIXED_TIMESTEP * 0.6)
      loop.reset()
      expect(loop.alpha).toBe(0)
      expect(loop.advance(FIXED_TIMESTEP * 0.5)).toBe(0)
    })
  })

  describe('determinism', () => {
    it('two loops fed the same frame times agree exactly', () => {
      const a = createGameLoop()
      const b = createGameLoop()
      const dts = Array.from({ length: 300 }, (_, i) => 0.004 + ((i * 7) % 23) * 0.001)
      for (const dt of dts) {
        expect(a.advance(dt)).toBe(b.advance(dt))
        expect(a.alpha).toBe(b.alpha)
      }
    })
  })
})
