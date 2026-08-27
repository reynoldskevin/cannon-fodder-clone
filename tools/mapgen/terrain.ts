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
import { colourDistance, luminance, pixelAt } from './image'
import type { TerrainColour } from './legend'

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
  /**
   * A deck laid across something else — a bridge. Declared, never guessed: no
   * colour rule in `classifyTile` produces this id, because a rule about "grey
   * means bridge" is a rule about every level including the ones nobody looked
   * at. It arrives only through `legend.json`'s `terrainColours`.
   */
  BRIDGE: 5,
} as const

/**
 * The terrain vocabulary a `legend.json` may write, name -> id.
 *
 * Derived from `TILE` rather than typed out a second time: a hand-written list
 * would be a third copy of the same table (after `core/level`'s `TERRAIN`) and
 * the one nobody would remember to update, leaving an id no author could name.
 *
 * NAMES, NOT IDS, in the legend for the same reason every other legend field is
 * a name: a level author writes `avatars`, not a category ordinal, and the
 * numeric tile ids are this directory's private business.
 */
export const TERRAIN_NAMES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(TILE).map(([name, id]) => [name.toLowerCase(), id]),
)

/**
 * The declared terrain claiming this tile's average colour, if any.
 *
 * Chebyshev at the legend's own `colourTolerance` — the same test and the same
 * one number the marker masks use, rather than a second tolerance to keep in
 * step. Euclidean would let a colour 60 off on a single channel and exact on the
 * other two count as close, and a declaration that absorbs terrain merely
 * averaging out near it is the heuristic this exists to replace.
 *
 * The first match wins, and it can only ever BE one: `parseLegend` rejects two
 * declared colours within twice the tolerance of each other, so no tile is ever
 * inside two claims at once.
 */
export function declaredTerrainAt(
  colour: RGB,
  declared: readonly TerrainColour[],
  tolerance: number,
): number | undefined {
  for (const entry of declared) {
    if (colourDistance(colour, entry.colour) <= tolerance) return entry.terrain
  }
  return undefined
}

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

/**
 * Largest island, in tiles, that may be dissolved into what surrounds it.
 *
 * EIGHT. Level 1's mis-classified rock forms 24 clumps of one to six tiles; a
 * cap of eight covers all of them with room to spare, and is far below anything
 * the source art draws as a deliberate feature (the smallest real clearing on
 * level 1 is dozens of tiles). Raise it and genuine small features start
 * dissolving; lower it below six and the artefacts this exists to remove
 * survive.
 */
const MAX_ISLAND_TILES = 8

/**
 * Share of an island's boundary that must be a single other id before it is
 * adopted, as a fraction.
 *
 * TWO THIRDS. An island wedged in a corner between two terrain types has a
 * genuinely ambiguous boundary and should be left exactly as classified; one
 * sitting in open jungle does not. Level 1's rock boundary is 83% canopy.
 */
const ISLAND_DOMINANCE = 2 / 3

/**
 * Dissolve small mis-classified ISLANDS into the terrain around them.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS HERE RATHER THAN IN THE RENDERER.
 * `classifyTile` reads ONE averaged colour per tile and has no idea what is
 * around it. Its rock branch is the fallback for `r > g`, and inside a jungle a
 * tile averaging over a brown trunk, a root, or a patch of leaf litter lands
 * there. On level 1 that produced 63 rock tiles and 23 near-black `unknown`
 * ones, scattered through the canopy — and each rendered as a 0.7-high grey
 * block standing among the trees, which is what a player sees as "a square on
 * the ground".
 *
 * ISLANDS, NOT TILES, and that distinction is the whole design. The obvious
 * version of this asks each tile whether its own neighbours outvote it, and it
 * does not work: level 1's rock comes in clumps of one to six, and every tile in
 * a clump has a neighbour of its own kind to hide behind. A rule that dissolved
 * them anyway would also dissolve any real two-tile feature. So the unit of
 * judgement is the CONNECTED COMPONENT: a small island whose shoreline is
 * overwhelmingly one other terrain becomes that terrain, and anything large
 * enough to be deliberate is left alone whatever its shape.
 *
 * COSMETIC ONLY. This rewrites the terrain id and NOTHING else; walkability is a
 * separate authored mask, and was already correct for these tiles — 61 of the 63
 * rocks were blocked, as jungle should be. So it changes what the map looks like
 * and cannot change where anybody may walk, which is the property that makes
 * dissolving anything safe at all. The import asserts it.
 *
 * A DECLARED TILE IS INVISIBLE TO ALL OF THIS (ticket 033). Everything above is
 * an argument about cleaning up a GUESS; a tile whose colour the legend declares
 * was not guessed at, and the exemption has to run in both directions or it only
 * half works. A declared tile is never part of an island, so it is never
 * dissolved — a three-tile footbridge would otherwise be dissolved back into the
 * river it crosses. And it is never counted as shoreline evidence either, so a
 * declaration cannot reach out and absorb a tile beside it: one rock boxed in on
 * three sides by declared bridge would otherwise clear the two-thirds dominance
 * cut and widen the deck by a tile nobody painted.
 *
 * That is the whole of it. A declared tile is not part of any island, casts no
 * vote, and is not a bridge between islands either — flooding an island THROUGH
 * a declaration would join two components that only touch across it, which can
 * push a pair of unrelated specks over the size cap and mix the far side's
 * shoreline into the near side's vote.
 */
