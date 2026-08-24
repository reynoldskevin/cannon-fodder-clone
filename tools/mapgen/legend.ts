/**
 * `legend.json` — the per-level declaration that turns pixels into meaning.
 *
 * The importer knows *nothing* about which colour means what: that mapping, the
 * tile size, the colour tolerance and the per-marker type labels all come from
 * the level's own legend, so a new annotation colour or a new prop is a data
 * change rather than a code change.
 *
 * ```json
 * {
 *   "tileSize": 16,
 *   "colourTolerance": 40,
 *   "markerColours": { "60,160,255": "avatars", "255,60,60": "enemies" },
 *   "labels": [{ "at": [804, 437], "type": "bird_left", "category": "props" }],
 *   "objectives": [{ "type": "kill_all" }],
 *   "glyph": { "side": 25, "minSide": 15, "maxSide": 40, "minPixels": 40, "maxPixels": 400 },
 *   "walkableMinLuminance": 55
 * }
 * ```
 *
 * `glyph` and `walkableMinLuminance` are optional and default to the level-1
 * convention; they exist so a level annotated at a different scale, or painted
 * from a different palette, is a data change rather than a code change.
 */

import { readFileSync } from 'node:fs'
import { MapgenError } from './errors'
import type { RGB } from './image'
import { colourDistance, formatColour } from './image'

/** The spawn categories a legend may target — the `LevelSpawns` categories. */
export const SPAWN_CATEGORIES = ['avatars', 'enemies', 'props', 'chests'] as const
export type SpawnCategory = (typeof SPAWN_CATEGORIES)[number]

export interface MarkerColour {
  readonly colour: RGB
  readonly category: SpawnCategory
}

/**
 * A hand-authored annotation of one marker: "the glyph at roughly (804, 437) is
 * a `bird_left`". The image cannot tell us this — the drawn text label beside
 * the glyph is anti-aliased over noisy terrain and is not reliably readable, and
 * this importer deliberately does no OCR.
 */
export interface LegendLabel {
  readonly at: readonly [number, number]
  readonly type: string
  /**
   * Which spawn category this label is talking about, when the author states it.
   *
   * Optional for compatibility with legends written before category scoping
   * existed, but strongly preferred: a label that declares its category can only
   * ever attach to a marker of that category, which makes it impossible for a
   * `tree` to land on an avatar because it happened to be drawn nearby. An
   * unscoped label still matches by distance, and the importer warns about every
   * such match so the ambiguity is visible rather than silent.
   */
  readonly category?: SpawnCategory
}

/**
 * The geometry of one annotation glyph, in pixels.
 *
 * These used to be absolute constants derived from level 1's 25px crosshair,
 * which quietly made the importer level-1-specific: a map annotated at a
 * different scale detected nothing at all and, worse, said nothing about it.
 * They are legend data now — every field optional, defaulting to the level-1
 * convention — so a differently-scaled level is a data change.
 */
export interface GlyphShape {
  /** Nominal side of a crosshair. Used to flag suspiciously large clusters. */
  readonly side: number
  readonly minSide: number
  readonly maxSide: number
  readonly minPixels: number
  readonly maxPixels: number
  /** min(w,h)/max(w,h) floor — text labels are ~0.25, crosshairs ~1.0. */
  readonly minSquareness: number
}

export interface Legend {
  readonly tileSize: number
  readonly colourTolerance: number
  /** Sorted by colour string, so iteration order never depends on JSON order. */
  readonly markerColours: readonly MarkerColour[]
  readonly labels: readonly LegendLabel[]
  readonly objectives: readonly { readonly type: string; readonly [param: string]: unknown }[]
  readonly glyph: GlyphShape
  /**
   * Rec. 601 luma at or above which a tile is walkable, when walkability is
   * derived heuristically. Declarative for the same reason the glyph geometry
   * is: it is tuned to one level's art, and a different palette needs a
   * different cut.
   */
  readonly walkableMinLuminance: number
}

const DEFAULT_TILE_SIZE = 16
const DEFAULT_TOLERANCE = 40

/** The level-1 annotation convention: a ~25x25 crosshair outline. */
const DEFAULT_GLYPH_SHAPE: GlyphShape = {
  side: 25,
  minSide: 15,
  maxSide: 40,
  minPixels: 40,
  maxPixels: 400,
  minSquareness: 0.6,
}

