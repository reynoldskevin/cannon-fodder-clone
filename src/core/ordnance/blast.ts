/**
 * Blast resolution (ticket 015): who is inside the radius, and how much each
 * one takes.
 *
 * IT COMPUTES, IT DOES NOT APPLY. `resolveBlast` returns a list; the system
 * calls `applyDamage`. That split is not tidiness — `INFANTRY_HEALTH` is 1, so
 * every blast that reaches a man at all kills him, and a function that applied
 * its own damage could only ever be tested as a body count. Returning the
 * numbers is what makes the falloff curve assertable at all.
 *
 * SEPARATE FROM THE FLIGHT PASS for the same reason `ballistics.ts` is: a blast
 * is the first thing in this game that damages more than one entity from one
 * cause, and every interesting question about it — who is in reach, how much,
 * whose side they are on, what is between them and the centre — is answerable
 * with no tick loop and no projectile. Resolving it inline would put all four
 * behind a grenade that has to be thrown first.
 *
 * DETERMINISM. Victims are scanned in `world.entities` order, which is spawn
 * order and which ticket 005 guarantees stable. No `Set`, no `Map`, no `rng`, no
 * sort — so there is no tie to break and two identical missions agree.
 */

import { hasLineOfSight } from '../combat/los'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE } from '../view/projection'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { Team, World } from '../world/world'
import type { FalloffCurve, OrdnanceSpec } from './table'

/** One victim and what the blast did to them. Always a POSITIVE damage. */
export interface BlastHit {
  readonly id: number
  readonly damage: number
}

/**
 * Convert a world-space ground coordinate to a continuous TILE coordinate.
 *
 * The two spaces share a scale (`TILE_WORLD_SIZE` is 1) but NOT an origin: a
 * level is centred on the world origin, so world x = tile x - (n - 1) / 2. The
 * `+ n / 2` here is that inverse composed with `hasLineOfSight`'s flooring
 * convention — `floor(w + n / 2)` is `round(w + (n - 1) / 2)`, which is exactly
 * the tile `worldToTile` names.
 *
 * Not `worldToTile` itself, deliberately: that function CLAMPS to the grid,
 * which is right for pointer picking (you want the nearest legal tile) and wrong
 * here — a unit that has left the map would be teleported onto the edge and
 * handed a sightline it does not have. Unclamped, off-map falls out as an
 * off-map tile index, which `NavGrid.passable` already rejects.
 *
 * The same function, deliberately the same spelling, as the private one in
 * `combat/system.ts`. Exported here because `system.ts` in this directory needs
 * it too and a third transcription of the `+ n / 2` is how the two spaces drift
 * half a tile apart; combat's copy is private and cannot be imported.
 */
export const worldToTileAxis = (world: number, tiles: number): number =>
  world / TILE_WORLD_SIZE + tiles / 2

/**
 * The fraction of `peakDamage` delivered at `t`, where `t` is the distance from
 * the centre as a fraction of the blast radius.
 *
 * `curve(0) = 1` FOR EVERY CURVE. That invariant is what makes `peakDamage` mean
 * peak damage; a curve starting anywhere else would silently retune every row in
 * the table at once.
 *
 * Nothing at or beyond the edge, and never negative — a negative here would be
 * damage that heals its victim. Note the guard is written `!(t < 1)`, so a `NaN`
 * distance (a corrupted position, a zero radius) falls out as "spent" rather
 * than sailing past a `t >= 1` test and producing `NaN` damage, which subtracted
 * from health makes a soldier unkillable forever.
 */
export function falloffAt(curve: FalloffCurve, t: number): number {
  if (!(t < 1)) return 0
  if (t <= 0) return 1
  switch (curve) {
    case 'linear':
      return 1 - t
    case 'quadratic':
      return (1 - t) * (1 - t)
    case 'constant':
      return 1
  }
}

/**
 * The tile a blast at (`tileX`, `tileY`) should test its sightlines FROM.
 *
 * A BLAST IS NEVER BLOCKED BY ITS OWN TILE. `hasLineOfSight` refuses outright
 * when the SOURCE tile is solid — correct for a rifle inside a rock, and
 * catastrophic here: the level-1 repaint put over a thousand canopy tiles on the
 * map, so "the grenade landed in a tree" is most throws rather than an edge
 * case, and a blast centred on one would report zero victims in every direction.
 * A grenade that lands a foot from a man and does nothing reads as the weapon
 * being broken.
 *
 * So when the centre's own tile is impassable the sightline is run from the
 * nearest passable tile instead, found by a square-ring search — the same shape
 * as `nearestPassable` in `command/apply.ts`, so the choice is deterministic
 * (first ring wins, nearest by true distance within it, ties on scan order).
 * `null` when there is none in reach, which contains the blast entirely.
 *
 * WHAT THIS DOES NOT DO is move the explosion. Distance is still measured from
 * where the round actually went off; the snap moves the sightline's ORIGIN and
 * nothing else. And it is emphatically not "skip the cover test when the centre
 * is solid" — landing in a tree must not turn a grenade into one that shoots
 * through bunkers.
 */
