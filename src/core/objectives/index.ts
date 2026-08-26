/**
 * The objectives layer (ticket 013): what wins a mission, what loses one, and
 * the two events that say so.
 *
 * This is the public face of `src/core/objectives`. The session builds one
 * `createObjectiveSystem(level)` and registers it LAST, after the systems whose
 * results it judges; `src/ui/hud.ts` reads `progress()` and `elapsedTicks` and
 * `src/app/main.ts` reads `outcome()` to end the mission. Nothing above this directory needs
 * to know how a `reach_area` is measured or where a death is counted.
 *
 * `types.ts` is the data surface — the type names, the parameter names, the
 * sentence a lost mission is reported with — on the model of `combat/weapons.ts`
 * and `ai/tuning.ts`: adding an objective type is a table edit and one
 * evaluator, not a read of the whole layer looking for where the strings live.
 *
 * Engine-free and clock-free like the rest of `src/core`. The mission timer is
 * the simulation's tick count for that reason and is better for it: exact,
 * identical across replays, and still right when a frame stalls.
 */

export { createObjectiveSystem } from './system'

export {
  countLiving,
  evaluateMission,
  evaluateObjective,
  missionWon,
} from './evaluation'
export type { MissionTally } from './evaluation'

export { OBJECTIVE_TYPES, OBJECTIVE_PARAMS, SQUAD_WIPED_OUT } from './types'
export type { MissionOutcome, ObjectiveProgress, ObjectiveSystem, ObjectiveType } from './types'
