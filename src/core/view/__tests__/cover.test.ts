import { describe, it, expect } from 'vitest'
import { maxSkyFreeViewHeight } from '../cover'
import { fitViewHeight } from '../zoom'
import { levelWorldBounds } from '../projection'
import { screenBasis, YAW } from '../orientation'

/**
 * Ticket 009b — the sky-free zoom cap.
 *
 * The owner's rule is absolute: the background must NEVER be visible. So
 * zoom-out stops at the largest viewport whose ground footprint still lies
 * entirely INSIDE the level, rather than at the fit height that frames the whole
 * level (and therefore necessarily shows background around it).
 *
 * The consequence is deliberate and accepted: the whole map can no longer be
 * seen at once.
 */

const deg = (d: number) => (d * Math.PI) / 180
const LEVEL1 = levelWorldBounds({ w: 57, h: 45 })
const FLAT = { min: 0, max: 0 }

describe('the cap keeps the footprint inside the level', () => {
  it('never exceeds the level width across the screen', () => {
    const aspect = 16 / 9
    const vh = maxSkyFreeViewHeight(LEVEL1, aspect, deg(55), FLAT)
    const halfX = (vh * aspect) / 2
    expect(halfX).toBeLessThanOrEqual((LEVEL1.maxX - LEVEL1.minX) / 2 + 1e-9)
  })

  it('never exceeds the level depth into the screen', () => {
    const elev = deg(55)
    const vh = maxSkyFreeViewHeight(LEVEL1, 16 / 9, elev, FLAT)
    const halfZ = vh / 2 / Math.sin(elev)
    expect(halfZ).toBeLessThanOrEqual((LEVEL1.maxZ - LEVEL1.minZ) / 2 + 1e-9)
  })

  it('is bound by whichever axis runs out first', () => {
    // A wide screen over a wide level: width binds. A tall screen: depth binds.
    const wide = maxSkyFreeViewHeight(LEVEL1, 21 / 9, deg(55), FLAT)
    const tall = maxSkyFreeViewHeight(LEVEL1, 9 / 16, deg(55), FLAT)
    expect(wide).toBeLessThan(tall)
  })

  it('is always at or below the fit height — it can only be more conservative', () => {
    const { right, up } = screenBasis(YAW, deg(55))
    for (const aspect of [21 / 9, 16 / 9, 1, 9 / 16]) {
      const cap = maxSkyFreeViewHeight(LEVEL1, aspect, deg(55), FLAT)
      const fit = fitViewHeight(LEVEL1, right, up, aspect, deg(55))
      expect(cap).toBeLessThanOrEqual(fit + 1e-9)
    }
  })
})

describe('relief tightens the cap', () => {
  it('shrinks the cap when terrain is raised', () => {
    const flat = maxSkyFreeViewHeight(LEVEL1, 16 / 9, deg(55), FLAT)
    const hilly = maxSkyFreeViewHeight(LEVEL1, 16 / 9, deg(55), { min: -1.5, max: 3 })
    expect(hilly).toBeLessThan(flat)
  })

  it('shrinks further as terrain gets taller', () => {
    const low = maxSkyFreeViewHeight(LEVEL1, 16 / 9, deg(55), { min: 0, max: 1 })
    const high = maxSkyFreeViewHeight(LEVEL1, 16 / 9, deg(55), { min: 0, max: 6 })
    expect(high).toBeLessThan(low)
  })
})

describe('elevation affects the cap', () => {
  it('a lower elevation sees more ground depth, so the cap tightens', () => {
    const steep = maxSkyFreeViewHeight(LEVEL1, 9 / 16, deg(85), FLAT)
    const shallow = maxSkyFreeViewHeight(LEVEL1, 9 / 16, deg(35), FLAT)
    expect(shallow).toBeLessThan(steep)
  })
})

describe('degenerate inputs never produce an unusable cap', () => {
  it('stays positive and finite for bad aspects', () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const vh = maxSkyFreeViewHeight(LEVEL1, aspect, deg(55), FLAT)
      expect(Number.isFinite(vh)).toBe(true)
      expect(vh).toBeGreaterThan(0)
    }
  })

  it('stays positive and finite for bad elevations', () => {
    for (const elev of [0, deg(90), -1, Number.NaN]) {
      const vh = maxSkyFreeViewHeight(LEVEL1, 16 / 9, elev, FLAT)
      expect(Number.isFinite(vh)).toBe(true)
      expect(vh).toBeGreaterThan(0)
    }
  })

  it('stays positive for relief taller than the level itself', () => {
    const vh = maxSkyFreeViewHeight(LEVEL1, 16 / 9, deg(55), { min: -100, max: 100 })
    expect(Number.isFinite(vh)).toBe(true)
    expect(vh).toBeGreaterThan(0)
  })

  it('stays positive for a one-tile level', () => {
    const tiny = levelWorldBounds({ w: 1, h: 1 })
    const vh = maxSkyFreeViewHeight(tiny, 16 / 9, deg(55), FLAT)
    expect(Number.isFinite(vh)).toBe(true)
    expect(vh).toBeGreaterThan(0)
  })
})
