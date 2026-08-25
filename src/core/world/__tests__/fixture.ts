/**
 * Shared `LevelData` fixtures for the ticket 005 world tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not try to run it as a
 * suite. Kept separate from the individual test files because both `world` and
 * `determinism` need the same small level and a divergence between the two
 * copies would make a determinism failure very hard to read.
 */

import type { LevelData } from '../../level/types'

export interface FixtureOptions {
  readonly w?: number
  readonly h?: number
  readonly avatars?: readonly { x: number; y: number }[]
  readonly enemies?: readonly { x: number; y: number }[]
  /** Tiles that are NOT walkable, as `"x,y"` keys. */
  readonly blocked?: ReadonlySet<string>
}

/** A small, fully valid level with everything walkable unless `blocked` says otherwise. */
export function makeLevel(options: FixtureOptions = {}): LevelData {
  const w = options.w ?? 16
  const h = options.h ?? 16
  const blocked = options.blocked ?? new Set<string>()
  const terrain: number[][] = []
  const walkable: boolean[][] = []
  for (let y = 0; y < h; y++) {
    const trow: number[] = []
    const wrow: boolean[] = []
    for (let x = 0; x < w; x++) {
      const isBlocked = blocked.has(`${x},${y}`)
      trow.push(isBlocked ? 2 : 1)
      wrow.push(!isBlocked)
    }
    terrain.push(trow)
    walkable.push(wrow)
  }
  return {
    schemaVersion: 2,
    name: 'fixture',
    size: { w, h },
    terrain,
    walkable,
    walkableSource: 'mask',
    spawns: {
      avatars: (options.avatars ?? [{ x: 2, y: 2 }, { x: 3, y: 2 }]).map((p) => ({
        x: p.x,
        y: p.y,
        type: 'rifleman',
      })),
      enemies: (options.enemies ?? [{ x: 12, y: 12 }]).map((p) => ({
        x: p.x,
        y: p.y,
        type: 'rifleman',
      })),
      props: [],
      chests: [],
    },
    objectives: [{ type: 'kill_all' }],
  }
}
