/**
 * Scenery derived from the terrain itself (ticket 010a).
 *
 * WHERE THE TREE ART ACTUALLY BELONGS. The source map for level 1 draws dense
 * jungle; `tools/mapgen` turned that jungle into 1,000 blocked tiles of terrain
 * id 2, "canopy". Ticket 010 hung `tree1/2/3` on the level's single `tree`
 * annotation instead — one palm on a map whose whole eastern half is forest —
 * and left the actual forest as extruded green blocks. This module is the
 * correction: the canopy tiles ARE the trees — or, since the 010a revision, the
 * canopy tiles on the EDGE of the jungle are, and the rest of the mass is drawn
 * by the raised terrain underneath them (see `canopyScenery`).
 *
 * Engine-free, like everything else in `core/`. It answers "what scenery does
 * this level have and where", in tile coordinates; turning that into world
 * positions and instanced quads is `src/render/scenery-entities.ts`'s job.
 *
 * NOT A STAND-IN, WHICH IS WHY IT SURVIVED. Its old neighbour
 * `src/render/level-entities.ts` was a placeholder for the simulation and was
 * deleted when the sim landed in ticket 008a. This module was not and is not:
 * scenery is a property of the level's terrain, not of its simulation, and a
 * `World` full of soldiers still wants the same trees drawn around them. Keeping
 * the two apart is what let the placeholder go without touching this.
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
 *
 * THE BROADLEAF ART, AND ONLY THE BROADLEAF ART. `tree1/2/3` is the dense,
 * dark, vine-hung canopy the source map paints across half the level, so it is
 * what the canopy TERRAIN is drawn with. The atlas also carries `palmtree1/2/3`
 * and they are deliberately absent here: palms belong to the map's hand-placed
 * `tree` ANNOTATIONS (see `PALM_VARIANTS` below and `src/core/session/props.ts`),
 * which is a different thing on the map and should read as a different thing on
 * screen. The two families are painted in different styles — one rendered, one
 * flat cel-shaded — so mixing them across the forest fringe would look like two
 * games sharing a map rather than like variety.
 */
export const TREE_VARIANTS = ['tree1', 'tree2', 'tree3'] as const

export type TreeVariant = (typeof TREE_VARIANTS)[number]

/**
 * The palm sprites, for a tile the map ANNOTATES as a `tree`.
 *
 * A landmark rather than terrain: there is one of these on level 1, hand-placed,
 * and its job is to be a distinct thing you can point at. Kept beside
 * `TREE_VARIANTS` because both answer "which tree art stands here" and both must
 * answer it the same way on every load; kept separate from it because the two
 * pools are chosen by different questions about the map.
 */
export const PALM_VARIANTS = ['palmtree1', 'palmtree2', 'palmtree3'] as const

export type PalmVariant = (typeof PALM_VARIANTS)[number]

/**
 * How far a tree may be displaced from its tile centre, in tiles.
 *
 * A tile is one world unit, so ±0.5 is the tile's own footprint and anything
 * larger would put a tree on a neighbour that may be open grass. 0.42 keeps the
 * trunk inside its own tile with a sliver to spare while still being enough
 * displacement to break the grid up — at ±0.2 the rows are still visible.
 */
const JITTER_RADIUS = 0.42

/** Distinct salts so the variant choices and the two jitter axes never correlate. */
const SALT_VARIANT = 0x9e3779b1
const SALT_JITTER_X = 0x85ebca6b
const SALT_JITTER_Y = 0xc2b2ae35
const SALT_PALM = 0x27d4eb2d

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
 * Deterministic in the tile's coordinates, evenly spread across the declared
 * variants, and — because the hash avalanches — uncorrelated between
 * neighbours, so the forest has no visible period.
 */
export function treeVariantFor(tileX: number, tileY: number): TreeVariant {
  const index = hash2(tileX, tileY, SALT_VARIANT) % TREE_VARIANTS.length
  return TREE_VARIANTS[index] ?? TREE_VARIANTS[0]
}

