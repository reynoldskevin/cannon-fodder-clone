/**
 * Shared fixtures for the ticket 008a session tests.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 */

import type { LevelData, LevelObjective, SpawnPoint } from '../../level/types'

export interface SessionFixtureOptions {
  readonly w?: number
  readonly h?: number
  readonly avatars?: readonly { x: number; y: number }[]
  /**
   * `facing` is passed straight through to `SpawnPoint.facing` (ticket 038).
   *
   * Every fixture in this directory lays its two sides out EAST-WEST, which was
   * a readability choice back when sight was a disc. Against the shipped
   * southward default that is 90 degrees off the arc, so a suite about anything
   * other than vision has to say which way its garrison is looking — and saying
   * it through the authored field, rather than through a test-only hook, means
   * these suites exercise the same path a real level would.
   */
  readonly enemies?: readonly { x: number; y: number; facing?: string }[]
  readonly props?: readonly SpawnPoint[]
  /** Blocked tiles as `"x,y"`. */
  readonly blocked?: ReadonlySet<string>
  /**
   * The mission's win conditions. Defaults to `kill_all`, which is what level 1
   * carries and what every test written before ticket 013 assumed.
   */
  readonly objectives?: readonly LevelObjective[]
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
        ...(p.facing === undefined ? {} : { facing: p.facing }),
      })),
      props: options.props ?? [],
      chests: [],
    },
    objectives: options.objectives ?? [{ type: 'kill_all' }],
  }
}

/** Flat ground, so position assertions are about the sim and not the terrain. */
export const FLAT = (): number => 0