function despecklePass(
  terrain: readonly (readonly number[])[],
  declared: readonly (readonly boolean[])[],
): number[][] {
  const h = terrain.length
  const w = terrain[0]?.length ?? 0
  const out = terrain.map((row) => [...row])
  const seen: boolean[] = new Array<boolean>(w * h).fill(false)
  const isDeclared = (x: number, y: number): boolean => declared[y]?.[x] === true

  // How much of the map each id covers, so an island can only ever be absorbed
  // by terrain there is MORE of than the island itself.
  //
  // WITHOUT THIS THE RULE CAN INVERT A MAP. The ring of canopy around a single
  // rock tile is itself a connected component; on a small enough map that ring
  // is under the size cap, its entire shoreline is that one rock, and it
  // dissolves INTO the speck. The speck wins and the jungle disappears. A test
  // caught exactly that on a 3x3 fixture.
  //
  // Declared tiles are left out of the census for the same reason they are left
  // out of the shoreline: they are not evidence about what the classifier
  // guessed, and counting them could let an island dissolve into a terrain that
  // exists nowhere on the map except as somebody's annotation.
  const total = new Map<number, number>()
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const id = terrain[y]?.[x]
      if (id === undefined || isDeclared(x, y)) continue
      total.set(id, (total.get(id) ?? 0) + 1)
    }
  }

  for (let y0 = 0; y0 < h; y0 += 1) {
    for (let x0 = 0; x0 < w; x0 += 1) {
      if (seen[y0 * w + x0] === true) continue
      if (isDeclared(x0, y0)) continue
      const id = terrain[y0]?.[x0]
      if (id === undefined) continue

      // Flood the island, counting its shoreline as we go. Read from `terrain`
      // throughout, never from `out`: every island is judged against the
      // ORIGINAL classification, so one dissolved island cannot cascade into its
      // neighbour and the result cannot depend on scan order.
      const island: number[] = []
      const shore = new Map<number, number>()
      const stack = [y0 * w + x0]
      seen[y0 * w + x0] = true
      while (stack.length > 0) {
        const index = stack.pop()
        if (index === undefined) continue
        const x = index % w
        const y = (index - x) / w
        island.push(index)
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const neighbour = terrain[ny]?.[nx]
          if (neighbour === undefined) continue
          const at = ny * w + nx
          // A declared tile is neither part of this island nor evidence about
          // it: the flood stops here and no vote is cast.
          if (isDeclared(nx, ny)) continue
          if (neighbour !== id) {
            shore.set(neighbour, (shore.get(neighbour) ?? 0) + 1)
            continue
          }
          if (seen[at] === true) continue
          seen[at] = true
          stack.push(at)
        }
      }

      if (island.length > MAX_ISLAND_TILES) continue

      let dominant: number | undefined
      let dominantCount = 0
      let shoreTotal = 0
      for (const [candidate, count] of shore) {
        shoreTotal += count
        if (count > dominantCount) {
          dominant = candidate
          dominantCount = count
        }
      }
      // At least two shore tiles: a single neighbour is not a shoreline, it is
      // one tile's opinion, and it would flip the ends of any one-tile-wide strip.
      if (dominant === undefined || shoreTotal < 2) continue
      if (dominantCount / shoreTotal < ISLAND_DOMINANCE) continue
      if ((total.get(dominant) ?? 0) <= island.length) continue

      for (const index of island) {
        const x = index % w
        const y = (index - x) / w
        const row = out[y]
        if (row !== undefined) row[x] = dominant
      }
    }
  }

  return out
}

/**
 * How many times the pass may run before giving up.
 *
 * A backstop, not a tuning knob: the pass shrinks the number of distinct islands
 * or leaves the map alone, so it converges quickly — level 1 settles in three.
 * The cap exists so that a pathological map cannot spin here forever.
 */
const MAX_DESPECKLE_PASSES = 8

