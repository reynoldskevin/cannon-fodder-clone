import { describe, it, expect } from 'vitest'
import { screenBasis, viewGroundExtents, YAW, ELEVATION } from '../orientation'

/**
 * Ticket 009a — camera orientation.
 *
 * The project owner replaced the brief's 45-degree isometric with a SQUARE,
 * axis-aligned view at the high elevation the source art uses. These are the
 * numbers that follow from that choice, kept engine-free like the rest of
 * `src/core/view`.
 *
 * The practical consequence, and the reason this is worth testing: at yaw 0 the
 * visible ground footprint is axis-aligned, so its bounding box is the footprint
 * itself. At 45 degrees the bound is inflated by ~sqrt(2) per axis, which is what
 * forced ticket 009 to loosen its camera clamp and show sky at the level edges.
 */

const deg = (d: number) => (d * Math.PI) / 180

describe('the shipped orientation is square and high', () => {
  it('uses zero yaw, so the tile grid is axis-aligned with the screen', () => {
    expect(YAW).toBe(0)
  })

  it('ships at 55 degrees — the owner-chosen angle (ticket 009b)', () => {
    // Started at 75 in ticket 009a; dropped to 55 after seeing it live. Low
    // enough that extruded terrain still shows a clear side face, high enough
    // to keep reading as the source art's overhead view.
    expect(ELEVATION).toBeCloseTo(deg(55), 6)
  })

  it('is not straight down, which would flatten the raised canopy', () => {
    expect(ELEVATION).toBeLessThan(deg(90))
    expect(ELEVATION).toBeGreaterThan(0)
  })
})

describe('screenBasis', () => {
  it('is axis-aligned at yaw 0', () => {
    const { right, up } = screenBasis(0, deg(75))
    expect(Math.abs(right.x)).toBeCloseTo(1)
    expect(right.z).toBeCloseTo(0)
    expect(up.x).toBeCloseTo(0)
    expect(Math.abs(up.z)).toBeCloseTo(1)
  })

  it('is orthonormal at any yaw', () => {
    for (const yaw of [0, deg(30), deg(45), deg(90), deg(200)]) {
      const { right, up } = screenBasis(yaw, deg(70))
      expect(Math.hypot(right.x, right.z)).toBeCloseTo(1)
      expect(Math.hypot(up.x, up.z)).toBeCloseTo(1)
      expect(right.x * up.x + right.z * up.z).toBeCloseTo(0)
    }
  })

  it('is not axis-aligned at 45 degrees — the orientation this replaced', () => {
    const { right } = screenBasis(deg(45), deg(70))
    expect(Math.abs(right.x)).toBeCloseTo(Math.SQRT1_2)
    expect(Math.abs(right.z)).toBeCloseTo(Math.SQRT1_2)
  })

  it('does not depend on elevation for its ground direction', () => {
    const a = screenBasis(0, deg(60))
    const b = screenBasis(0, deg(85))
    expect(a.right.x).toBeCloseTo(b.right.x)
    expect(a.right.z).toBeCloseTo(b.right.z)
  })
})

describe('viewGroundExtents', () => {
  const aspect = 16 / 9

  it('at yaw 0, width is exactly the viewport half-width — no inflation', () => {
    const e = viewGroundExtents(20, aspect, 0, deg(75))
    expect(e.halfX).toBeCloseTo((20 * aspect) / 2)
  })

  it('at yaw 0, depth is the viewport half-height divided by sin(elevation)', () => {
    const elev = deg(75)
    const e = viewGroundExtents(20, aspect, 0, elev)
    expect(e.halfZ).toBeCloseTo(20 / 2 / Math.sin(elev))
  })

  it('a lower elevation sees more ground depth for the same viewport', () => {
    const shallow = viewGroundExtents(20, aspect, 0, deg(40))
    const steep = viewGroundExtents(20, aspect, 0, deg(85))
    expect(shallow.halfZ).toBeGreaterThan(steep.halfZ)
  })

  it('elevation does not change the width', () => {
    const a = viewGroundExtents(20, aspect, 0, deg(40))
    const b = viewGroundExtents(20, aspect, 0, deg(85))
    expect(a.halfX).toBeCloseTo(b.halfX)
  })

  it('yaw 45 inflates both axes versus yaw 0 — the problem square solves', () => {
    const square = viewGroundExtents(20, aspect, 0, deg(75))
    const iso = viewGroundExtents(20, aspect, deg(45), deg(75))
    expect(iso.halfX).toBeGreaterThan(square.halfX)
    expect(iso.halfZ).toBeGreaterThan(square.halfZ)
  })

  it('never returns NaN or Infinity for a degenerate elevation', () => {
    for (const elev of [0, deg(90), -1, Number.NaN]) {
      const e = viewGroundExtents(20, aspect, 0, elev)
      expect(Number.isFinite(e.halfX)).toBe(true)
      expect(Number.isFinite(e.halfZ)).toBe(true)
      expect(e.halfX).toBeGreaterThan(0)
      expect(e.halfZ).toBeGreaterThan(0)
    }
  })

  it('never returns NaN for a degenerate aspect', () => {
    for (const a of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = viewGroundExtents(20, a, 0, deg(75))
      expect(Number.isFinite(e.halfX)).toBe(true)
      expect(Number.isFinite(e.halfZ)).toBe(true)
    }
  })

  it('scales linearly with viewport height', () => {
    const a = viewGroundExtents(10, aspect, 0, deg(75))
    const b = viewGroundExtents(20, aspect, 0, deg(75))
    expect(b.halfX / a.halfX).toBeCloseTo(2)
    expect(b.halfZ / a.halfZ).toBeCloseTo(2)
  })
})
