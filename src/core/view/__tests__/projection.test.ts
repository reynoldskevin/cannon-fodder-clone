import { describe, it, expect } from 'vitest'
import { tileToWorld, worldToTile, levelWorldBounds, TILE_WORLD_SIZE } from '../projection'

/**
 * Ticket 009 — tile <-> world projection.
 *
 * Engine-free: these are the numbers the renderer draws with, so they are unit
 * tested even though the drawing itself is not. World space is y-up; the terrain
 * lies in the XZ plane and a level is centred on the world origin so the camera
 * rig has a stable pivot regardless of level size.
 */

describe('tileToWorld', () => {
  it('places the centre tile of an odd-sized level near the origin', () => {
    const p = tileToWorld(2, 2, { w: 5, h: 5 })
    expect(p.x).toBeCloseTo(0)
    expect(p.z).toBeCloseTo(0)
  })

  it('returns tile centres, not corners', () => {
    // With a 2x2 level, tile (0,0) sits half a tile from centre on each axis.
    const p = tileToWorld(0, 0, { w: 2, h: 2 })
    expect(Math.abs(p.x)).toBeCloseTo(TILE_WORLD_SIZE / 2)
    expect(Math.abs(p.z)).toBeCloseTo(TILE_WORLD_SIZE / 2)
  })

  it('increases x with tile x, and z with tile y', () => {
    const size = { w: 8, h: 8 }
    const a = tileToWorld(1, 1, size)
    const b = tileToWorld(2, 1, size)
    const c = tileToWorld(1, 2, size)
    expect(b.x).toBeGreaterThan(a.x)
    expect(c.z).toBeGreaterThan(a.z)
    expect(b.z).toBeCloseTo(a.z)
    expect(c.x).toBeCloseTo(a.x)
  })

  it('spaces adjacent tiles exactly one tile apart', () => {
    const size = { w: 8, h: 8 }
    const a = tileToWorld(3, 3, size)
    const b = tileToWorld(4, 3, size)
    expect(b.x - a.x).toBeCloseTo(TILE_WORLD_SIZE)
  })

  it('puts the terrain plane at y = 0', () => {
    expect(tileToWorld(0, 0, { w: 4, h: 4 }).y).toBeCloseTo(0)
  })
})

describe('worldToTile', () => {
  it('round-trips every tile of a level', () => {
    const size = { w: 7, h: 5 }
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        const p = tileToWorld(x, y, size)
        expect(worldToTile(p.x, p.z, size)).toEqual({ x, y })
      }
    }
  })

  it('maps a point anywhere inside a tile to that tile', () => {
    const size = { w: 4, h: 4 }
    const c = tileToWorld(2, 1, size)
    const nudge = TILE_WORLD_SIZE * 0.4
    expect(worldToTile(c.x + nudge, c.z + nudge, size)).toEqual({ x: 2, y: 1 })
    expect(worldToTile(c.x - nudge, c.z - nudge, size)).toEqual({ x: 2, y: 1 })
  })

  it('clamps a point outside the level to the nearest edge tile', () => {
    const size = { w: 4, h: 4 }
    expect(worldToTile(-9999, -9999, size)).toEqual({ x: 0, y: 0 })
    expect(worldToTile(9999, 9999, size)).toEqual({ x: 3, y: 3 })
  })
})

describe('levelWorldBounds', () => {
  it('spans exactly the level extent, centred on the origin', () => {
    const b = levelWorldBounds({ w: 10, h: 6 })
    expect(b.minX).toBeCloseTo(-5 * TILE_WORLD_SIZE)
    expect(b.maxX).toBeCloseTo(5 * TILE_WORLD_SIZE)
    expect(b.minZ).toBeCloseTo(-3 * TILE_WORLD_SIZE)
    expect(b.maxZ).toBeCloseTo(3 * TILE_WORLD_SIZE)
  })

  it('is symmetric about the origin for any size', () => {
    for (const size of [{ w: 1, h: 1 }, { w: 57, h: 45 }, { w: 2, h: 9 }]) {
      const b = levelWorldBounds(size)
      expect(b.minX).toBeCloseTo(-b.maxX)
      expect(b.minZ).toBeCloseTo(-b.maxZ)
    }
  })

  it('contains every tile centre of the real level-1 grid', () => {
    const size = { w: 57, h: 45 }
    const b = levelWorldBounds(size)
    for (const [x, y] of [[0, 0], [56, 44], [29, 39], [42, 6]] as const) {
      const p = tileToWorld(x, y, size)
      expect(p.x).toBeGreaterThanOrEqual(b.minX)
      expect(p.x).toBeLessThanOrEqual(b.maxX)
      expect(p.z).toBeGreaterThanOrEqual(b.minZ)
      expect(p.z).toBeLessThanOrEqual(b.maxZ)
    }
  })
})
