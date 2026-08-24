/**
 * tools/mapgen — annotated map image + legend -> validated `level.json`.
 *
 * Offline only. The game never parses an image at runtime; it loads the JSON
 * this importer writes, and this importer refuses to write anything that its
 * own consumer — `loadLevel` from `src/core/level` — would reject.
 *
 * Pipeline:
 *   map.png + legend.json
 *     -> colour masks -> connected components
 *     -> geometric glyph/label split (no OCR)
 *     -> legend labels supply prop identity
 *     -> tile grid, terrain ids, walkability (walkable.png overrides)
 *     -> loadLevel() validation -> deterministic JSON on disk
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLevel } from '../../src/core/level/index'
import type { LevelData } from '../../src/core/level/index'
import { CURRENT_SCHEMA_VERSION } from '../../src/core/level/index'
import { detectMarkers } from './detect'
import type {
  DetectedMarker,
  DiscardedCluster,
  SuspiciousCluster,
  UnknownMarker,
} from './detect'
import { MapgenError } from './errors'
import { decodePngFile } from './image'
import { stableStringify } from './json'
import { readLegendFile, SPAWN_CATEGORIES } from './legend'
import type { LegendLabel, SpawnCategory } from './legend'
import {
  buildTerrain,
  buildWalkable,
  MAX_INK_FRACTION,
  tileAverages,
  walkableFromMask,
} from './terrain'

export { MapgenError } from './errors'
export type { Legend, LegendLabel, SpawnCategory } from './legend'

export interface ImportOptions {
  /** Directory holding `map.png`, `legend.json` and optionally `walkable.png`. */
  readonly sourceDir: string
  /** Directory the `<name>.json` is written to; created if absent. */
  readonly outDir: string
  /** Level name, which is also the output file name. */
  readonly name: string
}

/** Everything the importer noticed but did not treat as an error. */
export interface ImportReport {
  readonly warnings: readonly string[]
  /** Colour clusters that were not crosshair glyphs — text labels, stray ink. */
  readonly discardedClusters: readonly DiscardedCluster[]
  /** Crosshairs drawn in a colour the legend does not declare. */
  readonly unknownMarkers: readonly UnknownMarker[]
  /** Legend labels with no marker near them — usually a stale coordinate. */
  readonly unmatchedLabels: readonly LegendLabel[]
  /** Accepted glyphs that look like two overlapping markers merged into one. */
  readonly suspiciousClusters: readonly SuspiciousCluster[]
}

export interface ImportResult {
  readonly level: LevelData
  readonly report: ImportReport
  /** Always true on return: the importer writes nothing that fails `loadLevel`. */
  readonly validated: boolean
}

/**
 * How far a legend label may sit from the glyph it annotates, in tiles. Legend
 * positions are hand-measured off the source art, so they are approximate; two
 * tiles is comfortably more than that slop and comfortably less than the gap
 * between any two markers.
 */
const LABEL_MATCH_RADIUS_TILES = 2

type SpawnRecord = { x: number; y: number; type?: string }

/**
 * Attach legend labels to detected markers — IDENTITY ONLY.
 *
 * A legend entry is a hand-authored statement about one specific marker — "the
 * glyph at roughly (804, 437) is a `bird_left`" — and it is the *only* source of
 * a marker's identity, because the text drawn beside the glyph is anti-aliased
 * over noisy terrain and this importer does no OCR by design.
 *
 * The label's coordinate is used ONLY to decide which marker it is talking
 * about. It never becomes the spawn's position: every position comes from the
 * glyph centroid, so the map art is the single source of truth for *where*
 * things are. A legend able to move a spawn would let a hand-typed coordinate
 * silently diverge from the picture — exactly the corruption this pipeline
 * exists to prevent.
 *
 * Labels are processed in legend order and each claims the nearest unclaimed
 * marker within the match radius, so the mapping is a deterministic function of
 * the file. A label that claims nothing is reported, never silently ignored — a
 * stale coordinate is an authoring bug.
 *
 * DECISION — labels are category-scoped, optionally but loudly:
 *   - A label that declares `"category"` can only ever claim a marker of that
 *     category. A `tree` drawn a tile from an avatar glyph then finds nothing
 *     and is reported as unmatched, rather than renaming the player.
 *   - A label without a category keeps pure distance matching, because legends
 *     written before this existed must keep working — but every such match is
 *     WARNED, naming the category it landed on, so an unscoped label can never
 *     mis-assign identity silently. Adding `"category"` to the legend is the
 *     fix, and it is the only thing that silences the warning.
 * Making `category` mandatory would have been stricter still, but it would break
 * every existing legend at once for a case the warning already surfaces.
 */
