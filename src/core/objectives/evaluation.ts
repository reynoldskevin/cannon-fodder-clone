/**
 * Objective evaluation (ticket 013): one pure function per mission type, and
 * the rule that decides when a whole mission is won.
 *
 * PURE READS, ALL OF THEM. Nothing here mutates the world, emits an event or
 * keeps state between calls; everything an objective needs that is not visible
 * in the world right now arrives in the `MissionTally` the system carries. That
 * is what lets the same function be called every tick without the mission
 * drifting, and what lets `system.ts` be about the latch and the two events and
 * nothing else.
 *
 * WHAT AN OBJECTIVE MAY READ, and why it is a short list. The world's living
 * entities, the level document, and the tally. Not the event bus: draining it
 * here would starve the HUD, FX and audio of the batch the session owns (see
 * the note on `ObjectiveState.observe` in `system.ts`), and not a clock, which
 * `src/core` may not touch at all.
 */

import { OBJECTIVE_PARAMS } from './types'
import { TILE_WORLD_SIZE, tileToWorld } from '../view/projection'
import type { ObjectiveProgress } from './types'
import type { LevelData, LevelObjective } from '../level/types'
import type { Team, World } from '../world/world'

/**
 * The running totals an objective cannot see by looking at the world.
 *
 * `enemyDeaths` is here rather than derived from "how many enemies the level
 * spawned minus how many are left" because a `kill_count` mission must not be
 * advanced by an enemy that left the field for any other reason, and because
 * the level's spawn list is not the whole story the moment anything spawns a
 * reinforcement.
 */
export interface MissionTally {
  /** `UnitDied` events seen for enemy-team units, over the whole mission. */
  readonly enemyDeaths: number
  /** Chests collected, as reported by `ObjectiveSystem.collectChest`. */
  readonly chestsCollected: number
}

/**
 * Living units on a team, counted over `world.entities` — spawn order, stable.
 *
 * `null` is a mission that has not started: `createObjectiveSystem` is handed
 * the level and no world at all, and the objectives it reports before the first
 * tick have to say something. Zero, which is the truth about a world that does
 * not exist yet.
 */
export function countLiving(world: World | null, team: Team): number {
  if (world === null) return 0
  const entities = world.entities
  let living = 0
  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i]
    if (entity === undefined) continue
    if (entity.team === team) living += 1
  }
  return living
}

/**
 * A numeric parameter off a level objective, or `undefined` when it is absent
 * or not a finite number.
 *
 * `LevelObjective` is an index signature of `unknown` — that is what keeps the
 * document open — so every parameter read is a narrowing, and a missing one has
 * to be a first-class answer rather than a `NaN` that propagates into a
 * comparison and quietly reports "not yet" forever.
 */