function sightOrigin(
  grid: NavGrid,
  tileX: number,
  tileY: number,
  radiusTiles: number,
  mask: TraversalMask,
): { x: number; y: number } | null {
  const cx = Math.floor(tileX)
  const cy = Math.floor(tileY)
  if (grid.passable(cx, cy, mask)) return { x: tileX, y: tileY }

  // Bounded by the blast's own reach: a sightline origin further out than the
  // radius would be answering about an explosion somewhere else.
  const limit = Math.max(1, Math.ceil(radiusTiles))
  for (let r = 1; r <= limit; r += 1) {
    let best: { x: number; y: number } | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // Only the ring's edge: everything inside it was covered by a smaller r.
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const x = cx + dx
        const y = cy + dy
        if (!grid.passable(x, y, mask)) continue
        const distance = dx * dx + dy * dy
        if (distance >= bestDistance) continue
        bestDistance = distance
        // Tile CENTRES, because that is the space `hasLineOfSight` walks in and
        // the space the un-snapped origin above is already expressed in.
        best = { x: x + 0.5, y: y + 0.5 }
      }
    }
    if (best !== null) return best
  }
  return null
}

/**
 * Everyone the blast reaches, and what each takes.
 *
 * (`centreX`, `centreZ`) is WORLD space — where the round actually went off,
 * including a fuse that expired in mid-air. Height is deliberately not a factor:
 * an airburst two tiles up damages the same circle as one at ground level, and
 * the alternative (a sphere) would make a grenade's effect depend on a number
 * the player has no way to read off the screen.
 *
 * `launcherTeam` is the team the round was launched by, CAPTURED AT LAUNCH and
 * passed in rather than looked up: the thrower may be dead by the time it lands.
 * `null` means the blast belongs to no side — a minefield, a burning fuel drum,
 * a scripted demolition — and spares nobody, which is why the friendly-fire test
 * below compares against a team rather than against "has an owner".
 *
 * ONLY POSITIVE DAMAGE IS REPORTED. A victim at exactly the radius takes zero
 * under a linear curve, and reporting a zero-damage hit would make this result
 * disagree with what `applyDamage` — which already ignores non-positive damage —
 * would actually do with it.
 */
export function resolveBlast(
  world: World,
  grid: NavGrid,
  spec: OrdnanceSpec,
  centreX: number,
  centreZ: number,
  launcherTeam: Team | null,
  mask: TraversalMask = INFANTRY,
): BlastHit[] {
  const hits: BlastHit[] = []
  // Positive test, so a `NaN` or negative radius from a hand-authored table
  // reaches nobody instead of dividing by zero and handing out `NaN` damage.
  if (!(spec.blastRadiusTiles > 0)) return hits

  const radiusWorld = spec.blastRadiusTiles * TILE_WORLD_SIZE
  const origin = sightOrigin(
    grid,
    worldToTileAxis(centreX, grid.w),
    worldToTileAxis(centreZ, grid.h),
    spec.blastRadiusTiles,
    mask,
  )
  // Nowhere passable within reach: the blast is contained by the terrain it is
  // buried in. Reporting nobody is the honest answer, and it is unreachable on
  // any map that is not solid rock for the whole radius.
  if (origin === null) return hits

  // `world.entities` is the live array in spawn order. Read only — the caller
  // applies the damage afterwards, which is what keeps this a snapshot: every
  // victim is measured against the same world, so two men who die to one grenade
  // die to the numbers it had when it went off.
  const candidates = world.entities
  for (let i = 0; i < candidates.length; i += 1) {
    const victim = candidates[i]
    if (victim === undefined) continue
    // The friendly-fire flag, and note it reads the LAUNCHER's team rather than
    // testing for the player: an enemy grenade must spare enemies. A `null`
    // owner matches no team, so it spares nobody.
    if (!spec.damagesFriendlies && launcherTeam !== null && victim.team === launcherTeam) continue

    const dx = victim.x - centreX
    const dz = victim.z - centreZ
    // EUCLIDEAN, not Chebyshev, for the reason `inRange` gives: a square blast
    // has corners, and players find them by standing at them. `hypot` rather
    // than comparing squares because the true distance is needed for the falloff
    // anyway, so squaring would only be undone a line later.
    const distance = Math.hypot(dx, dz)
    const curveAt = falloffAt(spec.falloff, distance / radiusWorld)
    if (curveAt <= 0) continue

    // THE LOS TEST IS DONE LAST, after the team check and the distance have
    // eliminated almost everybody: it walks a tile at a time and is by far the
    // most expensive thing here, exactly as in `CombatSystem.pickTarget`.
    //
    // COVER STOPS A BLAST, which is what makes a building worth standing in. A
    // grenade against a bunker's outside wall must not kill the room behind it.
    const tx = worldToTileAxis(victim.x, grid.w)
    const tz = worldToTileAxis(victim.z, grid.h)
    if (!hasLineOfSight(grid, origin, { x: tx, y: tz }, mask)) continue

    const damage = spec.peakDamage * curveAt
    // Only positive damage — see the note on the function above. This also
    // rejects a `NaN` peak from hand-authored data before it can reach health.
    if (!(damage > 0)) continue
    hits.push({ id: victim.id, damage })
  }
  return hits
}
