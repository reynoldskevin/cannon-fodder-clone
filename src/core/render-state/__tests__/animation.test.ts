import { describe, it, expect } from 'vitest'
import { frameAt, phaseOffset } from '../animation'

/**
 * Ticket 010 — animation playback.
 *
 * The one-shot case is the one that matters most: `die` must play once and HOLD
 * its final frame. If it loops, corpses spring back to life, which is both a
 * gameplay lie and the sort of thing that shows up in a demo.
 */

const WALK = { frameCount: 4, fps: 12, loop: true }
const DIE = { frameCount: 4, fps: 8, loop: false }

describe('frameAt — looping', () => {
  it('starts on frame 0', () => {
    expect(frameAt(WALK, 0)).toBe(0)
  })

  it('advances one frame per 1/fps seconds', () => {
    expect(frameAt(WALK, 1 / 12 - 0.001)).toBe(0)
    expect(frameAt(WALK, 1 / 12 + 0.001)).toBe(1)
    expect(frameAt(WALK, 2 / 12 + 0.001)).toBe(2)
  })

  it('wraps back to 0 after the last frame', () => {
    expect(frameAt(WALK, 4 / 12 + 0.001)).toBe(0)
  })

  it('keeps looping over many cycles', () => {
    expect(frameAt(WALK, 100 + 1 / 12 + 0.001)).toBe(frameAt(WALK, 1 / 12 + 0.001))
  })

  it('never returns an out-of-range frame', () => {
    for (let t = 0; t < 5; t += 0.013) {
      const f = frameAt(WALK, t)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(WALK.frameCount)
      expect(Number.isInteger(f)).toBe(true)
    }
  })
})

describe('frameAt — one-shot', () => {
  it('plays through its frames', () => {
    expect(frameAt(DIE, 0)).toBe(0)
    expect(frameAt(DIE, 1 / 8 + 0.001)).toBe(1)
    expect(frameAt(DIE, 2 / 8 + 0.001)).toBe(2)
  })

  it('holds the final frame instead of looping', () => {
    expect(frameAt(DIE, 3 / 8 + 0.001)).toBe(3)
    expect(frameAt(DIE, 4 / 8 + 0.001)).toBe(3)
    expect(frameAt(DIE, 60)).toBe(3)
  })

  it('a corpse never returns to frame 0', () => {
    for (let t = 4 / 8; t < 30; t += 0.05) {
      expect(frameAt(DIE, t)).toBe(DIE.frameCount - 1)
    }
  })
})

describe('frameAt — degenerate input', () => {
  it('clamps negative time to the first frame', () => {
    expect(frameAt(WALK, -5)).toBe(0)
  })

  it('handles a single-frame animation', () => {
    expect(frameAt({ frameCount: 1, fps: 12, loop: true }, 99)).toBe(0)
    expect(frameAt({ frameCount: 1, fps: 12, loop: false }, 99)).toBe(0)
  })

  it('does not divide by zero on zero fps', () => {
    const f = frameAt({ frameCount: 4, fps: 0, loop: true }, 3)
    expect(Number.isInteger(f)).toBe(true)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeLessThan(4)
  })

  it('survives non-finite time', () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = frameAt(WALK, t)
      expect(Number.isInteger(f)).toBe(true)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(4)
    }
  })
})

describe('phaseOffset', () => {
  it('is deterministic for a given entity id', () => {
    expect(phaseOffset(42)).toBe(phaseOffset(42))
  })

  it('differs between neighbouring ids, so a squad does not march in lockstep', () => {
    const offsets = [1, 2, 3, 4, 5, 6, 7, 8].map(phaseOffset)
    expect(new Set(offsets).size).toBeGreaterThan(1)
  })

  it('spreads a squad across the cycle rather than clustering', () => {
    const offsets = Array.from({ length: 8 }, (_, i) => phaseOffset(i))
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(0.3)
  })

  it('stays within one animation cycle', () => {
    for (let id = 0; id < 200; id++) {
      expect(phaseOffset(id)).toBeGreaterThanOrEqual(0)
      expect(phaseOffset(id)).toBeLessThan(1)
    }
  })

  it('shifts which frame an entity shows', () => {
    // Two entities at the same wall-clock time should not always agree.
    const t = 0.1
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((id) =>
      frameAt(WALK, t + phaseOffset(id) * (WALK.frameCount / WALK.fps)),
    )
    expect(new Set(frames).size).toBeGreaterThan(1)
  })
})
