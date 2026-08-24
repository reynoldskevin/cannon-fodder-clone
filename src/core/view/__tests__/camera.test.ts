import { describe, it, expect } from 'vitest'
import { clampCameraTarget, followStep, shakeStep, centroid } from '../camera'
import { levelWorldBounds } from '../projection'

/**
 * Ticket 009 — camera rig maths.
 *
 * The rig itself is Three.js and untested by design; these are the decisions it
 * makes. `viewport` is the half-extent the orthographic camera can see in world
 * units, so clamping keeps the visible rectangle inside the level rather than
 * keeping the centre point inside it — otherwise the player sees void at edges.
 */

const LEVEL1 = { w: 57, h: 45 }
const bounds = levelWorldBounds(LEVEL1)

describe('clampCameraTarget', () => {
  const view = { halfW: 10, halfZ: 8 }

  it('leaves a target well inside the level untouched', () => {
    const p = clampCameraTarget({ x: 0, z: 0 }, bounds, view)
    expect(p.x).toBeCloseTo(0)
    expect(p.z).toBeCloseTo(0)
  })

  it('clamps past the left edge so no void is visible', () => {
    const p = clampCameraTarget({ x: -9999, z: 0 }, bounds, view)
    expect(p.x).toBeCloseTo(bounds.minX + view.halfW)
  })

  it('clamps past the right edge', () => {
    const p = clampCameraTarget({ x: 9999, z: 0 }, bounds, view)
    expect(p.x).toBeCloseTo(bounds.maxX - view.halfW)
  })

  it('clamps past the near and far edges', () => {
    expect(clampCameraTarget({ x: 0, z: -9999 }, bounds, view).z)
      .toBeCloseTo(bounds.minZ + view.halfZ)
    expect(clampCameraTarget({ x: 0, z: 9999 }, bounds, view).z)
      .toBeCloseTo(bounds.maxZ - view.halfZ)
  })

  it('clamps both axes at once in a corner', () => {
    const p = clampCameraTarget({ x: -9999, z: 9999 }, bounds, view)
    expect(p.x).toBeCloseTo(bounds.minX + view.halfW)
    expect(p.z).toBeCloseTo(bounds.maxZ - view.halfZ)
  })

  it('centres the camera when the level is narrower than the viewport', () => {
    // A viewport wider than the level has no valid pan range — centring is the
    // only sane answer, and must not produce an inverted clamp.
    const small = levelWorldBounds({ w: 3, h: 3 })
    const wide = { halfW: 500, halfZ: 500 }
    const p = clampCameraTarget({ x: 9999, z: -9999 }, small, wide)
    expect(p.x).toBeCloseTo(0)
    expect(p.z).toBeCloseTo(0)
  })

  it('is idempotent — clamping an already-clamped point changes nothing', () => {
    const once = clampCameraTarget({ x: 9999, z: 9999 }, bounds, view)
    const twice = clampCameraTarget(once, bounds, view)
    expect(twice.x).toBeCloseTo(once.x)
    expect(twice.z).toBeCloseTo(once.z)
  })

  it('never returns NaN for a degenerate 1x1 level', () => {
    const tiny = levelWorldBounds({ w: 1, h: 1 })
    const p = clampCameraTarget({ x: 5, z: -5 }, tiny, view)
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.z)).toBe(true)
  })
})

describe('followStep', () => {
  it('moves the camera toward the target', () => {
    const next = followStep({ x: 0, z: 0 }, { x: 10, z: 0 }, 0.25, 1 / 60)
    expect(next.x).toBeGreaterThan(0)
    expect(next.x).toBeLessThan(10)
  })

  it('converges to the target over time and then stays put', () => {
    let p = { x: 0, z: 0 }
    const target = { x: 10, z: -6 }
    for (let i = 0; i < 600; i++) p = followStep(p, target, 8, 1 / 60)
    expect(p.x).toBeCloseTo(target.x, 3)
    expect(p.z).toBeCloseTo(target.z, 3)

    const settled = followStep(p, target, 8, 1 / 60)
    expect(settled.x).toBeCloseTo(target.x, 3)
    expect(settled.z).toBeCloseTo(target.z, 3)
  })

  it('does not overshoot with a large timestep', () => {
    // A frame spike must not fling the camera past the target and oscillate.
    const next = followStep({ x: 0, z: 0 }, { x: 10, z: 0 }, 8, 5)
    expect(next.x).toBeGreaterThanOrEqual(0)
    expect(next.x).toBeLessThanOrEqual(10)
  })

  it('is already at the target when it starts there', () => {
    const next = followStep({ x: 3, z: 4 }, { x: 3, z: 4 }, 8, 1 / 60)
    expect(next.x).toBeCloseTo(3)
    expect(next.z).toBeCloseTo(4)
  })
})

describe('shakeStep', () => {
  it('decays to exactly zero and stays there', () => {
    let s = 1
    for (let i = 0; i < 600; i++) s = shakeStep(s, 1 / 60)
    expect(s).toBe(0)
    expect(shakeStep(s, 1 / 60)).toBe(0)
  })

  it('decreases monotonically', () => {
    let s = 1
    for (let i = 0; i < 30; i++) {
      const next = shakeStep(s, 1 / 60)
      expect(next).toBeLessThanOrEqual(s)
      s = next
    }
  })

  it('never goes negative', () => {
    expect(shakeStep(0.001, 10)).toBe(0)
  })
})

describe('centroid', () => {
  it('averages several points', () => {
    const c = centroid([{ x: 0, z: 0 }, { x: 10, z: 4 }])
    expect(c.x).toBeCloseTo(5)
    expect(c.z).toBeCloseTo(2)
  })

  it('returns the single point when given one', () => {
    const c = centroid([{ x: 3, z: -7 }])
    expect(c.x).toBeCloseTo(3)
    expect(c.z).toBeCloseTo(-7)
  })

  it('returns the origin for an empty list rather than NaN', () => {
    // A wiped squad must not send the camera to NaN and blank the screen.
    const c = centroid([])
    expect(Number.isFinite(c.x)).toBe(true)
    expect(Number.isFinite(c.z)).toBe(true)
  })
})