function numberParam(objective: LevelObjective, name: string): number | undefined {
  const value = objective[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A progress record, in the one place its shape is written down. */
function progressOf(
  type: string,
  supported: boolean,
  done: number,
  total: number,
  complete: boolean,
): ObjectiveProgress {
  return { type, supported, done, total, complete }
}

/** An objective this build cannot evaluate: visible, honest, and never complete. */
function unsupported(type: string): ObjectiveProgress {
  return progressOf(type, false, 0, 0, false)
}

/**
 * `kill_all` — no living unit on the enemy team.
 *
 * COMPLETION IS THE LIVING COUNT, NOT THE DEATH TALLY. The two agree in every
 * ordinary mission and disagree in the two that matter: an enemy removed
 * without dying would leave a death-counted mission unwinnable, and a level
 * that spawns no enemy at all is a mission already won rather than one that can
 * never end. The tally is used only for the `done` the HUD draws, which is what
 * the player understands by "3 of 5 killed".
 */
function killAll(
  objective: LevelObjective,
  level: LevelData,
  world: World | null,
  tally: MissionTally,
): ObjectiveProgress {
  // Before the first tick there is no world to survey, so the total is what the
  // level PROMISES to spawn and nothing is complete — a `kill_all` reporting
  // itself already met because nobody had been placed yet would be a won
  // mission on screen for a frame.
  if (world === null) return progressOf(objective.type, true, 0, level.spawns.enemies.length, false)
  const living = countLiving(world, 'enemy')
  return progressOf(objective.type, true, tally.enemyDeaths, living + tally.enemyDeaths, living === 0)
}

/**
 * `kill_count` — that many enemy deaths, and no more asked for.
 *
 * The whole difference from `kill_all` is that it completes with enemies still
 * standing, which is why it is counted rather than surveyed.
 */
function killCount(objective: LevelObjective, tally: MissionTally): ObjectiveProgress {
  const count = numberParam(objective, OBJECTIVE_PARAMS.count)
  if (count === undefined || count <= 0) return unsupported(objective.type)
  const done = Math.min(tally.enemyDeaths, count)
  return progressOf(objective.type, true, done, count, tally.enemyDeaths >= count)
}

/**
 * `collect_chests` — that many chests collected, defaulting to every chest the
 * level spawns.
 *
 * A LEVEL WITH NO CHESTS IS UNSUPPORTED, NOT ALREADY DONE. Zero of zero reads
 * as complete under every reasonable arithmetic, and a mission handed to the
 * player for doing nothing is the single worst way for this to fail — it looks
 * like success. An objective that says it cannot be evaluated is read as the
 * gap it is.
 */
function collectChests(objective: LevelObjective, level: LevelData, tally: MissionTally): ObjectiveProgress {
  const total = numberParam(objective, OBJECTIVE_PARAMS.count) ?? level.spawns.chests.length
  if (total <= 0) return unsupported(objective.type)
  const done = Math.min(tally.chestsCollected, total)
  return progressOf(objective.type, true, done, total, tally.chestsCollected >= total)
}

/**
 * `reach_area` — a LIVING PLAYER unit within `radius` tiles of a tile.
 *
 * THE COORDINATE CONVENTION, AND IT IS THE ONE THING TO GET RIGHT HERE.
 * Integer tile coordinates name tile CENTRES, and a level is centred on the
 * world origin, so the objective's tile is placed with `tileToWorld` — the same
 * function `World.spawnFromLevel` places every unit with — and the comparison is
 * made in WORLD units. Re-deriving the mapping by hand is how a target ends up
 * half a tile out on both axes, which is invisible on an open field and decides
 * the mission on a doorway.
 *
 * HELD, NOT TOUCHED ONCE. A man who reached the area and then left has not
 * reached it, and a corpse lying on the spot is not a squad that got there —
 * this is a survey of where the living squad is standing right now, which is
 * also what makes it a pure function of the world.
 */
function reachArea(
  objective: LevelObjective,
  level: LevelData,
  world: World | null,
): ObjectiveProgress {
  const tileX = numberParam(objective, OBJECTIVE_PARAMS.x)
  const tileY = numberParam(objective, OBJECTIVE_PARAMS.y)
  const radius = numberParam(objective, OBJECTIVE_PARAMS.radius)
  // A NON-POSITIVE RADIUS IS UNSUPPORTED, not a small one. `radius: -2` squares
  // to the same 4 as `radius: 2` and would behave as an area twice the size the
  // document asks for — a mission quietly won two tiles early, which is exactly
  // the silent misreading `supported: false` exists to make visible. Consistent
  // with `kill_count` and `collect_chests`, which reject their counts the same
  // way: a parameter that cannot mean what it says is a document this build
  // cannot evaluate.
  if (tileX === undefined || tileY === undefined || radius === undefined || radius <= 0) {
    return unsupported(objective.type)
  }
  const centre = tileToWorld(tileX, tileY, level.size)
  // Squared, so no square root and no float comparison that depends on which
  // way the distance was computed. Both sides are in world units.
  const reach = radius * TILE_WORLD_SIZE
  const reachSq = reach * reach
  const entities = world === null ? [] : world.entities
  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i]
    if (entity === undefined || entity.team !== 'player') continue
    const dx = entity.x - centre.x
    const dz = entity.z - centre.z
    if (dx * dx + dz * dz <= reachSq) return progressOf(objective.type, true, 1, 1, true)
  }
  return progressOf(objective.type, true, 0, 1, false)
}

/**
 * Evaluate one objective against the world as it stands right now.
 *
 * A `null` world is the mission before its first tick: every evaluator answers
 * it off the level document alone, so there is ONE table of types here and not
 * a second one describing how a mission starts.
 */
export function evaluateObjective(
  objective: LevelObjective,
  level: LevelData,
  world: World | null,
  tally: MissionTally,
): ObjectiveProgress {
  switch (objective.type) {
    case 'kill_all':
      return killAll(objective, level, world, tally)
    case 'kill_count':
      return killCount(objective, tally)
    case 'collect_chests':
      return collectChests(objective, level, tally)
    case 'reach_area':
      return reachArea(objective, level, world)
    default:
      return unsupported(objective.type)
  }
}

/** Evaluate the whole mission, in the level's order. Frozen: the HUD only reads it. */
export function evaluateMission(
  level: LevelData,
  world: World | null,
  tally: MissionTally,
): readonly ObjectiveProgress[] {
  const out: ObjectiveProgress[] = []
  for (const objective of level.objectives) {
    out.push(evaluateObjective(objective, level, world, tally))
  }
  return Object.freeze(out)
}

/**
 * Whether this mission is won.
 *
 * EVERY OBJECTIVE, AND EVERY ONE OF THEM SUPPORTED. Not "every objective this
 * build understands", which is the reading that hands the mission to a player
 * whose level lists only `destroy_the_radio_mast`: zero supported objectives
 * are all complete, vacuously, and he wins by loading the map. A mission
 * carrying an objective this build cannot evaluate is not winnable, which is
 * exactly what a `collect_chests` level is until ticket 017 — visible in the
 * HUD as an objective that never fills, rather than a silent victory.
 *
 * A level with no objectives at all is likewise not won; `core/level` rejects
 * one anyway, so this is a second lock on the same door.
 */
export function missionWon(progress: readonly ObjectiveProgress[]): boolean {
  if (progress.length === 0) return false
  return progress.every((p) => p.supported && p.complete)
}
