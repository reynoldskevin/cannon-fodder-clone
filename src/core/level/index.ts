/**
 * Validated `level.json` loader — the boundary between the offline
 * `tools/mapgen` importer and the game.
 *
 * Rules of this boundary:
 *   - Never coerce. A wrong type is a rejection, not a `Number(x)`.
 *   - Never half-load. `loadLevel` either returns a complete `LevelData` or throws.
 *   - Fail on the FIRST problem, naming it precisely — a partial report with a
 *     vague path is worse than one accurate one.
 *   - Never alias the caller's input: the returned data is a defensive copy, so
 *     a mutation upstream can't reach into a loaded level.
 */

import { LevelValidationError } from './errors'
import { CURRENT_SCHEMA_VERSION } from './types'
import type {
  Facing,
  LevelData,
  LevelObjective,
  LevelSize,
  LevelSpawns,
  SpawnPoint,
  TileId,
} from './types'

export { LevelValidationError } from './errors'
export type { LevelValidationCode } from './errors'
export { CURRENT_SCHEMA_VERSION } from './types'
export type {
  Facing,
  LevelData,
  LevelObjective,
  LevelSize,
  LevelSpawns,
  SpawnPoint,
  TileId,
} from './types'

// ---------------------------------------------------------------------------
// Path + primitive helpers
// ---------------------------------------------------------------------------

const fieldPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key)
const indexPath = (parent: string, index: number): string => `${parent}[${index}]`

const fail = (
  code: ConstructorParameters<typeof LevelValidationError>[0],
  path: string,
  detail: string,
): never => {
  throw new LevelValidationError(code, path, detail)
}

/** `typeof x === 'object'` with `null` and arrays excluded. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  // Also how an array hole reads, which is exactly what it is: nothing there.
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'an array'
  return `${typeof value} (${JSON.stringify(value) ?? 'undefined'})`
}

function requireObject(value: unknown, path: string, what: string): Record<string, unknown> {
  if (value === undefined) fail('MISSING_FIELD', path, `${what} is required`)
  if (!isPlainObject(value)) fail('INVALID_TYPE', path, `${what} must be an object, got ${describe(value)}`)
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string, what: string): readonly unknown[] {
  if (value === undefined) fail('MISSING_FIELD', path, `${what} is required`)
  if (!Array.isArray(value)) fail('INVALID_TYPE', path, `${what} must be an array, got ${describe(value)}`)
  return value as readonly unknown[]
}

function requireNonEmptyString(value: unknown, path: string, what: string): string {
  if (value === undefined) fail('MISSING_FIELD', path, `${what} is required`)
  if (typeof value !== 'string') fail('INVALID_TYPE', path, `${what} must be a string, got ${describe(value)}`)
  if ((value as string).length === 0) fail('INVALID_VALUE', path, `${what} must not be empty`)
  return value as string
}

function requirePositiveInt(value: unknown, path: string, what: string): number {
  if (value === undefined) fail('MISSING_FIELD', path, `${what} is required`)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('INVALID_TYPE', path, `${what} must be an integer, got ${describe(value)}`)
  }
  if ((value as number) <= 0) fail('INVALID_VALUE', path, `${what} must be greater than 0, got ${String(value)}`)
  return value as number
}

/**
 * How deep a free-form payload (objective params, unknown spawn fields) may
 * nest before we call it malformed.
 *
 * `JSON.parse` happily accepts thousands of levels of nesting, so a hand-rolled
 * recursive copy of one blows the call stack and throws a raw `RangeError` —
 * escaping the loader's contract that every rejection is a
 * `LevelValidationError`. 64 is far past anything a real level authors, and far
 * short of the engine's stack limit.
 */
const MAX_CLONE_DEPTH = 64

/**
 * Keys that would reach `Object.prototype` rather than the copy if assigned
 * naively. Nothing in the level contract needs them, so drop them explicitly
 * instead of relying on a downstream spread to happen to discard them.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Deep copy of JSON-shaped data, so loaded levels never alias caller state. */
function cloneJsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > MAX_CLONE_DEPTH) {
    fail(
      'INVALID_VALUE',
      path,
      `nested more than ${String(MAX_CLONE_DEPTH)} levels deep; level data must not nest that far`,
    )
  }

  if (Array.isArray(value)) {
    // Index-based, not `.map`: `.map` skips array holes and would copy them
    // through unvalidated.
    const copy: unknown[] = []
    for (let i = 0; i < value.length; i += 1) {
      copy.push(cloneJsonValue(value[i], path, depth + 1))
    }
    return copy
  }

  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue
      copy[key] = cloneJsonValue(entry, path, depth + 1)
    }
    return copy
  }
  return value
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

/**
 * A version mismatch is its own loud failure: an old document silently read as
 * a new one is exactly the silent data corruption this boundary exists to stop.
 */
function parseSchemaVersion(raw: unknown): number {
  if (raw !== CURRENT_SCHEMA_VERSION) {
    fail(
      'SCHEMA_VERSION_MISMATCH',
      'schemaVersion',
      `expected schemaVersion ${String(CURRENT_SCHEMA_VERSION)}, received ${
        raw === undefined ? 'nothing' : describe(raw)
      }`,
    )
  }
  return CURRENT_SCHEMA_VERSION
}

function parseSize(raw: unknown): LevelSize {
  const size = requireObject(raw, 'size', 'size')
  return {
    w: requirePositiveInt(size.w, 'size.w', 'size.w'),
    h: requirePositiveInt(size.h, 'size.h', 'size.h'),
  }
}

/**
 * Shared grid walk for `terrain` and `walkable`: identical dimension rules,
 * only the cell predicate differs.
 */
function parseGrid<T>(
  raw: unknown,
  path: string,
  size: LevelSize,
  parseCell: (cell: unknown, cellPath: string) => T,
): T[][] {
  const rows = requireArray(raw, path, path)
  if (rows.length !== size.h) {
    fail(
      'DIMENSION_MISMATCH',
      path,
      `expected ${String(size.h)} rows to match size.h, got ${String(rows.length)}`,
    )
  }

  // Index-based rather than `.map`: `.map` skips array holes, so a sparse row
  // (`[, , ,]`) would slip past `parseCell` and land in a `readonly number[]`
  // full of holes. JSON can't express holes, but a hand-built level object can.
  const grid: T[][] = []
  for (let y = 0; y < rows.length; y += 1) {
    const rowPath = indexPath(path, y)
    const row = requireArray(rows[y], rowPath, `${path} row ${String(y)}`)
    if (row.length !== size.w) {
      fail(
        'DIMENSION_MISMATCH',
        rowPath,
        `expected ${String(size.w)} columns to match size.w, got ${String(row.length)}`,
      )
    }
    const cells: T[] = []
    for (let x = 0; x < row.length; x += 1) {
      cells.push(parseCell(row[x], indexPath(rowPath, x)))
    }
    grid.push(cells)
  }
  return grid
}

function parseTileId(cell: unknown, cellPath: string): TileId {
  // Open enum: any finite integer is a legal tile id, so `tools/mapgen` can add
  // building tiles (and anything later) without a schemaVersion bump.
  if (typeof cell !== 'number' || !Number.isInteger(cell)) {
    fail('INVALID_TYPE', cellPath, `terrain cell must be an integer tile id, got ${describe(cell)}`)
  }
  return cell as number
}

function parseWalkableCell(cell: unknown, cellPath: string): boolean {
  if (typeof cell !== 'boolean') {
    fail('INVALID_TYPE', cellPath, `walkable cell must be a boolean, got ${describe(cell)}`)
  }
  return cell as boolean
}

/**
 * Spawn coordinates carry a single failure mode from the caller's point of
 * view — "this spawn isn't on a tile of this grid" — so non-integer, negative
 * and past-the-edge all report `SPAWN_OUT_OF_BOUNDS` at the spawn's own path,
 * never at `...[i].x`.
 */
