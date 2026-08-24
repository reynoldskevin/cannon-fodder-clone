import { describe, expect, it } from 'vitest'
import { screenBasis } from '../orientation'
import type { WorldBounds } from '../projection'
import { FLAT_RELIEF, type ReliefRange } from '../relief'
import { clampViewHeight, coverExtent, fitViewHeight } from '../zoom'

const DEG = Math.PI / 180

/** Level 1's footprint: 57 x 45 tiles, centred on the origin. */
const LEVEL: WorldBounds = { minX: -28.5, maxX: 28.5, minZ: -22.5, maxZ: 22.5 }

const basis = screenBasis(0, 75 * DEG)

/**
 * Highest and lowest point of the level's silhouette, in units of SCREEN height,
 * measured from the camera's look-at point.
 *
 * This is the whole contract of `fitViewHeight` restated independently: a point
 * `dz` deep and `y` high projects `dz * sin(e) + y * cos(e)` up the screen.
 */
function screenReach(
  bounds: WorldBounds,
  relief: ReliefRange,
  elevationRad: number,
): { up: number; down: number } {
  const depth = (bounds.maxZ - bounds.minZ) / 2
  const s = Math.sin(elevationRad)
  const c = Math.cos(elevationRad)
  return { up: depth * s + relief.max * c, down: depth * s - relief.min * c }
}

describe('coverExtent', () => {
  it('is the half-width along a screen-right axis at yaw 0', () => {
    expect(coverExtent(LEVEL, basis.right)).toBeCloseTo(28.5, 10)
  })

  it('is the half-depth along a screen-up axis at yaw 0', () => {
    expect(coverExtent(LEVEL, basis.up)).toBeCloseTo(22.5, 10)
  })

  it('sums both half-extents on a diagonal axis — the corner is what must fit', () => {
    const diagonal = { x: Math.SQRT1_2, z: Math.SQRT1_2 }
    expect(coverExtent(LEVEL, diagonal)).toBeCloseTo((28.5 + 22.5) * Math.SQRT1_2, 10)
  })
})

describe('fitViewHeight', () => {
  it('frames the flat ground rectangle when the level has no relief', () => {
    const height = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1, FLAT_RELIEF)
    expect(height).toBeCloseTo(2 * 22.5 * Math.sin(75 * DEG), 10)
  })

  it('defaults to the flat-ground fit when no relief is supplied', () => {
    const withDefault = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG)
    const flat = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1, FLAT_RELIEF)
    expect(withDefault).toBe(flat)
  })

  it('contains the raised and sunken terrain the flat fit clipped', () => {
    const relief: ReliefRange = { min: -1.5, max: 0.95 }
    for (const elevationDeg of [55, 70, 75, 89]) {
      const elevation = elevationDeg * DEG
      const height = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, elevation, 1, relief)
      const reach = screenReach(LEVEL, relief, elevation)
      // Half the viewport must reach past BOTH ends of the silhouette.
      expect(height / 2).toBeGreaterThanOrEqual(reach.up - 1e-9)
      expect(height / 2).toBeGreaterThanOrEqual(reach.down - 1e-9)
    }
  })

  it('grows the allowance as the camera drops, where the overhang projects further', () => {
    const relief: ReliefRange = { min: -1.5, max: 0.95 }
    const flat55 = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 55 * DEG, 1, FLAT_RELIEF)
    const tall55 = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 55 * DEG, 1, relief)
    const flat89 = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 89 * DEG, 1, FLAT_RELIEF)
    const tall89 = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 89 * DEG, 1, relief)
    expect(tall55 - flat55).toBeGreaterThan(tall89 - flat89)
  })

  it('scales the allowance with the terrain that is actually there', () => {
    const short = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1, {
      min: 0,
      max: 1,
    })
    const tall = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1, {
      min: 0,
      max: 4,
    })
    expect(tall - short).toBeCloseTo(2 * 3 * Math.cos(75 * DEG), 10)
  })

  it('leaves the across-screen constraint alone: height does not project sideways', () => {
    // A tall, narrow window makes width the binding constraint; relief must not
    // change the answer there.
    const aspect = 0.5
    const flat = fitViewHeight(LEVEL, basis.right, basis.up, aspect, 75 * DEG, 1, FLAT_RELIEF)
    const tall = fitViewHeight(LEVEL, basis.right, basis.up, aspect, 75 * DEG, 1, {
      min: -1.5,
      max: 0.95,
    })
    expect(tall).toBe(flat)
    expect(flat).toBeCloseTo((2 * 28.5) / aspect, 10)
  })

  it('applies the margin to the relief-aware height, not just to the footprint', () => {
    const relief: ReliefRange = { min: -1.5, max: 0.95 }
    const plain = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1, relief)
    const margined = fitViewHeight(LEVEL, basis.right, basis.up, 2.0659, 75 * DEG, 1.06, relief)
    expect(margined).toBeCloseTo(plain * 1.06, 10)
  })

  it('falls back to a square aspect rather than dividing by garbage', () => {
    const bad = fitViewHeight(LEVEL, basis.right, basis.up, 0, 75 * DEG, 1, FLAT_RELIEF)
    const square = fitViewHeight(LEVEL, basis.right, basis.up, 1, 75 * DEG, 1, FLAT_RELIEF)
    expect(bad).toBe(square)
  })
})

describe('clampViewHeight', () => {
  it('keeps a value inside the range', () => {
    expect(clampViewHeight(20, 10, 40)).toBe(20)
    expect(clampViewHeight(5, 10, 40)).toBe(10)
    expect(clampViewHeight(90, 10, 40)).toBe(40)
  })

  it('degrades an inverted range to the closest allowed zoom', () => {
    expect(clampViewHeight(30, 10, 4)).toBe(10)
  })

  it('returns the minimum for a non-finite request', () => {
    expect(clampViewHeight(Number.NaN, 10, 40)).toBe(10)
  })
})
