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
    // UNDERGROWTH AT THE FRINGE, NOT A WALL (ticket 010a). Blocked canopy used
    // to stand 0.95 proud, because until 010a it was the only thing
    // representing the jungle and had to carry its whole visual weight alone.
    // Where a tree stands it no longer does: at 0.95 the two read as a trunk
    // sprouting from the top of a chest-high green wall, which is exactly as odd
    // as it sounds along the fringe where the block's south face is visible. 0.5
    // reads as the undergrowth and leaf litter the trunks are rooted in — still
    // unmistakably raised (ten times walkable grass, and above blocked scrub at
    // 0.45, so the passability hierarchy is intact and unchanged).
    //
    // This is the FRINGE height. Interior canopy, which since the 010a revision
    // has no tree on it at all, rises above it — see `canopyMassHeight`.
    blocked: { colour: '#2f5427', height: 0.5 },
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
 * Top-surface height of blocked canopy by `canopyDepth` — 0 fringe, 1 one ring
 * in, 2 deeper.
 *
 * WHY THE INTERIOR RISES (ticket 010a revision). Trees are now planted on the
 * fringe only, so an interior tile has nothing standing on it and has to read as
 * solid canopy on its own; at the fringe's 0.5 it reads instead as a bald patch
 * of undergrowth ringed by trees. The mass therefore rises toward its middle,
 * with the 1.8-unit trees fringing it — the silhouette the source map draws.
 *
 * WHY THREE STEPS AND NOT TWO. Jumping straight from 0.5 to 0.9 at the
 * fringe/interior seam emits a 0.4-unit skirt right behind every tree, a lit
 * green wall visible the whole length of the forest edge. One intermediate ring
 * at 0.72 turns that cliff into a chamfer: two shallow steps, each mostly hidden
 * by the trunks in front of it, and from the isometric angle the mass reads as a
 * rounded crown rather than a plateau. It stops at 0.9 rather than climbing
 * further because above about one world unit the canopy starts occluding
 * soldiers walking the clearings beyond it.
 */
export const CANOPY_MASS_HEIGHTS: readonly number[] = [0.5, 0.72, 0.9]

/**
 * Interior canopy tops are lifted toward the light: the fringe colour is the
 * shaded flank of the mass, and a flat field of it over the interior looks like
 * a hole rather than a crown. Same hue family, one step brighter.
 */
export const CANOPY_INTERIOR_COLOUR = '#366029'

/** Blocked-canopy height for a tile at `depth` rings inside its mass. */
export function canopyMassHeight(depth: number): number {
  const step = Math.min(Math.max(Math.trunc(depth), 0), CANOPY_MASS_HEIGHTS.length - 1)
  return CANOPY_MASS_HEIGHTS[step] ?? CANOPY_MASS_HEIGHTS[0] ?? 0
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
