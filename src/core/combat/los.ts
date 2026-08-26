/**
 * Line of sight over the nav grid (ticket 011).
 *
 * WHY THIS SHARES THE NAV GRID rather than owning an opacity layer of its own:
 * there is no opacity channel in the game today, so passability is the proxy —
 * a tile you cannot walk into is a tile you cannot see through. That is exactly
 * right for the walls and rock that level 1 is made of, and exactly wrong for
 * the two cases the design will eventually want:
 *
 *   - WATER blocks infantry but is see-through. Today it is baked unwalkable and
 *     therefore, wrongly, opaque.
 *   - A CHEST-HIGH WALL is opaque to sight but shootable over.
 *
 * THE SEAM for fixing that is this file and only this file: give `NavGrid` a
 * second bitmask (`opaque`), swap the `grid.passable(...)` calls below for it,
 * and nothing else in combat changes. It deliberately does NOT go in
 * `pathing/navgrid.ts` yet — inventing an opacity channel that only ever holds a
 * copy of the passability bits is a field two systems must keep in sync for no
 * present benefit.
 *
 * SYMMETRY IS THE LOAD-BEARING PROPERTY. If A can see B but B cannot see A, one
 * soldier shoots the other with impunity and the bug is only reproducible from
 * one side of the wall. The naive fix — walk a Bresenham from the shooter — is
 * precisely what fails, because Bresenham's error term breaks ties toward one
 * end of the line. This walk instead compares boundary crossings as EXACT
 * INTEGER products (see below), so reversing the endpoints reverses the walk
 * over the identical set of tiles rather than approximating it.
 *
 * TWO QUESTIONS, ONE WALK (ticket 011a). "Can A see B?" is a yes/no, and it is
 * the only thing ticket 011 ever asked. Commanded fire asks a second one — "how
 * far along this ray is clear?" — because a round ordered at a wall has to stop
 * at the wall's near face rather than either vanishing or passing through it.
 * `clearFractionAlong` answers that and `hasLineOfSight` is defined in terms of
 * it, so there is exactly one traversal in this file and the symmetry argument
 * above covers both callers rather than one of them.
 *
 * THE WALK IS SYMMETRIC; THE FRACTION IS NOT, AND THAT IS THE POINT. Symmetry is
 * a property of the tile sequence, which is why the yes/no answer is reversible.
 * The fraction is measured from the SHOOTER, so the two directions report
 * different stopping points — a wall at x=5 between A at x=0 and B at x=10
 * clamps to world x 5 seen from A and x 6 seen from B. Both are the wall's NEAR
 * face for that shooter, which is exactly what a round ordered at it should do.
 */

import { INFANTRY } from '../pathing/navgrid'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'

/** A point in TILE space. Fractional values are floored to the tile containing them. */
export interface SightPoint {
  readonly x: number
  readonly y: number
}

/**
 * Whether `from` can see `to` across the grid.
 *
 * Both endpoints are in TILE coordinates and are floored to their tile, matching
 * `NavGrid.index`'s rounding contract: entities hold continuous positions, and a
 * shot fired from the middle of a tile is fired from that tile. Callers holding
 * WORLD coordinates must convert first — the two spaces share a scale but not an
 * origin (see `core/view/projection`).
 *
 * An endpoint that is off the map, non-finite, or standing inside solid terrain
 * sees nothing and is seen by nothing. The last of those is not pedantry: a unit
 * nudged into geometry by a collision resolve must not be rewarded with x-ray
 * vision, and refusing both ends keeps the answer symmetric for free.
 *
 * The walk itself steps tile to tile along the segment joining the two tile
 * CENTRES, and every tile it enters must be passable.
 *
 * `mask` defaults to `INFANTRY` — every unit the game spawns today — so the
 * three-argument call the acceptance criteria name reads as the common case and
 * the mask is there for the turret or half-track that eventually needs it.
 */
export function hasLineOfSight(
  grid: NavGrid,
  from: SightPoint,
  to: SightPoint,
  mask: TraversalMask = INFANTRY,
): boolean {
  // `passable` already rejects off-map and NaN coordinates (its bounds test is
  // negated so NaN falls out on the wrong side), so this one call covers bounds,
  // finiteness and terrain for the far endpoint. The near one is covered by
  // `clearFractionAlong`, which answers 0 for a shooter standing in rock.
  //
  // REFUSING A BLOCKED DESTINATION IS THIS FUNCTION'S RULE AND NOT THE WALK'S. A
  // unit nudged into geometry by a collision resolve must not be rewarded with
  // x-ray vision, and refusing both ends keeps the answer symmetric for free —
  // whereas a round ORDERED at a wall must still be fired, which is why the walk
  // below reports a distance instead of a refusal and this one asks it here.
  if (!grid.passable(Math.floor(to.x), Math.floor(to.y), mask)) return false
  return clearFractionAlong(grid, from, to, mask) === 1
}