function matchLabels(
  markers: readonly DetectedMarker[],
  labels: readonly LegendLabel[],
  tileSize: number,
): { types: (string | undefined)[]; unmatched: LegendLabel[]; warnings: string[] } {
  const radius = LABEL_MATCH_RADIUS_TILES * tileSize
  const types: (string | undefined)[] = markers.map(() => undefined)
  const claimed = new Set<number>()
  const unmatched: LegendLabel[] = []
  const warnings: string[] = []

  for (const label of labels) {
    const where = `"${label.type}" at (${String(label.at[0])}, ${String(label.at[1])})`
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    let tied = false
    for (let i = 0; i < markers.length; i += 1) {
      if (claimed.has(i)) continue
      const marker = markers[i]
      if (!marker) continue
      // Category scoping: a scoped label simply cannot see other categories.
      if (label.category !== undefined && marker.category !== label.category) continue
      const distance = Math.hypot(marker.cx - label.at[0], marker.cy - label.at[1])
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
        tied = false
      } else if (distance === bestDistance) {
        tied = true
      }
    }
    if (best < 0 || bestDistance > radius) {
      unmatched.push(label)
      continue
    }
    // A tie is resolved by marker order, which is an implementation detail —
    // say so rather than let the arbitrary winner look considered.
    if (tied) {
      warnings.push(
        `legend label ${where} is equidistant (${bestDistance.toFixed(
          1,
        )}px) from more than one marker; it was attached to the first in scan order — move the label closer to the glyph it means`,
      )
    }
    const marker = markers[best]
    if (label.category === undefined && marker) {
      warnings.push(
        `legend label ${where} declares no "category" and attached to a marker in category "${marker.category}" at pixel (${String(
          Math.round(marker.cx),
        )}, ${String(
          Math.round(marker.cy),
        )}) purely by distance — add "category" to the label to make the identity explicit`,
      )
    }
    claimed.add(best)
    types[best] = label.type
  }

  return { types, unmatched, warnings }
}

/** `(3, 4), (9, 1)` — spawn tiles, in the order they were emitted. */
function formatTiles(spawns: readonly SpawnRecord[]): string {
  return spawns.map((s) => `(${String(s.x)}, ${String(s.y)})`).join(', ')
}

/**
 * How many tile coordinates a warning may list before it summarises the rest.
 * A per-tile problem can in principle cover the whole grid, and a warning that
 * prints two thousand coordinates is a warning nobody reads.
 */
const MAX_LISTED_TILES = 12

/** `(3, 4), (9, 1) and 7 more` — capped so a grid-wide problem stays readable. */
function formatTileList(tiles: readonly { x: number; y: number }[]): string {
  const shown = formatTiles(tiles.slice(0, MAX_LISTED_TILES))
  if (tiles.length <= MAX_LISTED_TILES) return shown
  return `${shown} and ${String(tiles.length - MAX_LISTED_TILES)} more`
}

type LevelObjective = { readonly type: string; readonly [param: string]: unknown }

/**
 * What one objective demands of the spawn table, or why it cannot be judged.
 *
 * `minimum` is how many spawns of `category` must merely EXIST for the objective
 * to be satisfiable at all; `needAll` is whether every one of them must also be
 * reachable. The two are separate questions with separate answers — "you asked
 * for three kills and drew one enemy" is an authoring mistake no walkability
 * grid can fix, while "you drew three and walled one off" is a map mistake — and
 * conflating them produced a warning that claimed a problem while reporting
 * everything reachable.
 */
type ObjectiveCheck =
  | {
      readonly checkable: true
      readonly category: SpawnCategory
      readonly noun: string
      readonly nouns: string
      readonly minimum: number
      readonly needAll: boolean
    }
  | { readonly checkable: false; readonly reason: string }

