/**
 * The squad's pouch (ticket 016): what it is holding, and how much of it is
 * left.
 *
 * ONE POUCH FOR THE WHOLE SQUAD, NOT ONE PER MAN. A per-soldier inventory would
 * mean the player has to know which of five men is carrying the last rocket
 * before he right-clicks, and then select that man — bookkeeping the original
 * never asked for and which a pointer has no way to express.
 *
 * PURE, LIKE THE REST OF `src/core`. No clock, no random draw, no DOM. The
 * counts are read by the HUD and written by `command/apply.ts`; nothing here
 * decides anything about the world.
 */

import { buildSlot, ORDNANCE_ORDER, RIFLE_ORDNANCE } from './loadout'
import type { ArmourySlot } from './loadout'

/** Everything the armoury needs that is not a later `grant`. */
export interface ArmouryOptions {
  /**
   * Starting rounds, keyed by ordnance name. Omitted entirely is an EMPTY
   * pouch, not the default loadout: the default is `DEFAULT_LOADOUT`, applied by
   * `createSession`, so a caller building an armoury by hand gets exactly what
   * it asked for and nothing it did not.
   *
   * Hand-authored data, so it is sanitised rather than trusted — see
   * `sanitiseCount`.
   */
  readonly starting?: Readonly<Record<string, number>>
}

/** The squad's ammunition and its current weapon. */
export interface Armoury {
  /** What the next `fire` command will be built with. Starts on the rifle. */
  readonly selected: string
  /** Rounds left, `Infinity` for the rifle, 0 for anything unstocked or unknown. */
  count(ordnance: string): number
  /** Spend one round. False — and nothing spent — when there is none to spend. */
  consume(ordnance: string): boolean
  /** Add rounds. Ticket 017's chests call exactly this. Non-positive is ignored. */
  grant(ordnance: string, rounds: number): void
  /** Hold `ordnance`. False, and the selection unchanged, for a name that is not one. */
  select(ordnance: string): boolean
  /** Step `delta` places through `slots()`, wrapping both ways. */
  cycle(delta: number): void
  /** The selector's model, freshly built. See `ArmourySlot`. */
  slots(): readonly ArmourySlot[]
}

/**
 * A hand-authored count as a number of rounds.
 *
 * A LEVEL DOCUMENT IS HAND-AUTHORED AND SURVIVES A JSON ROUND TRIP BADLY.
 * `NaN` and `Infinity` both come back as `null` or garbage and both would make
 * the HUD's count meaningless; a negative would make `consume`'s refusal
 * unreachable; a fraction would bank half a grenade. Floored and clamped, so
 * the pouch always holds a whole, non-negative number of rounds.
 */
function sanitiseCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

export function createArmoury(options: ArmouryOptions = {}): Armoury {
  /**
   * Rounds by ordnance name. Asked `get`/`set` by key only and never iterated,
   * so no `Map` order can reach a simulation result — `slots()` walks
   * `ORDNANCE_ORDER`, which is an array.
   */
  const rounds = new Map<string, number>()

  const starting = options.starting
  if (starting !== undefined) {
    // WALKING THE KNOWN ORDER RATHER THAN THE DOCUMENT'S KEYS does two things at
    // once: it drops names nothing in the game has ever heard of, and it copies
    // rather than aliases. A caller holding the level's own spawn data would
    // otherwise watch its document mutate as the squad threw grenades, and on a
    // restart the level would begin with whatever the last run ended on.
    for (const ordnance of ORDNANCE_ORDER) {
      const given = starting[ordnance]
      if (given === undefined) continue
      rounds.set(ordnance, sanitiseCount(given))
    }
  }

  /** Index into `ORDNANCE_ORDER`, which begins at the rifle. See `selected`. */
  let selectedIndex = 0

  function count(ordnance: string): number {
    // THE RIFLE IS NOT AMMUNITION. `Infinity` rather than 0 because 0 is the one
    // answer a caller would read as "empty", and the rifle is the weapon that
    // can never be. Nothing prints it: `ArmourySlot.unlimited` is what the HUD
    // reads, and `selectorLine` shows no number at all for such a slot.
    if (ordnance === RIFLE_ORDNANCE) return Number.POSITIVE_INFINITY
    return rounds.get(ordnance) ?? 0
  }

  function consume(ordnance: string): boolean {
    if (ordnance === RIFLE_ORDNANCE) return true
    const have = rounds.get(ordnance) ?? 0
    // The refusal has to be reportable rather than a silent no-op: a throw that
    // does nothing reads as a broken button, which is why the caller emits
    // `FireRejected` on a false.
    if (have <= 0) return false
    rounds.set(ordnance, have - 1)
    return true
  }

  function grant(ordnance: string, count_: number): void {
    if (ordnance === RIFLE_ORDNANCE) return
    // A name the selector does not list has no row to show it on, so accepting
    // it would put rounds in a pouch the player can never see or reach.
    if (!ORDNANCE_ORDER.includes(ordnance)) return
    // A chest with a mis-signed or fractional reward must not empty the pouch it
    // was meant to fill, nor bank half a grenade. Ignored outright, because
    // there is no sane rounding of "minus two grenades".
    if (!Number.isInteger(count_) || count_ <= 0) return
    rounds.set(ordnance, (rounds.get(ordnance) ?? 0) + count_)
  }

  function select(ordnance: string): boolean {
    const index = ORDNANCE_ORDER.indexOf(ordnance)
    if (index < 0) return false
    // AN EMPTY POUCH IS SELECTABLE, DELIBERATELY. Refusing to select it makes
    // the weapon vanish from the game with no explanation; the refusal belongs
    // at the moment of FIRING, where it can be reported.
    selectedIndex = index
    return true
  }

  function cycle(delta: number): void {
    // A trackpad can deliver a huge or fractional wheel delta in one event, and
    // a non-finite one would make the index `NaN` — an index that matches no
    // slot, so the squad would be holding nothing at all.
    if (!Number.isFinite(delta)) return
    const n = ORDNANCE_ORDER.length
    // `(-1) % n` IS `-1` IN JAVASCRIPT, NOT `n - 1`. Indexing with it yields
    // `undefined` and the selection becomes nothing, so the remainder is
    // brought back into range by adding `n` before the second modulo.
    selectedIndex = (((selectedIndex + Math.trunc(delta)) % n) + n) % n
  }

  function slots(): readonly ArmourySlot[] {
    // FRESH OBJECTS IN A FRESH ARRAY every call. The HUD holds this across a
    // frame, and handing back live storage is the aliasing bug the tracer buffer
    // and the ordnance system have each already had once.
    const out: ArmourySlot[] = []
    for (let i = 0; i < ORDNANCE_ORDER.length; i += 1) {
      const ordnance = ORDNANCE_ORDER[i]
      if (ordnance === undefined) continue
      out.push(buildSlot(ordnance, i, count(ordnance), i === selectedIndex))
    }
    return out
  }

  return {
    // A getter, not a snapshot: the object is built once and the selection
    // changes whenever the player presses a digit, so a plain property would
    // freeze on the rifle for the whole mission.
    get selected(): string {
      return ORDNANCE_ORDER[selectedIndex] ?? RIFLE_ORDNANCE
    },
    count,
    consume,
    grant,
    select,
    cycle,
    slots,
  }
}
