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
/**
 * Canopy stands FLAT on the ground, level with grass, and is tinted only just
 * deeper than it.
 *
 * THE SQUARES. Canopy used to be extruded (0.3 walkable, 0.5 fringe, rising to
 * 0.9 inside) and tinted far darker than grass (`#2f5427` against `#6f9f4f`).
 * Both were ticket 010a's decisions and both are reversed here, because
 * together they drew a hard-edged rectangle on the ground under every tree.
 *
 * THE COLOUR WAS THE BIGGER HALF, which is not obvious and cost a wrong fix to
 * find out. `TerrainRenderer` multiplies one tileable jungle texture by a
 * per-tile vertex colour (`TINT_HUE_STRENGTH`), and that tint is CONSTANT
 * across a tile — so any two neighbouring tiles with different tints meet at a
 * hard, axis-aligned edge. A canopy tint that dark against grass drew a black
 * rectangle wherever no tree sprite happened to cover it. Flattening the
 * geometry alone changed nothing about that; the squares were still there,
 * merely lying down.
 *
 * THE HEIGHT WAS THE SMALLER HALF, and real. One tree is planted per FRINGE
 * canopy tile — any canopy tile with a non-canopy neighbour — so a lone tree in
 * open grass is fringe on all four sides and stood on a one-tile block with
 * nothing beside it to hide the block's walls: a tree on a pedestal.
 *
 * Level with `grass` walkable rather than 0, so canopy and grass form one
 * continuous floor: any difference at all puts a step at every boundary, which
 * relocates the artefact rather than removing it. The tints are still distinct
 * enough to read as deeper ground, and far too close to draw an edge.
 *
 * WHAT NOW CARRIES THE FOREST: the tree sprites, entirely. If the treeless
 * interior of a mass ever reads as a bald patch — which is what 010a predicted
 * and why it raised the terrain — the fix is to plant scenery on interior tiles,
 * not to re-extrude or re-darken the ground under the trees.
 *
 * NOTE FOR LATER: this makes blocked canopy nearly indistinguishable from grass
 * where no tree stands on it. In practice the trees overlap enough to read as
 * solid, and `?debug=1` layer 1 draws the real nav grid. If it becomes a
 * problem, the answer is more scenery, not more tint.
 */
const CANOPY_HEIGHT = 0.05

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
    walkable: { colour: '#679649', height: CANOPY_HEIGHT },
    blocked: { colour: '#5d8c43', height: CANOPY_HEIGHT },
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

export const CANOPY_INTERIOR_COLOUR = '#5a8842'


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
