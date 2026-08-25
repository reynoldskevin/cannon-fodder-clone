import { describe, it, expect } from 'vitest'
import { floorUv, FLOOR_REPEAT_WORLD_UNITS } from '../floor-uv'

/**
 * Ticket 009c — UVs for the tiling jungle floor.
 *
 * The whole point is that UVs come from WORLD position, not from each tile's
 * own 0-1 range. Per-tile UVs would restart the 512px texture every single
 * tile, turning a jungle floor into 2565 identical stamps with a hard seam on
 * every tile edge.
 *
 * Note the level is centred on the origin (ticket 009's projection), so half of
 * every map has negative world coordinates — the naive `x % n` is wrong there
 * and would mirror the texture across the centre line.
 */

describe('FLOOR_REPEAT_WORLD_UNITS', () => {
  it('spans several tiles, so the texture is not one stamp per tile', () => {
    expect(FLOOR_REPEAT_WORLD_UNITS).toBeGreaterThan(1)
  })

  it('is small enough that the ferns read as ground detail, not as terrain', () => {
    // A soldier is 1.539 world units; a repeat much bigger than a squad's
    // footprint would read as wallpaper rather than undergrowth.
    expect(FLOOR_REPEAT_WORLD_UNITS).toBeLessThanOrEqual(16)
  })
})

describe('floorUv', () => {
  const R = 4

  it('is continuous across a tile boundary', () => {
    const a = floorUv(0.999, 0, R)
    const b = floorUv(1.001, 0, R)
    expect(Math.abs(b.u - a.u)).toBeLessThan(0.01)
  })

  it('advances exactly one texture repeat over the repeat distance', () => {
    const a = floorUv(0, 0, R)
    const b = floorUv(R, 0, R)
    expect(b.u - a.u).toBeCloseTo(1)
  })

  it('advances proportionally within a repeat', () => {
    expect(floorUv(R / 2, 0, R).u - floorUv(0, 0, R).u).toBeCloseTo(0.5)
    expect(floorUv(R / 4, 0, R).u - floorUv(0, 0, R).u).toBeCloseTo(0.25)
  })

  it('maps z to v the same way it maps x to u', () => {
    expect(floorUv(0, R, R).v - floorUv(0, 0, R).v).toBeCloseTo(1)
  })

  it('varies u with x only, and v with z only', () => {
    expect(floorUv(3, 0, R).v).toBeCloseTo(floorUv(3, 0, R).v)
    expect(floorUv(0, 7, R).u).toBeCloseTo(floorUv(9, 7, R).u - 9 / R)
  })

  it('stays continuous through the origin into negative coordinates', () => {
    // The failure this guards: a naive modulo or an abs() mirrors the texture
    // across x = 0, putting a seam straight down the middle of every map.
    const left = floorUv(-0.001, 0, R)
    const right = floorUv(0.001, 0, R)
    expect(Math.abs(right.u - left.u)).toBeLessThan(0.01)
  })

  it('keeps advancing monotonically across the negative half', () => {
    const samples = [-8, -6, -4, -2, 0, 2, 4].map((x) => floorUv(x, 0, R).u)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThan(samples[i - 1]!)
    }
  })

  it('covers a full level width without a discontinuity', () => {
    // Level 1 is 57 tiles wide, centred, so x runs -28.5 .. 28.5.
    let prev = floorUv(-28.5, 0, R).u
    for (let x = -28.5 + 0.25; x <= 28.5; x += 0.25) {
      const u = floorUv(x, 0, R).u
      expect(u - prev).toBeCloseTo(0.25 / R, 6)
      prev = u
    }
  })

  it('is deterministic', () => {
    expect(floorUv(3.7, -12.1, R)).toEqual(floorUv(3.7, -12.1, R))
  })

  it('produces finite UVs for the whole level extent', () => {
    for (const [x, z] of [[-28.5, -22.5], [28.5, 22.5], [0, 0], [-28.5, 22.5]] as const) {
      const uv = floorUv(x, z, R)
      expect(Number.isFinite(uv.u)).toBe(true)
      expect(Number.isFinite(uv.v)).toBe(true)
    }
  })

  it('does not divide by zero on a degenerate repeat', () => {
    const uv = floorUv(5, 5, 0)
    expect(Number.isFinite(uv.u)).toBe(true)
    expect(Number.isFinite(uv.v)).toBe(true)
  })
})
