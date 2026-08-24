/**
 * Terrain ids and walkability, derived per tile from the map image.
 *
 * Both are heuristics over a tile's *average* colour — deliberately simple and
 * deliberately coarse. `TileId` is an open enum on the game side, so this
 * classification can grow (buildings, roads, ...) without a schema break, and a
 * hand-painted `walkable.png` mask always outranks the guess.
 *
 * The averages are taken over the map *underneath* the annotations: annotation
 * ink is drawn on top of the terrain it describes, and letting it into the mean
 * makes the map disagree with itself. Measured on the real asset, a white
 * crosshair lifts a tile from luma 21.5 to 50.0 against a cut of 55 — one more
 * pixel of ink and a blocked tile would have become walkable *because* someone
 * annotated it.
 */

import type { Image, RGB } from './image'
import { luminance, pixelAt } from './image'

/**
 * Tile ids emitted by this importer. Small, open set — the renderer maps the
 * ids it knows and falls back for the rest.
 */
export const TILE = {
  /** Anything the heuristic cannot place. */
  UNKNOWN: 0,
  /** Light green: grass, clearings, walkable ground cover. */
  GRASS: 1,
  /** Dark green: dense canopy / undergrowth. Blocks movement. */
  CANOPY: 2,
  /** Warm or neutral: dirt, rock, path. */
  ROCK: 3,
  /** Blue-dominant: water. */
  WATER: 4,
} as const

/**
 * Above this fraction of a tile covered by annotation ink, the handful of
 * surviving pixels are not a sample of the terrain — they are the few specks the
 * paint missed, and averaging them states a tile's terrain with total confidence
 * on the strength of two pixels. Such a tile is left unmeasured and takes a
 * neighbour's colour instead.
 *
 * At `tileSize` 16 (256 px) this leaves at least 102 pixels behind every measured
 * average. Guarding only the exactly-100% case, as this once did, let a 99%-ink
 * tile publish that noise as terrain.
 */
export const MAX_INK_FRACTION = 0.6

/** A tile position in the tile grid, not in pixels. */
export interface TileCoord {
  readonly x: number
  readonly y: number
}

/**
 * Per-tile mean colours, plus the record of which of them were not actually
 * measured.
 *
 * A tile that took a neighbour's colour is a guess about terrain AND about
 * walkability, and a guess that nobody is told about is indistinguishable from a
 * measurement. So the substitution is reported, not merely performed.
 */
export interface TileAverageResult {
  readonly averages: RGB[][]
  /**
   * Tiles over `MAX_INK_FRACTION` whose colour was copied from the nearest
   * measured tile, in raster order.
   */
  readonly neighbourFilled: readonly TileCoord[]
  /**
   * True in the degenerate case where NO tile was measurable, so there was no
   * neighbour to borrow from and every average includes annotation ink.
   */
  readonly allInk: boolean
}

/**
 * Mean colour of one tile, skipping pixels flagged as annotation ink.
 *
 * `undefined` when too little of the tile survives the mask to be a meaningful
 * sample of terrain — see `MAX_INK_FRACTION`.
 */
function tileAverage(
  image: Image,
  tx: number,
  ty: number,
  tileSize: number,
  inkMask: Uint8Array | undefined,
): RGB | undefined {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = ty * tileSize; y < (ty + 1) * tileSize; y += 1) {
    for (let x = tx * tileSize; x < (tx + 1) * tileSize; x += 1) {
      if (inkMask && inkMask[y * image.width + x] === 1) continue
      const c = pixelAt(image, x, y)
      r += c[0]
      g += c[1]
      b += c[2]
      n += 1
    }
  }
  // Mostly (or entirely) annotation: this tile has no usable terrain of its own.
  if (n <= tileSize * tileSize * (1 - MAX_INK_FRACTION)) return undefined
  return [r / n, g / n, b / n]
}

/**
 * Per-tile mean colours, ink excluded.
 *
 * A tile buried under ink (see `MAX_INK_FRACTION`) has no terrain left worth
 * measuring, so it takes the nearest measured tile's colour rather than the
 * colour of the annotation, or of the two stray pixels beside it — a guess, but
 * a guess about terrain instead of a confident statement about paint. Filling is
 * breadth-first from every measured tile at once in raster order, so it is a
 * deterministic function of the image.
 */
export function tileAverages(
  image: Image,
  tileSize: number,
  w: number,
  h: number,
  inkMask?: Uint8Array,
): TileAverageResult {
  const grid: (RGB | undefined)[][] = []
  const queue: number[] = []
  const unmeasured: TileCoord[] = []
  for (let ty = 0; ty < h; ty += 1) {
    const row: (RGB | undefined)[] = []
    for (let tx = 0; tx < w; tx += 1) {
      const avg = tileAverage(image, tx, ty, tileSize, inkMask)
      row.push(avg)
      if (avg !== undefined) queue.push(ty * w + tx)
      else unmeasured.push({ x: tx, y: ty })
    }
    grid.push(row)
  }

  // Degenerate but possible: no tile is measurable. Fall back to the raw averages,
  // which at least describe the image, rather than emitting nothing. Nothing was
  // neighbour-filled here — there was no measured neighbour anywhere to fill from.
  if (queue.length === 0) {
    return {
      averages: grid.map((row, ty) =>
        row.map((_, tx) => tileAverage(image, tx, ty, tileSize, undefined) ?? [0, 0, 0]),
      ),
      neighbourFilled: [],
      allInk: unmeasured.length > 0,
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head] ?? 0
    const tx = index % w
    const ty = (index - tx) / w
    const source = grid[ty]?.[tx]
    if (source === undefined) continue
    const neighbours: readonly [number, number][] = [
      [tx - 1, ty],
      [tx + 1, ty],
      [tx, ty - 1],
      [tx, ty + 1],
    ]
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const row = grid[ny]
      if (!row || row[nx] !== undefined) continue
      row[nx] = source
      queue.push(ny * w + nx)
    }
  }

  return {
    averages: grid.map((row) => row.map((c) => c ?? [0, 0, 0])),
    neighbourFilled: unmeasured,
    allInk: false,
  }
}

export function classifyTile(colour: RGB, walkableMinLuminance: number): number {
  const [r, g, b] = colour
  if (Math.max(r, g, b) < 12) return TILE.UNKNOWN // effectively black: no information
  if (b > r && b > g) return TILE.WATER
  if (g >= r) return luminance(colour) >= walkableMinLuminance ? TILE.GRASS : TILE.CANOPY
  return TILE.ROCK
}

export function buildTerrain(
  averages: readonly (readonly RGB[])[],
  walkableMinLuminance: number,
): number[][] {
  return averages.map((row) => row.map((c) => classifyTile(c, walkableMinLuminance)))
}

/** Heuristic passability: bright enough to be open ground. */
export function buildWalkable(
  averages: readonly (readonly RGB[])[],
  walkableMinLuminance: number,
): boolean[][] {
  return averages.map((row) => row.map((c) => luminance(c) >= walkableMinLuminance))
}

/** Mask override: black = blocked, white = walkable, decided per tile average. */
export function walkableFromMask(mask: Image, tileSize: number, w: number, h: number): boolean[][] {
  // The mask is authored art in its own right — every pixel of it is meaningful,
  // so nothing is excluded from these averages.
  const { averages } = tileAverages(mask, tileSize, w, h)
  return averages.map((row) => row.map((c) => luminance(c) >= 128))
}