/**
 * How much of the ray from `from` to `to` is clear of solid terrain, as a
 * fraction in [0, 1] of the segment joining the two tile CENTRES.
 *
 * 1 means the whole segment is clear — exactly the case `hasLineOfSight` calls
 * true, given a destination that is itself passable. Anything less is the
 * parameter at which the ray meets the first face of solid terrain, so
 * `from + t * (to - from)` is the last point a bullet could reach: the near face
 * of the wall, not its centre and not the open ground behind it.
 *
 * 0 means the shooter's own tile is impassable, off the map, or non-finite, or
 * else the DESTINATION is non-finite. There is nothing sensible to report for a
 * rifle inside a rock, nor for a ray with no far end, and 0 collapses the ray to
 * the muzzle rather than inventing a length for it. Note the asymmetry with the
 * shooter's tile: a destination that is merely off the map or in solid terrain
 * is a fine thing to fire at and gets a real fraction — refusing it is
 * `hasLineOfSight`'s rule, not this one's.
 *
 * The walk, the corner rule and the exact-integer boundary comparison are the
 * ones documented on `hasLineOfSight` above; this is the same traversal reporting
 * WHERE it stopped instead of THAT it stopped. Because both endpoints sit at tile
 * centres, the i-th vertical boundary is crossed at (2i - 1) / (2 * adx) along
 * the segment and the j-th horizontal one at (2j - 1) / (2 * ady) — the same two
 * fractions the traversal is already comparing, so reporting the parameter costs
 * a single division, formed at the return sites and therefore paid only on the
 * tick a shot is actually blocked — never on the clear walks, which is nearly
 * all of them and which target selection runs per candidate per armed unit per
 * tick.
 */
export function clearFractionAlong(
  grid: NavGrid,
  from: SightPoint,
  to: SightPoint,
  mask: TraversalMask = INFANTRY,
): number {
  const x0 = Math.floor(from.x)
  const y0 = Math.floor(from.y)
  const x1 = Math.floor(to.x)
  const y1 = Math.floor(to.y)

  if (!grid.passable(x0, y0, mask)) return 0
  // A non-finite destination gives a non-finite step count, which the loop below
  // would skip entirely and call clear. It is not a ray at all, so it is nothing.
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return 0
  if (x0 === x1 && y0 === y1) return 1

  const sx = x1 > x0 ? 1 : -1
  const sy = y1 > y0 ? 1 : -1
  const adx = Math.abs(x1 - x0)
  const ady = Math.abs(y1 - y0)

  let cx = x0
  let cy = y0
  // `i` counts vertical tile boundaries already crossed, `j` horizontal ones.
  // Because both endpoints sit at tile centres, the i-th vertical boundary is
  // crossed at parameter (i - 0.5) / adx along the segment and the j-th
  // horizontal one at (j - 0.5) / ady. Comparing those two fractions is the
  // whole of the traversal, and cross-multiplying clears the denominators:
  //
  //     (2i - 1) * ady   vs   (2j - 1) * adx
  //
  // INTEGER ARITHMETIC, so the comparison is exact rather than merely close, and
  // "the boundaries fall at the same point" is a real equality instead of a
  // float tie that resolves differently depending on which end you started from.
  // Under reversal i -> adx + 1 - i and j -> ady + 1 - j, which maps this
  // comparison to its own mirror image — that is the symmetry proof.
  let i = 1
  let j = 1
  while (i <= adx || j <= ady) {
    const hasX = i <= adx
    const hasY = j <= ady
    let stepX = hasX
    let stepY = hasY
    if (hasX && hasY) {
      const untilX = (2 * i - 1) * ady
      const untilY = (2 * j - 1) * adx
      if (untilX < untilY) stepY = false
      else if (untilY < untilX) stepX = false
      // Otherwise both remain true: the segment passes exactly through the
      // lattice point where four tiles meet, and the step is diagonal.
    }

    if (stepX && stepY) {
      // THE CORNER RULE, and it is exactly ticket 006's rule for movement
      // (`flowfield.ts`) read optically: BOTH shared orthogonals blocked means
      // two walls touching at a corner, and a ray threading the single point
      // where they meet is looking through solid terrain. Exactly one blocked is
      // a legal sightline grazing a wall's corner and must be allowed —
      // refusing it would blind every soldier standing along a canopy fringe,
      // of which level 1 has hundreds.
      //
      // The crossing parameter is formed HERE, at the return, rather than once
      // per iteration above: the walk is overwhelmingly clear and would throw
      // the value away. `i` has not been advanced yet, and on a diagonal the two
      // expressions are equal — that equality is what selected the diagonal — so
      // the vertical one names the lattice point being threaded.
      if (!grid.passable(cx + sx, cy, mask) && !grid.passable(cx, cy + sy, mask))
        return (2 * i - 1) / (2 * adx)
    }

    if (stepX) {
      cx += sx
      i += 1
    }
    if (stepY) {
      cy += sy
      j += 1
    }
    // Same parameter, at the same cost, but `i` and `j` have been advanced by the
    // step above — so the boundary just crossed is the (i - 1)-th vertical one,
    // at (2(i - 1) - 1) / (2 * adx) = (2i - 3) / (2 * adx), and likewise for `j`.
    if (!grid.passable(cx, cy, mask))
      return stepX ? (2 * i - 3) / (2 * adx) : (2 * j - 3) / (2 * ady)
  }

  return 1
}
