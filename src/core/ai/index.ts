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
export type { AiOptions, AiState, AiSystem, Facing } from './system'

/**
 * The enemy cast list (ticket 018): per-kind stats, on the model of
 * `combat/weapons.ts`. `tuning.ts` keeps the numbers an UNKNOWN kind falls back
 * to; a kind named here overrides them for that unit alone.
 */
export { ARCHETYPES, archetypeFor, DEFAULT_ARCHETYPE_NAME } from './archetypes'
export type { ArchetypeSpec } from './archetypes'

export {
  DEFAULT_SIGHT_RANGE_TILES,
  DEFAULT_ALERT_RADIUS_TILES,
  DEFAULT_PURSUE_TIMEOUT_TICKS,
  DEFAULT_ALERT_TIMEOUT_TICKS,
  DEFAULT_ARRIVAL_TILES,
  // The forward arc (ticket 038). The cosine of its half-angle, the radius
  // inside which it does not apply, and where a man looks before anything has
  // happened to him.
  VISION_HALF_ANGLE_COS,
  DEFAULT_AWARENESS_RADIUS_TILES,
  DEFAULT_ENEMY_FACING,
} from './tuning'