const DEFAULT_WALKABLE_MIN_LUMINANCE = 55
/** A level with no stated objective still has to be winnable. */
const DEFAULT_OBJECTIVES = [{ type: 'kill_all' }] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSpawnCategory(value: unknown): value is SpawnCategory {
  return typeof value === 'string' && (SPAWN_CATEGORIES as readonly string[]).includes(value)
}

/** `"60,160,255"` -> `[60, 160, 255]`. */
function parseColourKey(key: string, path: string): RGB {
  const parts = key.split(',').map((p) => p.trim())
  if (parts.length !== 3) {
    throw new MapgenError(`${path}: marker colour key must be "r,g,b", got "${key}"`)
  }
  const channels = parts.map((p) => Number(p))
  for (const c of channels) {
    if (!Number.isInteger(c) || c < 0 || c > 255) {
      throw new MapgenError(`${path}: marker colour key must be three 0-255 integers, got "${key}"`)
    }
  }
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0]
}

function parsePositiveInt(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new MapgenError(`${path} must be a positive integer, got ${JSON.stringify(value) ?? 'undefined'}`)
  }
  return value
}

function parseLabels(raw: unknown, path: string): LegendLabel[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new MapgenError(`${path} must be an array`)

  const labels: LegendLabel[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const entry: unknown = raw[i]
    const at = `${path}[${String(i)}]`
    if (!isPlainObject(entry)) throw new MapgenError(`${at} must be an object`)
    const position = entry.at
    if (
      !Array.isArray(position) ||
      position.length !== 2 ||
      typeof position[0] !== 'number' ||
      typeof position[1] !== 'number' ||
      !Number.isFinite(position[0]) ||
      !Number.isFinite(position[1])
    ) {
      throw new MapgenError(`${at}.at must be a [x, y] pixel position`)
    }
    if (typeof entry.type !== 'string' || entry.type.length === 0) {
      throw new MapgenError(`${at}.type must be a non-empty string`)
    }
    if (entry.category !== undefined && !isSpawnCategory(entry.category)) {
      throw new MapgenError(
        `${at}.category must be one of ${SPAWN_CATEGORIES.join(', ')} when present, got ${
          JSON.stringify(entry.category) ?? 'undefined'
        }`,
      )
    }
    const label: LegendLabel = isSpawnCategory(entry.category)
      ? { at: [position[0], position[1]], type: entry.type, category: entry.category }
      : { at: [position[0], position[1]], type: entry.type }
    labels.push(label)
  }
  return labels
}

function parsePositiveNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MapgenError(
      `${path} must be a positive number, got ${JSON.stringify(value) ?? 'undefined'}`,
    )
  }
  return value
}

function parseGlyphShape(raw: unknown, path: string): GlyphShape {
  if (raw === undefined) return DEFAULT_GLYPH_SHAPE
  if (!isPlainObject(raw)) throw new MapgenError(`${path} must be an object when present`)

  const shape: GlyphShape = {
    side: parsePositiveNumber(raw.side, DEFAULT_GLYPH_SHAPE.side, `${path}.side`),
    minSide: parsePositiveNumber(raw.minSide, DEFAULT_GLYPH_SHAPE.minSide, `${path}.minSide`),
    maxSide: parsePositiveNumber(raw.maxSide, DEFAULT_GLYPH_SHAPE.maxSide, `${path}.maxSide`),
    minPixels: parsePositiveNumber(raw.minPixels, DEFAULT_GLYPH_SHAPE.minPixels, `${path}.minPixels`),
    maxPixels: parsePositiveNumber(raw.maxPixels, DEFAULT_GLYPH_SHAPE.maxPixels, `${path}.maxPixels`),
    minSquareness: parsePositiveNumber(
      raw.minSquareness,
      DEFAULT_GLYPH_SHAPE.minSquareness,
      `${path}.minSquareness`,
    ),
  }
  if (shape.minSide > shape.maxSide) {
    throw new MapgenError(
      `${path}.minSide (${String(shape.minSide)}) must not exceed maxSide (${String(shape.maxSide)})`,
    )
  }
  if (shape.minPixels > shape.maxPixels) {
    throw new MapgenError(
      `${path}.minPixels (${String(shape.minPixels)}) must not exceed maxPixels (${String(
        shape.maxPixels,
      )})`,
    )
  }
  if (shape.minSquareness > 1) {
    throw new MapgenError(`${path}.minSquareness must be in (0, 1], got ${String(shape.minSquareness)}`)
  }
  return shape
}

