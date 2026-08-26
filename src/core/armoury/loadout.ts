/**
 * What the squad can be holding, and how the selector reads (ticket 016).
 *
 * THE DECISION IS PURE AND LIVES HERE; THE DRAWING LIVES IN `src/ui/hud.ts`.
 * Vitest runs `environment: 'node'`, so there is no DOM at test time and nothing
 * in `src/ui` is unit-tested at all — a selector built inside `hud.ts` would
 * ship with its acceptance criterion ("shows the active type and remaining
 * counts") verifiable only by looking at the screen. This is the same split
 * ticket 014 made between `core/debug/layers.ts` and `ui/debug-panel.ts`, for
 * the same reason.
 *
 * THE RIFLE IS IN THE LIST AND IS NOT AMMUNITION. It is unlimited, it is a
 * standing order down `CombatSystem.orderFire`, and it is the whole of the
 * game's offensive vocabulary today. Keeping it in this list is what lets the
 * selector cycle back to it; keeping it out of the counting is what stops this
 * ticket from being able to break it.
 */

import { ORDNANCE } from '../ordnance'

/** The name a `fire` command carries when it means the rifle, not ordnance. */
export const RIFLE_ORDNANCE = 'rifle'

/**
 * Every weapon the selector lists, in the order it lists them: the rifle, then
 * the `ORDNANCE` table's rows.
 *
 * EVERY KNOWN WEAPON, NOT EVERY STOCKED ONE. A selector that hid what you had
 * run out of would make the weapon vanish from the game with no explanation of
 * where it went; being told "no grenades" at the moment of firing is how a
 * player learns they are empty.
 *
 * `Object.keys` over a plain object is insertion order for string keys, which
 * is why `ORDNANCE` is an object and not a `Map` — see its own header. So this
 * order is the table's authored order and is the same twice.
 */
export const ORDNANCE_ORDER: readonly string[] = Object.freeze([
  RIFLE_ORDNANCE,
  ...Object.keys(ORDNANCE),
])

/**
 * What a fresh squad carries, non-zero for both weapons so a mission can
 * actually throw something.
 *
 * A TUNING VALUE, and it lives beside the selector rather than inside
 * `createArmoury` because a level document may name its own counts — see
 * `SessionOptions.ammo`, which supplies these when it does not. Ticket 017's
 * chests replenish the same counts through `grant`.
 */
export const DEFAULT_LOADOUT: Readonly<Record<string, number>> = Object.freeze({
  grenade: 4,
  rocket: 2,
})

/**
 * One row of the on-screen selector: everything the HUD needs and nothing it
 * has to decide.
 */
export interface ArmourySlot {
  /** The `fire` command's `ordnance`, and the key into `ORDNANCE`. */
  readonly ordnance: string
  /** What the selector calls it on screen. */
  readonly label: string
  /** Rounds left. Meaningless for an `unlimited` slot; see `count`. */
  readonly count: number
  /** True for the rifle alone: it can never run out and shows no number. */
  readonly unlimited: boolean
  /** Whether this is what the next `fire` command will carry. */
  readonly active: boolean
  /** The key that selects it, as the player presses it and as the HUD prints it. */
  readonly hotkey: string
}

/**
 * The `KeyboardEvent.key` that selects the weapon at `index`.
 *
 * The row number IS the key, which is why the hotkey is derived from the order
 * above rather than authored per row: a fourth ordnance type added to `ORDNANCE`
 * gets `4` with nothing else to edit, and no second table can drift out of step
 * with the first.
 */
function hotkeyAt(index: number): string {
  return String(index + 1)
}

/** The ordnance a digit selects, or `undefined` for a key that selects nothing. */
export function ordnanceForHotkey(key: string): string | undefined {
  for (let i = 0; i < ORDNANCE_ORDER.length; i += 1) {
    if (hotkeyAt(i) === key) return ORDNANCE_ORDER[i]
  }
  return undefined
}

/** `grenade` -> `Grenade`. Names are lower-case identifiers; the HUD is prose. */
export function labelFor(ordnance: string): string {
  return ordnance.charAt(0).toUpperCase() + ordnance.slice(1)
}

/** Marks the weapon the next right-click will use. */
const ACTIVE_MARKER = '▶'

/**
 * Stands in the marker's column for every other row, so the labels line up.
 * A blank would let the list shift sideways as the selection moves.
 */
const IDLE_MARKER = '·'

/**
 * One selector row as a line of text.
 *
 * NO HOTKEY IN THE LINE. The key is a separate field so the HUD can place it
 * where it likes — right-aligned, dimmed, or not at all on a gamepad build.
 *
 * NO NUMBER AT ALL FOR THE RIFLE. "Rifle 0" reads as an empty weapon, which is
 * the exact opposite of true, and it is the one weapon that can never run out.
 */
export function selectorLine(slot: ArmourySlot): string {
  const marker = slot.active ? ACTIVE_MARKER : IDLE_MARKER
  if (slot.unlimited) return `${marker} ${slot.label}`
  return `${marker} ${slot.label} ${String(slot.count)}`
}

/** Build the slot for `ordnance` at `index`. Used only by `createArmoury`. */
export function buildSlot(
  ordnance: string,
  index: number,
  count: number,
  active: boolean,
): ArmourySlot {
  return {
    ordnance,
    label: labelFor(ordnance),
    count,
    unlimited: ordnance === RIFLE_ORDNANCE,
    active,
    hotkey: hotkeyAt(index),
  }
}