function classifyObjective(objective: LevelObjective): ObjectiveCheck {
  switch (objective.type) {
    // Every enemy must be reachable, but a level that draws none is won on the
    // first frame rather than unwinnable — hence a minimum of zero.
    case 'kill_all':
      return {
        checkable: true,
        category: 'enemies',
        noun: 'enemy',
        nouns: 'enemies',
        minimum: 0,
        needAll: true,
      }
    case 'collect_chests':
      return {
        checkable: true,
        category: 'chests',
        noun: 'chest',
        nouns: 'chests',
        minimum: 1,
        needAll: true,
      }
    case 'kill_count': {
      // The parameter is free-form on the level schema, so a non-numeric one is
      // not this check's business to reject — but it is very much its business
      // to say that it could not be checked.
      const needed = objective.count
      if (typeof needed !== 'number' || !Number.isFinite(needed)) {
        return {
          checkable: false,
          reason:
            needed === undefined
              ? 'it states no "count" parameter'
              : `its "count" parameter is not a finite number (${JSON.stringify(needed)})`,
        }
      }
      return {
        checkable: true,
        category: 'enemies',
        noun: 'enemy',
        nouns: 'enemies',
        minimum: needed,
        needAll: false,
      }
    }
    default:
      return { checkable: false, reason: 'this importer does not know what it requires' }
  }
}

/**
 * Cheap playability checks on the finished grid.
 *
 * A wrong walkability grid is otherwise undiscoverable until someone loads the
 * level and finds a player standing in a wall: the heuristic threshold is tuned
 * to one level's palette and a quarter of level 1's tiles sit within ±10 of the
 * cut. These are WARNINGS, not errors — a level may legitimately open with an
 * unreachable enemy behind a door, and a heuristic grid has no business hard-
 * failing an import — but they must be said out loud.
 *
 * The reachability question is asked AGAINST THE LEVEL'S OWN OBJECTIVES, because
 * "is anything reachable at all" is not what any objective asks. `kill_all` — the
 * only objective type in the repo, and the default a legend gets when it states
 * none — needs *every* enemy reachable, so a map whose second enemy is walled off
 * is unwinnable while nine out of ten enemies still answer "yes, something is
 * reachable". Each unreachable spawn is named by tile so the answer is
 * actionable: the fix is to look at that tile.
 */