/**
 * Two declared marker colours close enough to share pixels are FATAL.
 *
 * Detection runs one mask per declared colour, so a pixel within tolerance of
 * two of them is claimed twice: one crosshair silently becomes both an enemy and
 * a chest at the same tile. The mask test is `distance <= tolerance` around each
 * colour, so overlap is possible whenever the two colours are within *twice* the
 * tolerance of each other — that, not the tolerance itself, is the real safety
 * margin, and getting it wrong duplicates data rather than losing it.
 */
function assertColoursSeparated(colours: readonly MarkerColour[], tolerance: number, path: string): void {
  const minSeparation = tolerance * 2
  for (let i = 0; i < colours.length; i += 1) {
    for (let j = i + 1; j < colours.length; j += 1) {
      const a = colours[i]
      const b = colours[j]
      if (!a || !b) continue
      const distance = colourDistance(a.colour, b.colour)
      if (distance <= minSeparation) {
        throw new MapgenError(
          `${path}: markerColours "${formatColour(a.colour)}" (${a.category}) and "${formatColour(
            b.colour,
          )}" (${b.category}) are only ${String(distance)} apart, within the ${String(
            minSeparation,
          )} needed to keep their masks disjoint at colourTolerance ${String(
            tolerance,
          )} — one glyph would be detected as both`,
        )
      }
    }
  }
}

function parseObjectives(raw: unknown, path: string): Legend['objectives'] {
  if (raw === undefined) return DEFAULT_OBJECTIVES.map((o) => ({ ...o }))
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MapgenError(`${path} must be a non-empty array when present`)
  }
  return raw.map((entry: unknown, i) => {
    if (!isPlainObject(entry) || typeof entry.type !== 'string' || entry.type.length === 0) {
      throw new MapgenError(`${path}[${String(i)}] must be an object with a non-empty "type"`)
    }
    return { ...entry, type: entry.type }
  })
}

export function parseLegend(json: unknown, path: string): Legend {
  if (!isPlainObject(json)) throw new MapgenError(`${path} must contain a JSON object`)

  const markerColoursRaw = json.markerColours
  if (!isPlainObject(markerColoursRaw)) {
    throw new MapgenError(`${path}: markerColours must be an object of "r,g,b" -> category`)
  }

  const markerColours: MarkerColour[] = []
  // Sorted so detection order — and therefore the report — never depends on the
  // key order the legend happened to be written in.
  for (const key of Object.keys(markerColoursRaw).sort()) {
    const category: unknown = markerColoursRaw[key]
    if (!isSpawnCategory(category)) {
      throw new MapgenError(
        `${path}: markerColours["${key}"] must be one of ${SPAWN_CATEGORIES.join(', ')}, got ${
          JSON.stringify(category) ?? 'undefined'
        }`,
      )
    }
    markerColours.push({ colour: parseColourKey(key, path), category })
  }

  const colourTolerance = parsePositiveInt(
    json.colourTolerance,
    DEFAULT_TOLERANCE,
    `${path}: colourTolerance`,
  )
  assertColoursSeparated(markerColours, colourTolerance, path)

  return {
    tileSize: parsePositiveInt(json.tileSize, DEFAULT_TILE_SIZE, `${path}: tileSize`),
    colourTolerance,
    markerColours,
    labels: parseLabels(json.labels, `${path}: labels`),
    objectives: parseObjectives(json.objectives, `${path}: objectives`),
    glyph: parseGlyphShape(json.glyph, `${path}: glyph`),
    walkableMinLuminance: parsePositiveNumber(
      json.walkableMinLuminance,
      DEFAULT_WALKABLE_MIN_LUMINANCE,
      `${path}: walkableMinLuminance`,
    ),
  }
}

export function readLegendFile(path: string): Legend {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new MapgenError(`legend.json is missing or unreadable: ${path}`, { cause })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new MapgenError(`legend.json is not valid JSON: ${path}`, { cause })
  }
  return parseLegend(json, path)
}
