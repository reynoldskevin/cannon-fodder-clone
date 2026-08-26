/**
 * `src/core/armoury` — what the squad is carrying (ticket 016).
 *
 * The public face of the pouch: one count per ordnance type for the WHOLE
 * squad, which weapon is held, and the pure model the HUD selector draws.
 * `command/apply.ts` spends from it, `createSession` builds it, `src/ui/hud.ts`
 * renders `slots()` through `selectorLine`, and `src/app/main.ts` reads
 * `selected` when it builds a `fire` command.
 *
 * Engine-free like the rest of `src/core`: no `three`, no DOM, no wall clock,
 * no random draw. Every decision the selector makes is testable under Node,
 * which is the entire reason it is here and not in `hud.ts`.
 */

export { createArmoury } from './armoury'
export type { Armoury, ArmouryOptions } from './armoury'

export {
  DEFAULT_LOADOUT,
  ORDNANCE_ORDER,
  RIFLE_ORDNANCE,
  labelFor,
  ordnanceForHotkey,
  selectorLine,
} from './loadout'
export type { ArmourySlot } from './loadout'
