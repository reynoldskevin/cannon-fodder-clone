/**
 * The `level.json` contract (ARCHITECTURE.md — "Interfaces & data flow").
 *
 * This is the seam between the offline `tools/mapgen` importer and the game.
 * It is deliberately *open* at its extension points: terrain tile ids are plain
 * numbers, objective `type`s and enemy archetype `type`s are plain strings.
 * Adding a building tile, a new objective kind or a new enemy archetype must
 * never require a `schemaVersion` bump — only a genuine *structural* change to
 * the document does.
 */

/**
 * Version of the `level.json` document shape understood by this build.
 *
 * Bump ONLY on a structural break (a field added/removed/retyped). Adding a new
 * tile id, objective type or enemy archetype is not a break — see the note above.
 */
export const CURRENT_SCHEMA_VERSION = 1

/** Grid dimensions in tiles. Both are positive integers. */
export interface LevelSize {
  readonly w: number
  readonly h: number
}

/**
 * A tile id. Open enum: the renderer maps ids it knows to materials and falls
 * back for the rest, so `tools/mapgen` may emit new ids without a schema break.
 */
export type TileId = number

/** Compass facing for a spawned entity. Open: validated as a non-empty string. */
export type Facing = string

/**
 * A spawn point, in tile coordinates. `type` is the archetype (an open enum —
 * `'rifleman'`, `'rocket-trooper'`, ...); ticket 018 extends spawns with
 * archetype details and patrol routes, which land as further fields.
 *
 * Open at the edges the same way `LevelObjective` is: fields this build does
 * not know about are preserved verbatim (deep-copied) rather than dropped, so a
 * level authored by a newer `tools/mapgen` survives a round-trip through older
 * code without silent data loss.
 */
export interface SpawnPoint {
  readonly x: number
  readonly y: number
  readonly type?: string
  readonly facing?: Facing
  readonly [field: string]: unknown
}

/** The three spawn categories. Any category may legitimately be empty. */
export interface LevelSpawns {
  readonly avatars: readonly SpawnPoint[]
  readonly enemies: readonly SpawnPoint[]
  readonly chests: readonly SpawnPoint[]
}

/**
 * A win/lose condition. `type` is an open enum (`'kill_all'`,
 * `'enter_building'`, ...); type-specific parameters ride along as extra
 * fields, which the loader preserves verbatim for the objective system to read.
 */
export interface LevelObjective {
  readonly type: string
  readonly [param: string]: unknown
}

/** A fully validated level, ready to build a `World` from. */
export interface LevelData {
  readonly schemaVersion: number
  readonly name: string
  readonly size: LevelSize
  /** `size.h` rows of `size.w` tile ids. */
  readonly terrain: readonly (readonly TileId[])[]
  /** `size.h` rows of `size.w` passability flags, parallel to `terrain`. */
  readonly walkable: readonly (readonly boolean[])[]
  readonly spawns: LevelSpawns
  /** At least one — a level with no objectives cannot be won. */
  readonly objectives: readonly LevelObjective[]
}
