/**
 * Scenery derived from the terrain itself (ticket 010a).
 *
 * WHERE THE TREE ART ACTUALLY BELONGS. The source map for level 1 draws dense
 * jungle; `tools/mapgen` turned that jungle into 1,000 blocked tiles of terrain
 * id 2, "canopy". Ticket 010 hung `tree1/2/3` on the level's single `tree`
 * annotation instead — one palm on a map whose whole eastern half is forest —
 * and left the actual forest as extruded green blocks. This module is the
 * correction: the canopy tiles ARE the trees.
 *
 * Engine-free, like everything else in `core/`. It answers "what scenery does
 * this level have and where", in tile coordinates; turning that into world
 * positions and instanced quads is `src/render/scenery-entities.ts`'s job.
 *
 * NOT A STAND-IN. `level-entities.ts` is explicitly a placeholder for ticket
 * 005's `World` and is meant to be deleted when the sim lands. This is not:
 * scenery is a property of the level's terrain, not of its simulation, and a
 * `World` full of soldiers will still want the same 1,000 trees drawn around
 * them. It lives apart so 005 can delete its neighbour without touching it.
 *
 * ── WHY HASHED, NOT RANDOM ───────────────────────────────────────────────────
 *
 * Both the variant choice and the jitter are derived from the tile's own
 * coordinates through an integer hash. `Math.random()` would look identical on
 * the first load and then re-roll the entire forest on every mission restart —
 * a level the player has learned would rearrange itself between attempts. A
 * seeded PRNG walked in row-major order would fix that but couple every tile to
 * the ones before it, so inserting one canopy tile in the north-west would
 * reshuffle the whole map. A position hash has neither problem: each tile
 * decides alone, and it decides the same thing forever.
 *
 * The hash is the finaliser from MurmurHash3 over a mix of the two
 * coordinates. That matters more than it sounds. The obvious cheap choice,
 * `(x * 7 + y * 13) % 3` — which is what ticket 010 shipped — is LINEAR, so it
 * produces perfectly regular diagonal stripes of tree1/tree2/tree3 across the
 * map: exactly the "one sprite repeated" pattern the variants exist to avoid,
 * just with a period of three. Avalanche is the property being bought here, not
 * cryptographic anything.
 */

/** The terrain id `tools/mapgen` emits for jungle canopy (see `tools/mapgen/terrain.ts`). */
export const CANOPY_TILE_ID = 2

/**
 * The tree sprites in the ticket-004 atlas, in the order variants are chosen
 * from. Order is not meaningful beyond determinism.
 */
export const TREE_VARIANTS = ['tree1', 'tree2', 'tree3'] as const

export type TreeVariant = (typeof TREE_VARIANTS)[number]

/**
 * How far a tree may be displaced from its tile centre, in tiles.
 *
 * A tile is one world unit, so ±0.5 is the tile's own footprint and anything
 * larger would put a tree on a neighbour that may be open grass. 0.42 keeps the
 * trunk inside its own tile with a sliver to spare while still being enough
 * displacement to break the grid up — at ±0.2 the rows are still visible.
 */
const JITTER_RADIUS = 0.42

/** Distinct salts so the variant choice and the two jitter axes never correlate. */
const SALT_VARIANT = 0x9e3779b1
const SALT_JITTER_X = 0x85ebca6b
const SALT_JITTER_Y = 0xc2b2ae35

/** A displacement within a tile, in tiles. Both components are within ±0.5. */
export interface TileJitter {
  readonly x: number
  readonly y: number
}

/** One piece of scenery standing on one tile. */
export interface SceneryItem {
  /** Unique within the level and stable across loads. */
  readonly id: number
  readonly tileX: number
  readonly tileY: number
  /** Displacement from the tile centre, in tiles, within ±0.5. */
  readonly jitterX: number
  readonly jitterY: number
  /** Which atlas sprite source to draw. */
  readonly sprite: TreeVariant
}

/**
 * The shape of a level this module needs — the terrain grid and its size, and
 * nothing else. Narrower than `LevelData` on purpose: scenery does not depend
 * on spawns, objectives or the schema version, so it should not break when they
 * change, and a test can hand it four lines of literal.
 */
export interface SceneryLevel {
  readonly size: { readonly w: number; readonly h: number }
  readonly terrain: readonly (readonly number[])[]
}

/**
 * MurmurHash3's finaliser over two coordinates and a salt.
 *
 * `Math.imul` rather than `*` because these are 32-bit integer multiplies that
 * must wrap; JavaScript's `*` would promote to a double and lose the low bits
 * that the shifts below rely on. `>>> 0` at the end makes the result unsigned
 * so the caller can divide it into [0, 1) without a sign check.
 */
function hash2(x: number, y: number, salt: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** The hash as a fraction in [0, 1). */
function unitHash(x: number, y: number, salt: number): number {
  return hash2(x, y, salt) / 0x1_0000_0000
}

/**
 * Which tree stands on a tile.
 *
 * Deterministic in the tile's coordinates, evenly spread across the three
 * variants, and — because the hash avalanches — uncorrelated between
 * neighbours, so the forest has no visible period.
 */
export function treeVariantFor(tileX: number, tileY: number): TreeVariant {
  const index = hash2(tileX, tileY, SALT_VARIANT) % TREE_VARIANTS.length
  return TREE_VARIANTS[index] ?? TREE_VARIANTS[0]
}

/**
 * How far a tile's scenery is nudged off the tile centre.
 *
 * Without this the canopy reads as a chessboard of trees on exact one-unit
 * spacing, which no jungle does; with it the trunks scatter and the gaps
 * between them stop lining up into corridors.
 */
export function tileJitter(tileX: number, tileY: number): TileJitter {
  return {
    x: (unitHash(tileX, tileY, SALT_JITTER_X) * 2 - 1) * JITTER_RADIUS,
    y: (unitHash(tileX, tileY, SALT_JITTER_Y) * 2 - 1) * JITTER_RADIUS,
  }
}

/**
 * Every tree the level's canopy implies: one per canopy tile.
 *
 * ONE PER TILE, not one per canopy *region* and not one per interior-culled
 * tile. Culling canopy fully enclosed by other canopy removes only 273 of level
 * 1's 1,000 tiles, and since a tree stands far taller than the block beneath it
 * an "interior" tree is still visible over its neighbours — culling them would
 * punch holes in the middle of the forest, not save invisible work.
 *
 * Ids are the row-major tile index, so they are unique, stable across loads,
 * and independent of iteration order.
 */
export function canopyScenery(level: SceneryLevel): SceneryItem[] {
  const items: SceneryItem[] = []
  const { w, h } = level.size

  for (let tileY = 0; tileY < h; tileY += 1) {
    const row = level.terrain[tileY]
    if (!row) continue
    for (let tileX = 0; tileX < w; tileX += 1) {
      if (row[tileX] !== CANOPY_TILE_ID) continue
      const jitter = tileJitter(tileX, tileY)
      items.push({
        id: tileY * w + tileX,
        tileX,
        tileY,
        jitterX: jitter.x,
        jitterY: jitter.y,
        sprite: treeVariantFor(tileX, tileY),
      })
    }
  }

  return items
}
