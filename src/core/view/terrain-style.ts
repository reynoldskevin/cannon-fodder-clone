/**
 * Terrain appearance (ticket 009): tile id + passability -> colour and height.
 *
 * Engine-free: the renderer bakes these numbers into one merged geometry's
 * vertex colours and heights, so the *choice* is testable without a WebGL
 * context.
 *
 * Tile ids are an OPEN enum (ARCHITECTURE.md extension points — buildings and
 * roads may be added by `tools/mapgen` without a schema break), so an id this
 * build has never heard of must degrade to something loudly visible rather than
 * throwing or rendering as an invisible hole in the map.
 */

/** Colour + world-space height for one (tile id, passability) combination. */
export interface TileAppearance {
  /** `#rrggbb`. */
  readonly colour: string
  /** Top-surface height in world units. May be negative (water sits below grade). */
  readonly height: number
}

/** Both faces of a tile id: how it looks when you can walk it, and when you cannot. */
export interface TileStyle {
  readonly name: string
  readonly walkable: TileAppearance
  readonly blocked: TileAppearance
}

/** What `tileStyle` returns: the chosen appearance plus whether it was a fallback. */
export interface ResolvedTileStyle extends TileAppearance {
  /** True when the id had no declared style — the tile renders in the alert colour. */
  readonly isFallback: boolean
}

/**
 * Styles for the ids `tools/mapgen` currently emits (see `tools/mapgen/terrain.ts`:
 * 0 unknown, 1 grass, 2 canopy, 3 rock, 4 water).
 *
 * Invariant across every entry: a *blocked* tile is never lower than its
 * walkable form. Raised blocked terrain is the whole reason the map reads as
 * cover and obstacles at an isometric angle rather than as a flat colour chart.
 */
export const TILE_STYLES: Readonly<Record<number, TileStyle>> = {
  0: {
    name: 'unknown',
    walkable: { colour: '#7d7a63', height: 0.06 },
    blocked: { colour: '#57543f', height: 0.55 },
  },
  1: {
    name: 'grass',
    walkable: { colour: '#6f9f4f', height: 0.05 },
    // Blocked grass is scrub/hedge: same family, darker and raised.
    blocked: { colour: '#4d7536', height: 0.45 },
  },
  2: {
    name: 'canopy',
    walkable: { colour: '#4a7a3a', height: 0.3 },
    blocked: { colour: '#2f5427', height: 0.95 },
  },
  3: {
    name: 'rock',
    walkable: { colour: '#9c8f74', height: 0.08 },
    blocked: { colour: '#6d6350', height: 0.7 },
  },
  4: {
    name: 'water',
    // Water is below grade, and blocked water is the same surface — only the
    // colour tells you it is impassable, because a raised lake reads as a wall.
    walkable: { colour: '#4d86b5', height: -0.12 },
    blocked: { colour: '#2f5c88', height: -0.12 },
  },
}

/**
 * The style used for an id with no entry above. Deliberately alarming magenta:
 * an unstyled tile should be obvious on screen the moment mapgen emits a new id,
 * not blend quietly into the terrain.
 */
export const FALLBACK_TILE_STYLE: TileStyle = {
  name: 'fallback',
  walkable: { colour: '#ff00ff', height: 0.1 },
  blocked: { colour: '#c000c0', height: 0.6 },
}

/** Resolve a tile id + passability to the appearance the renderer should bake. */
export function tileStyle(id: number, walkable: boolean): ResolvedTileStyle {
  const style = Number.isInteger(id) ? TILE_STYLES[id] : undefined
  const resolved = style ?? FALLBACK_TILE_STYLE
  const appearance = walkable ? resolved.walkable : resolved.blocked
  return { colour: appearance.colour, height: appearance.height, isFallback: style === undefined }
}
