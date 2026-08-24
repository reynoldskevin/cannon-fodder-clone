import { describe, expect, it } from 'vitest'
import type { LevelData } from '../../level'
import {
  FLAT_RELIEF,
  TERRAIN_SKIRT_FLOOR,
  levelRelief,
  reliefAllowance,
} from '../relief'
import { TILE_STYLES } from '../terrain-style'

/** A level made of one repeated (tile id, walkable) pair. */
function levelOf(id: number, walkable: boolean, w = 3, h = 2): LevelData {
  return {
    schemaVersion: 2,
    name: 'test',
    size: { w, h },
    terrain: Array.from({ length: h }, () => Array.from({ length: w }, () => id)),
    walkable: Array.from({ length: h }, () => Array.from({ length: w }, () => walkable)),
    spawns: { avatars: [], enemies: [], props: [], chests: [] },
    objectives: [{ type: 'kill_all' }],
  }
}

describe('levelRelief', () => {
  it('reports the tallest tile top in the level', () => {
    const canopy = TILE_STYLES[2]?.blocked.height ?? 0
    expect(levelRelief(levelOf(2, false)).max).toBe(canopy)
  })

  it('takes the maximum over a mixed level, not the last tile seen', () => {
    const level = levelOf(1, true)
    const mixed: LevelData = {
      ...level,
      // One canopy block in a field of walkable grass.
      terrain: [
        [1, 2, 1],
        [1, 1, 1],
      ],
      walkable: [
        [true, false, true],
        [true, true, true],
      ],
    }
    expect(levelRelief(mixed).max).toBe(TILE_STYLES[2]?.blocked.height)
  })

  it('bottoms out at the skirt floor even when every tile sits above it', () => {
    // Water is below grade but nowhere near the skirt floor.
    expect(levelRelief(levelOf(4, true)).min).toBe(TERRAIN_SKIRT_FLOOR)
  })

  it('never reports a max below the ground plane, so a sunken level still frames', () => {
    expect(levelRelief(levelOf(4, true)).max).toBe(0)
  })

  it('treats ragged or missing rows as tile 0 / blocked rather than producing NaN', () => {
    const level = levelOf(1, true)
    const ragged: LevelData = { ...level, terrain: [[1]], walkable: [[true]] }
    const relief = levelRelief(ragged)
    expect(Number.isFinite(relief.min)).toBe(true)
    expect(Number.isFinite(relief.max)).toBe(true)
    // The missing tiles resolve to unknown/blocked, the loudest fallback height.
    expect(relief.max).toBe(TILE_STYLES[0]?.blocked.height)
  })

  it('handles a zero-tile level without inventing geometry', () => {
    const empty = levelOf(1, true, 0, 0)
    expect(levelRelief(empty)).toEqual({ min: TERRAIN_SKIRT_FLOOR, max: 0 })
  })
})

describe('reliefAllowance', () => {
  it('is the deeper of the two overhangs, so both are covered symmetrically', () => {
    expect(reliefAllowance({ min: -1.5, max: 0.95 })).toBe(1.5)
    expect(reliefAllowance({ min: -0.2, max: 3 })).toBe(3)
  })

  it('is zero for flat ground', () => {
    expect(reliefAllowance(FLAT_RELIEF)).toBe(0)
  })

  it('ignores a range that never crosses the plane in the direction it claims', () => {
    // Everything above ground: nothing hangs below, so the below term is 0.
    expect(reliefAllowance({ min: 0.5, max: 0.9 })).toBe(0.9)
    // Everything below ground: nothing rises above.
    expect(reliefAllowance({ min: -0.9, max: -0.5 })).toBe(0.9)
  })

  it('degrades non-finite input to no allowance rather than to NaN', () => {
    expect(reliefAllowance({ min: Number.NaN, max: Number.NaN })).toBe(0)
    expect(reliefAllowance({ min: -Number.NaN, max: 2 })).toBe(2)
  })
})