/**
 * Dissolve small mis-classified islands, repeatedly, until the map settles.
 *
 * WHY ONE PASS IS NOT ENOUGH, and it is not a flaw in the pass. Each pass judges
 * every island against the SAME snapshot, which is what makes it independent of
 * scan order — but it also means an island whose shoreline only becomes
 * unambiguous once its neighbours have dissolved is not seen that time round. On
 * level 1 one pass left a six-tile clump ringed entirely by grass and a single
 * tile 75% ringed by canopy, both of which the next pass removed: their
 * shorelines had been muddled by the `unknown` tiles beside them, and those went
 * first.
 *
 * Running to a fixed point also makes this function IDEMPOTENT by construction —
 * `despeckle(despeckle(x))` is `despeckle(x)` — which a single pass was not, and
 * which anything an offline pipeline re-runs on its own output ought to be.
 */
export function despeckleTerrain(
  terrain: readonly (readonly number[])[],
  /**
   * True where `legend.json` declared the tile's colour. Optional and empty by
   * default, so a level that declares nothing — level 1 — goes through this
   * unchanged, byte for byte.
   */
  declaredMask: readonly (readonly boolean[])[] = [],
): number[][] {
  let current = terrain.map((row) => [...row])
  for (let pass = 0; pass < MAX_DESPECKLE_PASSES; pass += 1) {
    const next = despecklePass(current, declaredMask)
    if (next.every((row, y) => row.every((id, x) => id === current[y]?.[x]))) return current
    current = next
  }
  return current
}

/**
 * Any BLOCKED tile still classified as grass becomes canopy.
 *
 * WHY: blocked grass is scrub, and the style table draws it as a raised block —
 * 0.45 world units of flat dark green with nothing standing on it. In open
 * ground that reads as a coloured square lying in a field, which is exactly the
 * artefact the despeckle above exists to remove; it survives only because a
 * blocked-grass tile is not MIS-classified in any way this map can see. The
 * colour is right, the passability is right, and it still looks wrong.
 *
 * Reclassifying it as canopy fixes it by making it a real thing instead: canopy
 * lies flat, and `core/render-state/scenery` plants one tree per FRINGE canopy
 * tile — which an isolated blocked tile in a field always is. So the square
 * becomes a tree, and the reason the player cannot walk there becomes something
 * he can see. Level 1 has 57 of them.
 *
 * AFTER THE DESPECKLE, NEVER BEFORE. Run first, these would be lone canopy tiles
 * in a sea of grass, and the despeckle would faithfully dissolve every one of
 * them straight back to grass — leaving 57 tiles that look like open field and
 * cannot be walked on. Invisible walls are far worse than visible squares.
 *
 * WALKABILITY IS READ, NEVER WRITTEN. This changes what a tile looks like on the
 * strength of what it already is; a pass that could edit the mask could make a
 * mission unwinnable.
 *
 * A DECLARED TILE IS EXEMPT (ticket 033), on the same rule as the despeckle
 * above: this is a heuristic about a GUESS, and a tile the legend named was not
 * guessed at. An author who declares a colour `grass` and paints it closed in
 * `walkable.png` has said two things, both of them on purpose — a blocked
 * clearing — and rewriting it to canopy would overrule the one thing they stated
 * outright with the one this file inferred.
 */
export function blockedGrassToCanopy(
  terrain: readonly (readonly number[])[],
  walkable: readonly (readonly boolean[])[],
  /**
   * True where `legend.json` declared the tile's colour. Empty by default, so a
   * level that declares nothing — level 1 — goes through this unchanged.
   */
  declaredMask: readonly (readonly boolean[])[] = [],
): number[][] {
  return terrain.map((row, y) =>
    row.map((id, x) =>
      id === TILE.GRASS && walkable[y]?.[x] === false && declaredMask[y]?.[x] !== true
        ? TILE.CANOPY
        : id,
    ),
  )
}

/**
 * Which tiles the legend's declared terrain colours claim, and as what.
 *
 * Matched on the tile AVERAGE and therefore AFTER the ink mask has done its
 * work, which is the whole distinction ticket 033 turns on: `markerColours` are
 * annotation drawn ON terrain and are excluded from the average, while a terrain
 * colour IS the terrain and is exactly what the average has to measure. Routing
 * a declared colour through the ink mask would erase the deck from the map it is
 * there to describe.
 */
function declaredGrid(
  averages: readonly (readonly RGB[])[],
  declared: readonly TerrainColour[],
  tolerance: number,
): (number | undefined)[][] {
  return averages.map((row) => row.map((c) => declaredTerrainAt(c, declared, tolerance)))
}

/**
 * Which tiles the legend claims, as a plain mask.
 *
 * Exported because the exemption outlives `buildTerrain`: `blockedGrassToCanopy`
 * runs later, once the walkability mask is known, and it has to know which tiles
 * were declared too. Recomputed from the same averages and the same tolerance
 * rather than smuggled out of `buildTerrain` as a second return value, so there
 * is one definition of "declared" and no way for the two to drift.
 */
