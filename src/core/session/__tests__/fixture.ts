/**
 * Shared fixtures for the ticket 008a session tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 */

import type { LevelData, SpawnPoint } from '../../level/types'

export interface SessionFixtureOptions {
  readonly w?: number
  readonly h?: number
  readonly avatars?: readonly { x: number; y: number }[]
  readonly enemies?: readonly { x: number; y: number }[]
  readonly props?: readonly SpawnPoint[]
  /** Blocked tiles as `"x,y"`. */
  readonly blocked?: ReadonlySet<string>
}

/**
 * A valid level with everything walkable unless `blocked` says otherwise.
 *
 * Deliberately its own copy rather than `world/__tests__/fixture`'s: this one
 * needs prop annotations, which that one hardcodes to empty, and a fixture that
 * grows options for every consumer ends up describing none of them.
 */
export function makeLevel(options: SessionFixtureOptions = {}): LevelData {
  const w = options.w ?? 20
  const h = options.h ?? 15
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
    name: 'session-fixture',
    size: { w, h },
    terrain,
    walkable,
    walkableSource: 'mask',
    spawns: {
      avatars: (options.avatars ?? [{ x: 2, y: 7 }, { x: 3, y: 7 }]).map((p) => ({
        x: p.x,
        y: p.y,
        type: 'rifleman',
      })),
      enemies: (options.enemies ?? [{ x: 16, y: 7 }]).map((p) => ({
        x: p.x,
        y: p.y,
        type: 'rifleman',
      })),
      props: options.props ?? [],
      chests: [],
    },
    objectives: [{ type: 'kill_all' }],
  }
}

/** Flat ground, so position assertions are about the sim and not the terrain. */
export const FLAT = (): number => 0
