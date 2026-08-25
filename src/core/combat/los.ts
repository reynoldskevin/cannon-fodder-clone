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
  const x0 = Math.floor(from.x)
  const y0 = Math.floor(from.y)
  const x1 = Math.floor(to.x)
  const y1 = Math.floor(to.y)

  // `passable` already rejects off-map and NaN coordinates (its bounds test is
  // negated so NaN falls out on the wrong side), so this one call covers bounds,
  // finiteness and terrain for each endpoint.
  if (!grid.passable(x0, y0, mask)) return false
  if (!grid.passable(x1, y1, mask)) return false
  if (x0 === x1 && y0 === y1) return true

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
      if (!grid.passable(cx + sx, cy, mask) && !grid.passable(cx, cy + sy, mask)) return false
    }

    if (stepX) {
      cx += sx
      i += 1
    }
    if (stepY) {
      cy += sy
      j += 1
    }
    if (!grid.passable(cx, cy, mask)) return false
  }

  return true
}
