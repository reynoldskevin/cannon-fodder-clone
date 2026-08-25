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

/** Record that unit `id` fired on `tick` with `spec`. */
export function markFired(cooldowns: Cooldowns, id: number, tick: number, spec: WeaponSpec): void {
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
