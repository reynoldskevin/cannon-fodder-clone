/**
 * Shot resolution (ticket 011): can I reach it, may I fire yet, and what
 * happens when the round lands.
 *
 * Every function here is a pure-ish leaf — no grid, no tick loop, no target
 * selection — because these are the parts that later systems reuse in contexts
 * the combat system knows nothing about: a grenade calls `applyDamage` on
 * everything in its radius, a minefield calls it with a `null` killer, and
 * neither of those is a rifle shot.
 *
 * NO CONSTANTS LIVE HERE. Damage, cooldowns and ranges arrive as arguments or as
 * a `WeaponSpec`; `weapons.ts` is the only place a number is chosen.
 */

import type { World } from '../world/world'
import type { WeaponSpec } from './weapons'

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * Whether (`bx`, `bz`) is within `range` of (`ax`, `az`).
 *
 * UNIT-AGNOSTIC: all five arguments must be in the SAME space. The caller does
 * the conversion, because this has no way to check and a half-applied scale
 * factor is the worst kind of bug. `system.ts` passes world units and converts
 * `WeaponSpec.rangeTiles` at the call site.
 *
 * EUCLIDEAN, not Chebyshev, and the difference is visible in play: Chebyshev
 * gives every unit a square firing envelope, so a soldier can shoot 5 tiles
 * diagonally (7.07 tiles of real distance) but not 6 tiles straight ahead, and
 * players discover it by standing at the corners.
 *
 * INCLUSIVE at the boundary. A unit that has walked to exactly its maximum range
 * should fire, not stand at the spot it chose and refuse to shoot from it.
 *
 * Squared distances, so there is no `Math.sqrt` on the hot path.
 *
 * DO NOT "TIDY" THE COMPARISON INTO ITS NEGATED FORM. A plain `<=` is what makes
 * a non-finite coordinate report OUT of range: every comparison against NaN is
 * false, so `NaN <= r*r` is false and the shot is refused. Rewriting it as
 * `!(dsq > range * range)` reads equivalently and is not — it flips NaN to *in*
 * range, and a unit at a corrupted position becomes shootable from anywhere.
 * (Contrast `NavGrid.index`, which genuinely does need the negated form: there
 * the safe answer for NaN is "off map", so the test is written `!(tx >= 0)`.)
 */
export function inRange(ax: number, az: number, bx: number, bz: number, range: number): boolean {
  const dx = bx - ax
  const dz = bz - az
  return dx * dx + dz * dz <= range * range
}

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

/** `[0, 1]`, which is the only range a probability may be compared in. */
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * `spec`'s chance of hitting something `distanceTiles` away, in `[0, 1]`
 * (ticket 011b).
 *
 * A PURE READ OF THE TABLE. It draws nothing and knows nothing about the world;
 * whether the roll is taken at all is `CombatOptions.hitPolicy`'s decision, and
 * whether the draw is spent is `system.ts`'s. Keeping the curve separable is
 * what lets a test assert the interpolation without running a simulation.
 *
 * CLAMPED AT BOTH ENDS RATHER THAN EXTRAPOLATED. Past `rangeTiles` an unclamped
 * line returns a NEGATIVE chance, and a negative chance compared against a
 * `[0, 1)` draw is a weapon that silently stops working at the edge of its
 * envelope; behind zero it returns more than one, which is merely wrong. Nothing
 * should ask for either — `inRange` refuses a round beyond `rangeTiles` — but
 * "nothing should" is not a guarantee, and the endpoint value is the answer that
 * cannot surprise anybody.
 *
 * WRITTEN WITH POSITIVE COMPARISONS, for the reason `inRange` states at length:
 * every comparison against NaN is false, so a corrupted position falls through
 * `!(distanceTiles > 0)` to the point-blank end rather than producing a NaN
 * chance. A NaN chance loses every `<` it is compared with, which would make the
 * unit at the corrupted position unhittable from anywhere — a far quieter and
 * worse failure than a round that was too likely to land.
 */
