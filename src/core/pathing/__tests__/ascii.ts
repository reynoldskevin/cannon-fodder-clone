/**
 * ASCII grid fixtures for the ticket 006 pathing tests.
 *
 * `ARCHITECTURE.md` (Hard problem 3) picked flow fields over A* partly because
 * "no fixtures beyond a small ASCII grid" — a field is asserted by inspection in
 * a way a path never is. This module is that promise made good: every pathing
 * fixture is a picture of the map it tests, so a failure is read rather than
 * decoded.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not run it as a suite.
 */

import type { LevelData } from '../../level/types'

/** `#` is blocked, anything else is walkable. */
export function parseAscii(art: string): { w: number; h: number; rows: string[] } {
  const rows = art
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const w = rows[0]?.length ?? 0
  if (rows.some((r) => r.length !== w)) {
    throw new Error('ascii fixture rows must all be the same width')
  }
  return { w, h: rows.length, rows }
}

/**
 * A valid `LevelData` whose walkability is the ASCII picture.
 *
 * `#` is blocked canopy; `~` is WATER — walkable, and carrying the terrain id
 * that ticket 003a gave a traversal rule and 007b gave a speed and a fire ban.
 * Everything else is grass.
 *
 * ADDITIVE BY CONSTRUCTION: art that uses neither character is classified
 * exactly as it was before `~` existed, so no fixture written against this
 * helper can have moved.
 */
export function asciiLevel(art: string): LevelData {
  const { w, h, rows } = parseAscii(art)
  const terrain: number[][] = []
  const walkable: boolean[][] = []
  for (let y = 0; y < h; y++) {
    const row = rows[y]!
    const trow: number[] = []
    const wrow: boolean[] = []
    for (let x = 0; x < w; x++) {
      const cell = row[x]
      const blocked = cell === '#'
      const water = cell === '~'
      trow.push(blocked ? 2 : water ? 4 : 1)
      // Water is passable — that is ticket 003a's whole point — so only `#`
      // blocks. A `~` that came out unwalkable here would make every swimming
      // fixture below assert against a wall.
      wrow.push(!blocked)
    }
    terrain.push(trow)
    walkable.push(wrow)
  }
  return {
    schemaVersion: 2,
    name: 'ascii',
    size: { w, h },
    terrain,
    walkable,
    walkableSource: 'mask',
    spawns: { avatars: [], enemies: [], props: [], chests: [] },
    objectives: [{ type: 'kill_all' }],
  }
}

/** Find the single cell holding `marker`, for readable target coordinates. */
export function findMarker(art: string, marker: string): { x: number; y: number } {
  const { rows } = parseAscii(art)
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y]!.indexOf(marker)
    if (x >= 0) return { x, y }
  }
  throw new Error(`marker ${marker} not found in fixture`)
}
