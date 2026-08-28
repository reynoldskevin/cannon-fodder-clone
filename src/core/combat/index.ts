/**
 * The combat layer (ticket 011): line of sight, rate of fire, damage and death.
 *
 * This is the public face of `src/core/combat`. `app/` registers
 * `createCombatSystem(grid)` on the world and never touches anything else here;
 * FX and audio consume `ShotFired` and `UnitDied` off the event bus and never
 * import from this directory at all.
 *
 * `weapons.ts` is the tuning surface — every number that decides how a firefight
 * feels lives there, and a designer should be able to retune the whole game
 * without opening `los.ts`, `resolution.ts` or `system.ts`. `AIM_CORRIDOR_TILES`
 * (`AIM_TOLERANCE_TILES` until ticket 011c) lives there for exactly that reason:
 * it decides who a commanded round is allowed to hit, so it was a feel number
 * hiding in the mechanism.
 */

export {
  WEAPONS,
  WEAPON_BY_KIND,
  RIFLE,
  ENEMY_RIFLE,
  INFANTRY_HEALTH,
  AIM_CORRIDOR_TILES,
  weaponForKind,
  weaponFor,
} from './weapons'
export type { WeaponSpec } from './weapons'

export { hasLineOfSight, clearFractionAlong } from './los'
export type { SightPoint } from './los'

export {
  applyDamage,
  inRange,
  hitChanceAt,
  createCooldowns,
  readyToFire,
  markFired,
} from './resolution'
export type { Cooldowns } from './resolution'

export { createCombatSystem } from './system'
export type { CombatOptions, CombatSystem } from './system'