export function declaredTerrainMask(
  averages: readonly (readonly RGB[])[],
  declared: readonly TerrainColour[] = [],
  tolerance = 0,
): boolean[][] {
  return declaredGrid(averages, declared, tolerance).map((row) =>
    row.map((id) => id !== undefined),
  )
}

export function buildTerrain(
  averages: readonly (readonly RGB[])[],
  walkableMinLuminance: number,
  /** `legend.json`'s declared terrain colours; empty when it declares none. */
  declared: readonly TerrainColour[] = [],
  tolerance = 0,
): number[][] {
  const claimed = declaredGrid(averages, declared, tolerance)
  // A declared tile takes its id outright: `classifyTile` is not consulted for
  // it at all, because the classifier already had an opinion about level 2's
  // deck — canopy — and it is not the artist's.
  const classified = averages.map((row, y) =>
    row.map((c, x) => claimed[y]?.[x] ?? classifyTile(c, walkableMinLuminance)),
  )
  return despeckleTerrain(
    classified,
    claimed.map((row) => row.map((id) => id !== undefined)),
  )
}

/**
 * Whether a DECLARED terrain is walkable, keyed by what it is rather than by how
 * bright it was painted.
 *
 * A short explicit table, and the shortness is the point: "declared" cannot
 * simply mean "walkable", because canopy is a name the legend accepts and canopy
 * is the thing that blocks. `rgb(100,100,100)` clears level 2's luminance cut at
 * luma 100 against 55, so today's deck is passable BY LUCK — a deck painted in a
 * dark stain would come out solid with the importer cheerfully calling it a
 * bridge.
 *
 * UNKNOWN IS ABSENT ON PURPOSE, not forgotten: it is the id for "no idea what
 * this is", so declaring it says nothing about passability and the luminance
 * guess is still the best answer available.
 */
const DECLARED_WALKABLE: Readonly<Record<number, boolean>> = {
  [TILE.GRASS]: true,
  [TILE.CANOPY]: false,
  [TILE.ROCK]: true,
  [TILE.WATER]: true,
  [TILE.BRIDGE]: true,
}

/**
 * Heuristic passability: bright enough to be open ground, OR water.
 *
 * WHY WATER IS AN EXCEPTION AND NOT A LOWER THRESHOLD (ticket 003a). Luminance
 * asks "is this bright enough to be open ground", which is a fair guess about
 * grass and a wrong one about a river: water is dark, so level 2's 685 water
 * tiles all came out solid, the map came out cut in two, and the squad could
 * reach 7 of its 15 enemies.
 *
 * The fix is NOT a second, lower cut for blue pixels. Canopy is darker than
 * level 2's river colour, so any threshold moved down far enough to admit the
 * water admits every jungle tile in the game with it. It keys off what
 * `classifyTile` has already decided the tile IS — which it has decided
 * correctly since ticket 003 — so every non-water tile keeps today's luminance
 * rule byte for byte.
 *
 * `classifyTile` is called again rather than reading `buildTerrain`'s output
 * on purpose: that output is DESPECKLED, and the despeckle is documented and
 * tested as cosmetic — it rewrites tile ids and can never move the walkability
 * mask. Feeding it in here would quietly make that false, so a five-tile speck
 * dissolving could open or close ground.
 *
 * AN AUTHORED `walkable.png` STILL OUTRANKS ALL OF THIS. It does not call this
 * function at all — see `walkableFromMask`, and the branch in `importLevel`
 * that picks between them. "Water is walkable" and "the mask decides" only look
 * like they conflict until you know which one runs.
 *
 * A DECLARED TILE IS ANSWERED FROM `DECLARED_WALKABLE`, never from luminance —
 * see there for why brightness is the wrong question to ask about a bridge. The
 * authored-mask rule above is untouched by that: this function still is not
 * called at all when `walkable.png` exists.
 */
export function buildWalkable(
  averages: readonly (readonly RGB[])[],
  walkableMinLuminance: number,
  declared: readonly TerrainColour[] = [],
  tolerance = 0,
): boolean[][] {
  return averages.map((row) =>
    row.map((c) => {
      const claimed = declaredTerrainAt(c, declared, tolerance)
      const stated = claimed === undefined ? undefined : DECLARED_WALKABLE[claimed]
      if (stated !== undefined) return stated
      return (
        classifyTile(c, walkableMinLuminance) === TILE.WATER ||
        luminance(c) >= walkableMinLuminance
      )
    }),
  )
}

/** Mask override: black = blocked, white = walkable, decided per tile average. */
export function walkableFromMask(mask: Image, tileSize: number, w: number, h: number): boolean[][] {
  // The mask is authored art in its own right — every pixel of it is meaningful,
  // so nothing is excluded from these averages.
  const { averages } = tileAverages(mask, tileSize, w, h)
  return averages.map((row) => row.map((c) => luminance(c) >= 128))
}