function sanityCheckWalkability(
  walkable: readonly (readonly boolean[])[],
  spawns: Record<SpawnCategory, SpawnRecord[]>,
  source: 'heuristic' | 'mask',
  objectives: readonly LevelObjective[],
): string[] {
  const warnings: string[] = []
  const at = (x: number, y: number): boolean => walkable[y]?.[x] === true

  for (const avatar of spawns.avatars) {
    if (!at(avatar.x, avatar.y)) {
      warnings.push(
        `avatar spawn at tile (${String(avatar.x)}, ${String(
          avatar.y,
        )}) is on a BLOCKED tile — the ${source} walkability grid disagrees with the map art`,
      )
    }
  }

  // The same objective stated twice is one requirement, not two: de-duplicate so
  // a copy-pasted legend entry does not produce the identical warning twice and
  // make one problem look like two.
  const seenObjectives = new Set<string>()
  const unique = objectives.filter((objective) => {
    const key = stableStringify(objective)
    if (seenObjectives.has(key)) return false
    seenObjectives.add(key)
    return true
  })
  const checks = unique.map((objective) => ({ objective, check: classifyObjective(objective) }))

  // --- can the objective be satisfied at all? ------------------------------
  // Asked BEFORE the flood fill, because it is not a question about walkability:
  // an objective that needs spawns the level never draws is unwinnable as
  // authored, and the reachability pass — which needs an avatar and something to
  // reach — would return early and say nothing at all about it.
  const satisfiable = new Set<LevelObjective>()
  for (const { objective, check } of checks) {
    if (!check.checkable) continue
    const have = spawns[check.category].length
    if (have >= check.minimum) {
      satisfiable.add(objective)
      continue
    }
    warnings.push(
      `objective "${objective.type}" needs ${String(check.minimum)} ${
        check.minimum === 1 ? check.noun : check.nouns
      } but the level defines ${
        have === 0
          ? `no ${check.noun} spawns`
          : `only ${String(have)} ${have === 1 ? check.noun : check.nouns} spawn${
              have === 1 ? '' : 's'
            }`
      } — the level is unwinnable as authored`,
    )
  }

  // --- objectives that could not be judged ---------------------------------
  // Substituting a weaker predicate for the one the level actually states is a
  // defensible fallback and an indefensible silence: say which objective went
  // unchecked and what was checked in its place.
  const checkableCount = checks.filter(({ check }) => check.checkable).length
  for (const { objective, check } of checks) {
    if (check.checkable) continue
    warnings.push(
      `objective "${objective.type}" could not be verified: ${check.reason} — ${
        checkableCount > 0
          ? 'the other objectives on this level were still checked for reachability, but nothing was verified for this one'
          : `with no checkable objective on this level, only the weaker property that at least one enemy spawn is reachable on foot from an avatar spawn was checked instead`
      }`,
    )
  }

  // Nothing to flood-fill from: without an avatar there is no "reachable" to
  // speak of, and a level with no units at all cannot fail this check.
  if (spawns.avatars.length === 0) return warnings
  if (spawns.enemies.length === 0 && spawns.chests.length === 0) return warnings

  // Flood fill from every avatar at once; 4-connected, matching how a grid-based
  // mover actually travels.
  const h = walkable.length
  const w = walkable[0]?.length ?? 0
  const seen = new Set<number>()
  const queue: number[] = []
  for (const avatar of spawns.avatars) {
    const index = avatar.y * w + avatar.x
    if (!seen.has(index)) {
      seen.add(index)
      queue.push(index)
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head] ?? 0
    const x = index % w
    const y = (index - x) / w
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (!at(nx, ny)) continue
      const nIndex = ny * w + nx
      if (seen.has(nIndex)) continue
      seen.add(nIndex)
      queue.push(nIndex)
    }
  }

  const unreachable = (list: readonly SpawnRecord[]): SpawnRecord[] =>
    list.filter((s) => !seen.has(s.y * w + s.x))
  const requireAll = (list: readonly SpawnRecord[], noun: string, objective: string): void => {
    const lost = unreachable(list)
    if (lost.length === 0) return
    warnings.push(
      `objective "${objective}" needs every ${noun} reachable on foot from an avatar spawn, but ${String(
        lost.length,
      )} of ${String(list.length)} ${
        lost.length === 1 ? 'is' : 'are'
      } walled off under the ${source} walkability grid — ${noun} spawn(s) at tile ${formatTiles(
        lost,
      )} — the level may be unwinnable`,
    )
  }

  for (const { objective, check } of checks) {
    // Unsatisfiable or unjudgeable objectives have already been reported above;
    // re-stating them here in terms of reachability would say the same problem
    // twice in two different vocabularies.
    if (!check.checkable || !satisfiable.has(objective)) continue
    const list = spawns[check.category]
    if (check.needAll) {
      requireAll(list, check.noun, objective.type)
      continue
    }
    const lost = unreachable(list)
    const reachable = list.length - lost.length
    if (reachable >= check.minimum) continue
    // `lost` is necessarily non-empty here: the level has at least `minimum`
    // spawns (that is what `satisfiable` means) yet fewer than `minimum` of them
    // are reachable, so something is walled off and there is a tile to name.
    warnings.push(
      `objective "${objective.type}" needs ${String(check.minimum)} ${
        check.nouns
      } killable but only ${String(reachable)} of ${String(
        list.length,
      )} ${check.noun} spawns are reachable on foot from an avatar spawn under the ${source} walkability grid — unreachable ${
        check.noun
      } spawn(s) at tile ${formatTiles(lost)} — the level may be unwinnable`,
    )
  }

  // An objective type this importer has never heard of still needs *something*
  // to be reachable, so fall back to the weakest defensible claim rather than
  // saying nothing about a grid nobody has checked.
  if (
    checkableCount === 0 &&
    spawns.enemies.length > 0 &&
    unreachable(spawns.enemies).length === spawns.enemies.length
  ) {
    warnings.push(
      `no enemy spawn is reachable on foot from any avatar spawn under the ${source} walkability grid — the level may be unwinnable`,
    )
  }
  return warnings
}