/**
 * Which palm stands on a tile the map annotates as a `tree`.
 *
 * Same contract as `treeVariantFor` — decided by the tile alone, so the palm at
 * a given annotation is the same palm on every load and moving the annotation is
 * the only thing that changes it. Its own salt, so a tile does not get its palm
 * and its canopy tree from the same roll.
 */
export function palmVariantFor(tileX: number, tileY: number): PalmVariant {
  const index = hash2(tileX, tileY, SALT_PALM) % PALM_VARIANTS.length
  return PALM_VARIANTS[index] ?? PALM_VARIANTS[0]
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

/** Is this tile canopy? Off-map is not — the map's edge is open ground. */
export function isCanopy(level: SceneryLevel, tileX: number, tileY: number): boolean {
  const { w, h } = level.size
  if (tileX < 0 || tileY < 0 || tileX >= w || tileY >= h) return false
  return level.terrain[tileY]?.[tileX] === CANOPY_TILE_ID
}

/**
 * Is this canopy tile on the FRINGE of its mass — does it have any 4-neighbour
 * that is not canopy?
 *
 * Off-map counts as not-canopy: a tile at the map border has open ground beyond
 * it as far as the player can ever see, so it reads as fringe.
 *
 * Non-canopy tiles are neither fringe nor interior; this returns false for them.
 */
export function isFringeCanopy(level: SceneryLevel, tileX: number, tileY: number): boolean {
  if (!isCanopy(level, tileX, tileY)) return false
  return (
    !isCanopy(level, tileX - 1, tileY) ||
    !isCanopy(level, tileX + 1, tileY) ||
    !isCanopy(level, tileX, tileY - 1) ||
    !isCanopy(level, tileX, tileY + 1)
  )
}

/** The deepest `canopyDepth` reports — see that function. */
export const MAX_CANOPY_DEPTH = 2

/**
 * How far inside its mass a canopy tile sits, as a small integer:
 * `0` on the fringe, `1` one ring in, `2` for anything deeper (and `0` for a
 * tile that is not canopy at all).
 *
 * The renderer uses this to raise the mass toward its middle. Two rings is
 * enough for the eye — the point is a chamfer rather than a cliff at the
 * fringe/interior seam, not a real distance field — and stopping at two keeps
 * this a fixed 12-tile lookup per tile instead of a flood fill.
 */
export function canopyDepth(level: SceneryLevel, tileX: number, tileY: number): number {
  if (!isCanopy(level, tileX, tileY)) return 0
  if (isFringeCanopy(level, tileX, tileY)) return 0
  // Interior. One ring in if any neighbour is itself on the fringe.
  const nextToFringe =
    isFringeCanopy(level, tileX - 1, tileY) ||
    isFringeCanopy(level, tileX + 1, tileY) ||
    isFringeCanopy(level, tileX, tileY - 1) ||
    isFringeCanopy(level, tileX, tileY + 1)
  return nextToFringe ? 1 : MAX_CANOPY_DEPTH
}

/**
 * Every tree the level's canopy implies: one per canopy tile.
 *
 * FRINGE-ONLY IS REVERTED, and the reason it existed is the reason it had to go.
 * Ticket 010a planted trunks on the fringe alone, on the argument that a trunk
 * buried inside a dense mass is hidden by the crowns around it and pays for
 * itself in overdraw — and that argument rested on a premise stated in its own
 * comment: "the interior is left as RAISED FOLIAGE-COLOURED TERRAIN". That
 * premise is gone. Canopy now lies flat and is tinted exactly like grass,
 * because the raised, differently-tinted tile is what drew a hard-edged square
 * on the ground under every tree.
 *
 * So with fringe-only planting the interior of every forest was bare grass
 * ringed by a single line of trees — the canopy emptied out instead of filling
 * in. Whatever the terrain stops carrying, the trees have to carry. On level 1
 * that is 1,205 trees over 1,205 canopy tiles.
 *
 * `isFringeCanopy` is kept and still exported: it is a real property of the map
 * and the thing to reach for if the interior ever needs to be planted
 * DIFFERENTLY from the edge — smaller trees, undergrowth, a second sprite set —
 * rather than not at all.
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
      if (!isCanopy(level, tileX, tileY)) continue
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
