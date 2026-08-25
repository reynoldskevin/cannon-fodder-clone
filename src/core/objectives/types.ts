/**
 * THE OBJECTIVE DATA SURFACE (ticket 013).
 *
 * Everything that says WHAT a mission type is called, which parameter names it
 * reads out of the level document, and what the player is told when a mission
 * is lost, lives here as plain data — on the model of `combat/weapons.ts`.
 * `evaluation.ts` and `system.ts` hold the mechanism and not one objective
 * string between them, so adding a type is a table edit plus one evaluator
 * rather than a read of the whole directory looking for where the names hide.
 *
 * `LevelObjective.type` STAYS AN OPEN ENUM. The schema declares it open (the
 * buildings extension point depends on it) and this file does not close it: the
 * four names below are the ones this build can EVALUATE, and anything else is a
 * document from the future rather than a corrupt one. It reports
 * `supported: false`, is visible in the HUD as such, and can never complete.
 */

import type { SimSystem } from '../world/world'

/**
 * The objective types this build evaluates.
 *
 * A frozen tuple rather than a union type alone, because the HUD and the tests
 * both want to enumerate them at runtime — "which of these does this build
 * understand" is a question with an answer, and deriving it from a `switch` is
 * not possible.
 */
export const OBJECTIVE_TYPES = Object.freeze([
  'kill_all',
  'kill_count',
  'collect_chests',
  'reach_area',
] as const)

/** One of the four names above. Level documents may carry others; see the note. */
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number]

/**
 * The parameter names read off a `LevelObjective`.
 *
 * Named here rather than spelled inline in the evaluators so the document
 * contract is readable in one place: these strings are the level format, and a
 * typo in one of them is an objective that silently reads `undefined` and
 * reports itself unsupported.
 */
export const OBJECTIVE_PARAMS = Object.freeze({
  /** `kill_count` and `collect_chests`: how many. */
  count: 'count',
  /** `reach_area`: the tile to reach, in TILE coordinates naming a tile CENTRE. */
  x: 'x',
  y: 'y',
  /** `reach_area`: how close counts, in tiles. */
  radius: 'radius',
})

/**
 * What the player is told when the squad is wiped out.
 *
 * A string on `MissionFailed` rather than a code, because it is shown: the
 * event is the only thing that knows why the mission ended, and a UI that had
 * to map codes to sentences would be a second table to keep in step.
 */
export const SQUAD_WIPED_OUT = 'Your squad was wiped out.'

/** How a mission stands right now. Three states, and it never leaves the last two. */
export type MissionOutcome = 'playing' | 'complete' | 'failed'

/**
 * One objective's standing, as the HUD draws it.
 *
 * `done`/`total` RATHER THAN A BOOLEAN ALONE, because "3 of 5" is what the
 * player reads every frame: an objective that is merely `complete: false` tells
 * him nothing about whether he is winning. Types with no natural count report
 * 0/1 and 1/1, which is the same statement made about a thing that either has
 * happened or has not.
 */
export interface ObjectiveProgress {
  /** The level's own `type` string, verbatim — including one this build cannot evaluate. */
  readonly type: string
  /** Whether this build knows how to evaluate `type` AND has the data it needs. */
  readonly supported: boolean
  readonly complete: boolean
  readonly done: number
  readonly total: number
}

/**
 * The per-tick objective pass, with the mission state attached.
 *
 * A callable object, exactly like `SquadSystem` and `CombatSystem`: it is
 * registered with `world.addSystem`, which wants a plain `SimSystem`, and the
 * HUD needs somewhere to read progress from. Splitting them would hand callers
 * two halves of one piece of state and trust them to keep the pair together.
 */
export interface ObjectiveSystem extends SimSystem {
  /** Every objective the level lists, in the level's order. Stable between ticks. */
  progress(): readonly ObjectiveProgress[]
  /** The mission's standing. Latched: once it leaves `'playing'` it never changes. */
  outcome(): MissionOutcome
  /**
   * Record one chest collected.
   *
   * PUSHED IN, NOT READ OUT. Chests are ticket 017 and nothing collects one
   * yet; when something does, it is the pickup that knows a chest was taken,
   * not this system. Until then a `collect_chests` mission reports honest
   * partial progress and is simply not winnable, which is the failure that
   * looks like a failure.
   */
  collectChest(): void
  /**
   * Ticks this mission has been played for — the timer the HUD shows, divided
   * by the fixed timestep.
   *
   * THE SIM'S OWN CLOCK, not a wall clock. `src/core` may not read one at all,
   * and that rule is the right one here for its own sake: a tick count is exact,
   * identical across replays, and still correct when a frame stalls, where a
   * `performance.now()` in the HUD would drift away from the mission it claims
   * to be timing. It stops when the mission does.
   */
  readonly elapsedTicks: number
}
