/**
 * The AI layer (ticket 012): the enemy state machine that makes a level fight
 * back.
 *
 * This is the public face of `src/core/ai`. The session builds one
 * `createAiSystem(grid, { squad, combat })`, registers it FIRST — before squad
 * and combat, so an order given this tick moves the man this tick and a halt
 * lands before the movement it cancels — and feeds it the event batch it
 * drained. Nothing above this directory needs to know that a pursuit is a squad
 * order or that opening fire is the same `orderFire` the player's pointer uses.
 *
 * `tuning.ts` is the behaviour surface — sight, hearing, patience — on the model
 * of `combat/weapons.ts`: a designer should be able to retune how the enemy
 * behaves without opening `system.ts`.
 *
 * Engine-free and clock-free like the rest of `src/core`, and rng-free besides:
 * the machine is a pure function of world state, which is what lets a whole
 * firefight be asserted against an ASCII picture of a map in plain Vitest.
 */

export { createAiSystem, AI_STATES } from './system'
export type { AiOptions, AiState, AiSystem } from './system'

export {
  DEFAULT_SIGHT_RANGE_TILES,
  DEFAULT_ALERT_RADIUS_TILES,
  DEFAULT_PURSUE_TIMEOUT_TICKS,
  DEFAULT_ALERT_TIMEOUT_TICKS,
  DEFAULT_ARRIVAL_TILES,
} from './tuning'