export function importLevel(options: ImportOptions): ImportResult {
  const { sourceDir, outDir, name } = options
  const warnings: string[] = []

  const mapPath = join(sourceDir, 'map.png')
  if (!existsSync(mapPath)) {
    throw new MapgenError(`map.png is missing from the level source directory: ${sourceDir}`)
  }
  const image = decodePngFile(mapPath, 'map.png')
  const legend = readLegendFile(join(sourceDir, 'legend.json'))
  const { tileSize } = legend

  // Strict: the tile size must divide BOTH axes exactly. A remainder on either
  // axis means the stated tile size does not match the art, and a ragged grid
  // would shift every spawn coordinate derived from it. Cropping the offcut
  // would hide the mismatch, so this is fatal.
  if (image.width % tileSize !== 0 || image.height % tileSize !== 0) {
    throw new MapgenError(
      `map.png is ${String(image.width)}x${String(image.height)}, which tileSize ${String(
        tileSize,
      )} does not divide exactly on both axes — the tile grid would be ragged`,
    )
  }
  const w = image.width / tileSize
  const h = image.height / tileSize

  // --- markers -------------------------------------------------------------
  const detection = detectMarkers(image, legend)
  const {
    types,
    unmatched,
    warnings: labelWarnings,
  } = matchLabels(detection.markers, legend.labels, tileSize)
  warnings.push(...labelWarnings)

  const spawns: Record<SpawnCategory, SpawnRecord[]> = {
    avatars: [],
    enemies: [],
    props: [],
    chests: [],
  }

  // Every spawn position comes from the glyph centroid — no category is special
  // and the legend never contributes a coordinate.
  for (let i = 0; i < detection.markers.length; i += 1) {
    const marker = detection.markers[i]
    if (!marker) continue
    const tx = Math.floor(marker.cx / tileSize)
    const ty = Math.floor(marker.cy / tileSize)
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
      warnings.push(
        `marker at pixel (${String(Math.round(marker.cx))}, ${String(
          Math.round(marker.cy),
        )}) falls outside the ${String(w)}x${String(h)} tile grid and was dropped`,
      )
      continue
    }
    const spawn: SpawnRecord = { x: tx, y: ty }
    const type = types[i]
    if (type !== undefined) spawn.type = type
    spawns[marker.category].push(spawn)
  }

  for (const category of SPAWN_CATEGORIES) {
    spawns[category].sort((a, b) => a.y - b.y || a.x - b.x || (a.type ?? '').localeCompare(b.type ?? ''))
  }

  for (const unknown of detection.unknownMarkers) {
    warnings.push(
      `unrecognised marker colour ${unknown.colour} at pixel (${String(unknown.x)}, ${String(
        unknown.y,
      )}) — no legend entry claims it`,
    )
  }

  // A cluster painted in a DECLARED marker colour that fails the shape gate is a
  // spawn that did not happen: a glyph drawn touching its own text label merges
  // into one wide cluster, an oversized crosshair overshoots the maximum side.
  // Both used to vanish without a word. Clusters too small to have ever been a
  // glyph are the letter strokes of the text labels — dozens per level — so they
  // are counted rather than listed, and every one of them is still carried in
  // `report.discardedClusters`.
  //
  // Clusters in an UNDECLARED colour are counted separately and described for
  // what they are. They come from a brightness/chroma guess, and on the real
  // asset the overwhelming majority are terrain — bright foliage highlight,
  // flowers — not ink; calling them "text labels" would describe the map itself
  // as annotation. A glyph-sized one is still worth a line each: that is the
  // shape of a marker whose colour the legend forgot but whose geometry drifted
  // outside the shape gate, and the unknown-marker path (which requires a clean
  // glyph) will not have mentioned it.
  let fragments = 0
  let terrainLikeFragments = 0
  for (const cluster of detection.discardedClusters) {
    if (!cluster.glyphCandidate) {
      if (cluster.category === 'unknown') terrainLikeFragments += 1
      else fragments += 1
      continue
    }
    const consequence =
      cluster.category === 'unknown'
        ? 'it is glyph-sized, so it may be a marker whose colour legend.json does not declare'
        : 'a marker may have been lost here'
    warnings.push(
      `discarded a ${cluster.colour} (${cluster.category}) cluster at pixel (${String(
        cluster.x,
      )}, ${String(cluster.y)}), bbox ${String(cluster.w)}x${String(cluster.h)}, ${String(
        cluster.pixels,
      )}px — ${cluster.reason}; ${consequence}`,
    )
  }
  if (fragments > 0) {
    warnings.push(
      `${String(
        fragments,
      )} sub-glyph clusters in declared marker colours were discarded as text ink — see report.discardedClusters for every one`,
    )
  }
  if (terrainLikeFragments > 0) {
    warnings.push(
      `${String(
        terrainLikeFragments,
      )} sub-glyph clusters in undeclared bright colours were ignored — too small to be markers, so they are treated as terrain (foliage highlight, flowers) and left in the terrain average`,
    )
  }

  // Two same-colour glyphs that overlap merge into a single component: one spawn
  // at a centroid belonging to neither, and one enemy gone.
  for (const suspicious of detection.suspiciousClusters) {
    warnings.push(
      `${suspicious.colour} (${suspicious.category}) glyph at pixel (${String(
        suspicious.x,
      )}, ${String(suspicious.y)}) does not look like a single marker: ${
        suspicious.reason
      } — it is probably two overlapping glyphs merged into one spawn`,
    )
  }

  // "Detected nothing" must never be indistinguishable from "there was nothing".
  // A legend tuned to the wrong scale silently produced an empty, valid level.
  for (const count of detection.colourCounts) {
    if (count.glyphs > 0) continue
    warnings.push(
      `no ${count.category} markers were detected for declared colour ${count.colour} (${String(
        count.discarded,
      )} cluster(s) of that colour failed the glyph shape gate) — check legend.json's glyph geometry against this level's scale`,
    )
  }

  for (const label of unmatched) {
    warnings.push(
      `legend label "${label.type}" at (${String(label.at[0])}, ${String(
        label.at[1],
      )}) matched no detected marker`,
    )
  }

  // --- terrain and walkability --------------------------------------------
  // Ink excluded: the annotations are drawn ON the terrain they describe, so
  // averaging them in makes the map disagree with itself.
  const { averages, neighbourFilled, allInk } = tileAverages(
    image,
    tileSize,
    w,
    h,
    detection.inkMask,
  )
  // A tile buried under annotation has no terrain left to measure, so it takes a
  // neighbour's colour — and therefore a neighbour's terrain id and a
  // neighbour's walkability. That is a guess, and an unannounced guess is
  // indistinguishable from a measurement, so it is named here by tile.
  const inkPercent = String(Math.round(MAX_INK_FRACTION * 100))
  if (allInk) {
    warnings.push(
      `every tile of map.png is more than ${inkPercent}% annotation ink, so no tile's terrain could be measured from unpainted pixels — terrain and walkability were derived from averages that include the annotations themselves`,
    )
  } else if (neighbourFilled.length > 0) {
    warnings.push(
      `${String(
        neighbourFilled.length,
      )} tile(s) are more than ${inkPercent}% annotation ink, so their terrain and walkability were taken from the nearest measured neighbour instead of measured — tile(s) at ${formatTileList(
        neighbourFilled,
      )}`,
    )
  }
  const terrain = buildTerrain(averages, legend.walkableMinLuminance)
  const maskPath = join(sourceDir, 'walkable.png')
  let walkable: boolean[][]
  let walkableSource: 'heuristic' | 'mask'
  if (existsSync(maskPath)) {
    const mask = decodePngFile(maskPath, 'walkable.png')
    if (mask.width !== image.width || mask.height !== image.height) {
      throw new MapgenError(
        `walkable.png is ${String(mask.width)}x${String(mask.height)} but map.png is ${String(
          image.width,
        )}x${String(image.height)} — the mask must match the map exactly`,
      )
    }
    walkable = walkableFromMask(mask, tileSize, w, h)
    walkableSource = 'mask'
  } else {
    walkable = buildWalkable(averages, legend.walkableMinLuminance)
    walkableSource = 'heuristic'
    warnings.push(
      'no walkable mask (walkable.png) in the source directory — walkability was ' +
        `derived heuristically from the map image at luminance >= ${String(
          legend.walkableMinLuminance,
        )}, which is a guess, not authored data`,
    )
  }

  warnings.push(...sanityCheckWalkability(walkable, spawns, walkableSource, legend.objectives))

  // --- document ------------------------------------------------------------
  // Key order here IS the on-disk key order; keep it stable.
  const document = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name,
    size: { w, h },
    terrain,
    walkable,
    // Provenance travels WITH the data: "walkability was guessed" is otherwise a
    // console line that scrolls past once, while the grid it describes is
    // checked in and read forever.
    walkableSource,
    spawns: {
      avatars: spawns.avatars,
      enemies: spawns.enemies,
      props: spawns.props,
      chests: spawns.chests,
    },
    objectives: legend.objectives.map((o) => ({ ...o })),
  }

  // Validate through the game's own loader BEFORE writing: an invalid level on
  // disk is worse than no level at all.
  let level: LevelData
  try {
    level = loadLevel(JSON.parse(stableStringify(document)))
  } catch (cause) {
    throw new MapgenError(
      `generated level "${name}" failed validation: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${name}.json`), stableStringify(document))

  return {
    level,
    report: {
      warnings,
      discardedClusters: detection.discardedClusters,
      unknownMarkers: detection.unknownMarkers,
      unmatchedLabels: unmatched,
      suspiciousClusters: detection.suspiciousClusters,
    },
    validated: true,
  }
}