export function hitChanceAt(spec: WeaponSpec, distanceTiles: number): number {
  const { pointBlank, maxRange } = spec.accuracy
  // Zero, negative and non-finite distances all land here. Checked FIRST, and
  // that order is the point: `pointBlank` is documented as the chance at zero
  // distance, so it must be the answer at zero distance for every weapon —
  // including a zero-range one, which `inRange` still admits a coincident
  // target for.
  if (!(distanceTiles > 0)) return clamp01(pointBlank)
  // A zero- or negative-range weapon has no line to interpolate along, and any
  // positive distance is past the whole of its envelope, so the far end is the
  // answer. Nothing shipped has such a range; this only has to stay finite and
  // in bounds.
  if (!(spec.rangeTiles > 0)) return clamp01(maxRange)
  const t = distanceTiles < spec.rangeTiles ? distanceTiles / spec.rangeTiles : 1
  // `a + (b - a) * t` rather than `a * (1 - t) + b * t`: at `t < 1` with both
  // ends equal the second form is two roundings and can return 0.9999999999,
  // and an "always hits" weapon that hits 99.99999% of the time is exactly the
  // difference between `hitPolicy: 'certain'` and a policy that looks like it.
  return clamp01(pointBlank + (maxRange - pointBlank) * t)
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

/**
 * Per-unit rate-of-fire state.
 *
 * Keyed by entity id rather than stored on the `Entity`, for the same reason
 * flow fields are not stored on tiles: cooldown is combat's private bookkeeping,
 * it must not reach the renderer through `world.entities`, and it must not enter
 * `World.stateHash` — a soldier's remaining cooldown is derivable from the tick
 * he last fired on, which is already implied by the event stream.
 */
export interface Cooldowns {
  /** How many units are being tracked. Exposed so a leak is assertable. */
  readonly size: number
  /**
   * Drop a unit's state. MUST be called when a unit leaves the world: ids are
   * never reused, so an untended map grows by one entry per soldier who ever
   * fired and never shrinks — a slow leak over a campaign rather than a mission.
   */
  forget(id: number): void
  /**
   * Earliest tick each tracked unit may fire again.
   *
   * The stored value is the DEADLINE, not the tick last fired on. That is what
   * lets `readyToFire` take no `WeaponSpec`: a unit that swaps weapons mid
   * mission — picks up a rocket launcher, mounts a jeep — keeps the cooldown of
   * the shot it actually took, whereas a "last fired" tick would have to be
   * re-interpreted against whatever weapon it happens to hold when asked.
   */
  readonly readyAt: Map<number, number>
}

/** A fresh cooldown table. Every unit is ready to fire until it fires. */
export function createCooldowns(): Cooldowns {
  const readyAt = new Map<number, number>()
  return {
    readyAt,
    get size(): number {
      return readyAt.size
    },
    forget(id: number): void {
      readyAt.delete(id)
    },
  }
}

/**
 * Whether unit `id` may fire on tick `tick`.
 *
 * A unit with no record has never fired and is ready — that is what makes an
 * ambush work, and it means spawning a unit costs no cooldown bookkeeping.
 * `>=` rather than `>`, so `cooldownTicks` means exactly "wait this many ticks"
 * and a cooldown of 1 is one shot per tick rather than one every other tick.
 */
export function readyToFire(cooldowns: Cooldowns, id: number, tick: number): boolean {
  const ready = cooldowns.readyAt.get(id)
  return ready === undefined || tick >= ready
}

/**
 * Record that unit `id` fired on `tick` with `spec`.
 *
 * The parameter is the COOLDOWN, not a whole weapon: ticket 015's `OrdnanceSpec`
 * is not a `WeaponSpec` and never will be (a grenade has no range or per-hit
 * damage), but a thrown grenade puts a man on a rate-of-fire clock in exactly
 * the same way a round does. Widening the type is what lets both share one
 * cooldown table instead of ordnance growing a parallel copy that then disagrees
 * about whether a man may act this tick. Every existing `WeaponSpec` caller
 * still satisfies it structurally.
 */
export function markFired(
  cooldowns: Cooldowns,
  id: number,
  tick: number,
  spec: { readonly cooldownTicks: number },
): void {
  cooldowns.readyAt.set(id, tick + spec.cooldownTicks)
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/**
 * Apply `damage` to `targetId`, attributing it to `killerId`. Returns whether the
 * target died.
 *
 * DAMAGE IS A VALUE. There is no "is this infantry?" branch: a soldier dies to a
 * rifle round because `WEAPONS.rifle.damage >= INFANTRY_HEALTH`, and a jeep
 * spawned with more health survives the identical code path. That is the
 * vehicles extension point, paid for in advance and costing nothing.
 *
 * EVENT ORDER IS A CONTRACT: `UnitDied` is emitted BEFORE `World.despawn` emits
 * `UnitDespawned`. FX spawns a corpse at the entity's position on `UnitDied`; if
 * the despawn were announced first, a careful consumer has already dropped the
 * entity and the corpse appears at the world origin.
 *
 * Unknown or already-dead targets are a no-op that emits NOTHING and reports
 * `false`. Two grenades landing on the same soldier in one tick is normal, and
 * it must produce one death, one kill-feed line and one corpse.
 */
export function applyDamage(
  world: World,
  targetId: number,
  damage: number,
  killerId: number | null,
): boolean {
  const target = world.get(targetId)
  if (target === undefined) return false
  // Non-positive damage is ignored rather than applied. A negative value here is
  // a caller bug (a mis-signed falloff term, say), and the sane failure is
  // "nothing happened" rather than a weapon that silently heals its victims.
  if (!(damage > 0)) return false

  target.health -= damage
  if (target.health > 0) return false

  // FRIENDLY FIRE IS A FEATURE. The original lets you mow down your own squad
  // and the campaign's Boot Hill screen counts it, so this is attribution rather
  // than a guard. Note it is *team* equality, not "is the player": an enemy
  // grenade that kills its own squad is friendly fire too.
  //
  // The killer may already be dead — he fired and was shot before his round
  // landed — in which case his team is unknowable and the flag is false. His id
  // is still reported: ids are never reused, so a consumer holding a kill log
  // can still name him.
  const killer = killerId === null ? undefined : world.get(killerId)
  const friendlyFire = killer !== undefined && killer.team === target.team

  world.emit({
    type: 'UnitDied',
    id: target.id,
    team: target.team,
    killerId,
    friendlyFire,
  })
  world.despawn(target.id)
  return true
}
