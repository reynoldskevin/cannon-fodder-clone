/**
 * Typed failure for the `level.json` boundary.
 *
 * Every rejection names the offending field with a dotted/indexed `path`
 * (`spawns.enemies[2]`, `terrain[1]`) and a machine-readable `code`, and repeats
 * the path in the message so a bare `console.error(err)` is self-describing.
 */

/** Machine-readable failure reasons. Three are pinned by the loader's contract. */
export type LevelValidationCode =
  /** The document declares a `schemaVersion` this build does not understand. */
  | 'SCHEMA_VERSION_MISMATCH'
  /** A grid's row/column count disagrees with `size`. */
  | 'DIMENSION_MISMATCH'
  /** A spawn sits outside the grid, or is not on an integer tile. */
  | 'SPAWN_OUT_OF_BOUNDS'
  /** A required field is absent. */
  | 'MISSING_FIELD'
  /** A field is present but of the wrong type or shape. */
  | 'INVALID_TYPE'
  /** A field is structurally valid but semantically unusable (e.g. no objectives). */
  | 'INVALID_VALUE'

export class LevelValidationError extends Error {
  override readonly name = 'LevelValidationError'
  readonly code: LevelValidationCode
  /** Dotted/indexed path to the offending field, e.g. `spawns.avatars[0]`. */
  readonly path: string

  constructor(code: LevelValidationCode, path: string, detail: string) {
    super(`level.json invalid at "${path}" [${code}]: ${detail}`)
    this.code = code
    this.path = path
  }
}