function parseSpawnPoint(raw: unknown, path: string, size: LevelSize): SpawnPoint {
  const spawn = requireObject(raw, path, 'spawn')

  const coord = (value: unknown, axis: 'x' | 'y', limit: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= limit) {
      fail(
        'SPAWN_OUT_OF_BOUNDS',
        path,
        `spawn ${axis} must be an integer in [0, ${String(limit - 1)}], got ${describe(value)}`,
      )
    }
    return value as number
  }

  // Unknown fields ride along verbatim, exactly as objective params do: ticket
  // 018 adds archetype detail and patrol routes to spawns, and a level written
  // by a newer mapgen must not silently lose them when read by older code.
  const point: Record<string, unknown> & { x: number; y: number; type?: string; facing?: Facing } = {
    ...(cloneJsonValue(spawn, path) as Record<string, unknown>),
    x: coord(spawn.x, 'x', size.w),
    y: coord(spawn.y, 'y', size.h),
  }

  // Both optional and both open enums — unknown archetypes are accepted.
  if (spawn.type !== undefined) {
    point.type = requireNonEmptyString(spawn.type, path, 'spawn type')
  }
  if (spawn.facing !== undefined) {
    point.facing = requireNonEmptyString(spawn.facing, path, 'spawn facing')
  }
  return point
}

function parseSpawnList(raw: unknown, path: string, size: LevelSize): SpawnPoint[] {
  // An empty category is legitimate: not every level has chests.
  const list = requireArray(raw, path, path)
  // Index-based so array holes are validated rather than skipped by `.map`.
  const spawns: SpawnPoint[] = []
  for (let i = 0; i < list.length; i += 1) {
    spawns.push(parseSpawnPoint(list[i], indexPath(path, i), size))
  }
  return spawns
}

function parseSpawns(raw: unknown, size: LevelSize): LevelSpawns {
  const spawns = requireObject(raw, 'spawns', 'spawns')
  // DECISION: unknown spawn *categories* (e.g. `spawns.bosses`) are dropped, not
  // preserved. Unlike an extra field on a spawn point, a whole category means
  // entities nothing in the game knows how to place — carrying them through
  // would put unvalidated, un-bounds-checked coordinates into `LevelSpawns` and
  // invite callers to iterate a category the engine cannot spawn. A new category
  // is a structural change and therefore a `schemaVersion` bump, handled here
  // explicitly rather than smuggled in as data.
  return {
    avatars: parseSpawnList(spawns.avatars, 'spawns.avatars', size),
    enemies: parseSpawnList(spawns.enemies, 'spawns.enemies', size),
    chests: parseSpawnList(spawns.chests, 'spawns.chests', size),
  }
}

function parseObjectives(raw: unknown): LevelObjective[] {
  const list = requireArray(raw, 'objectives', 'objectives')
  if (list.length === 0) {
    fail('INVALID_VALUE', 'objectives', 'a level needs at least one objective to be winnable')
  }

  // Index-based so array holes are validated rather than skipped by `.map`.
  const objectives: LevelObjective[] = []
  for (let i = 0; i < list.length; i += 1) {
    const path = indexPath('objectives', i)
    const objective = requireObject(list[i], path, 'objective')
    // `type` is an open enum; the rest of the fields are objective-specific
    // parameters, preserved verbatim for the objective system to interpret.
    const type = requireNonEmptyString(objective.type, fieldPath(path, 'type'), 'objective type')
    objectives.push({ ...(cloneJsonValue(objective, path) as Record<string, unknown>), type })
  }
  return objectives
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `level.json` document and return typed, defensively copied
 * level data.
 *
 * @throws {LevelValidationError} on the first problem found, naming the field.
 */
export function loadLevel(json: unknown): LevelData {
  const doc = requireObject(json, 'level', 'a level document')

  // Version first: if the shape itself is from another era, every field-level
  // complaint below would be noise.
  const schemaVersion = parseSchemaVersion(doc.schemaVersion)
  const name = requireNonEmptyString(doc.name, 'name', 'name')
  const size = parseSize(doc.size)

  return {
    schemaVersion,
    name,
    size,
    terrain: parseGrid(doc.terrain, 'terrain', size, parseTileId),
    walkable: parseGrid(doc.walkable, 'walkable', size, parseWalkableCell),
    spawns: parseSpawns(doc.spawns, size),
    objectives: parseObjectives(doc.objectives),
  }
}
