/**
 * Terrain resolution for a step (ticket 007).
 *
 * A unit's steering — flow field plus formation plus separation — is a vector
 * over continuous ground, and nothing in it knows where the walls are. The
 * separation term in particular pushes SIDEWAYS, off whatever guidance the flow
 * field was giving, and that push is exactly what shoves the man on the outside
 * of a corridor into the trees. So the last thing that happens to a step is that
 * it is resolved against the grid.
 *
 * PER AXIS, NOT ALL-OR-NOTHING. Rejecting the whole step because one component
 * of it is illegal is the naive fix and it produces men who stick to walls: a
 * soldier walking east along the north wall of a corridor, nudged half a
 * millimetre north by his neighbour, would stop dead for as long as the nudge
 * lasted. Resolving each axis separately keeps the legal component — he slides
 * along the wall and keeps going east — which is both what the ticket asks for
 * and what the original looks like.
 *
 * The x axis is tried first and the y axis is then tested against the x the unit
 * actually ended on, so the pair of calls tests the cell the unit really ends
 * the tick in rather than two cells it may only have passed through. The bias
 * that gives x is a real asymmetry into a corner and a deliberate one: it is
 * fixed, so it is deterministic, and the alternative (resolving the two orders
 * and picking the better) buys a tie-break nobody can see for twice the work.
 *
 * TILE SPACE, FLOOR CONVENTION. Both functions take and return CONTINUOUS tile
 * coordinates and ask the grid about `Math.floor` of them — the same convention
 * `NavGrid` and `FlowField` use internally, so a position this accepts is a
 * position those two agree is passable. Off the map is not passable, so this is
 * also what keeps a unit on the board: no separate bounds clamp exists, and
 * adding one would be a second, quietly disagreeing, opinion about the edge.
 *
 * SWEPT, NOT TELEPORTED. Testing only the cell a step ENDS in is a wall test
 * with a hole in it: a displacement longer than a tile passes clean through
 * whatever stands between the two ends. That is not a hypothetical size of step
 * here — the per-axis displacement a unit can attempt is `speed * timestep` plus
 * the separation push, and the push alone is capped at the separation radius,
 * which `walls.test.ts` runs at 1.2 tiles. So the displacement is walked in
 * increments of at most `MAX_SUBSTEP` tiles and each increment's destination
 * cell is tested in turn, stopping at the last legal one.
 *
 * THE BOUND THIS GUARANTEES. `MAX_SUBSTEP` is strictly below 1, so consecutive
 * samples are less than a tile apart and the floored coordinate moves by at most
 * one cell between them; testing every increment's destination therefore tests
 * every cell the axis-aligned sweep enters. The guarantee holds for any
 * displacement the increment count can actually represent — up to
 * `MAX_SUBSTEP_COUNT * MAX_SUBSTEP` tiles, which is hundreds of thousands of
 * times the width of any map this game bakes — so no caller has to know or
 * respect a maximum step. Beyond that, and for a non-finite displacement,
 * `substepCount` refuses rather than sweeping: the unit stays where it stands.
 * The cost is `ceil(|d| / MAX_SUBSTEP)` grid lookups, which for the steps this
 * game actually takes is one or two.
 */

import type { NavGrid, TraversalMask } from '../pathing/navgrid'

/**
 * Longest distance, in tiles, that may be covered between two passability tests.
 *
 * Strictly below 1 so that consecutive samples land in the same cell or in
 * adjacent ones, never with an untested cell in between. Exactly 1 would be the
 * bound in exact arithmetic, but the interpolation that produces each sample
 * rounds, and a pair of samples a hair over a tile apart can straddle a cell
 * that neither one tests. Half a tile rather than something just under 1 because
 * that margin has to survive the rounding at a cell boundary, and because a wall
 * is not the only thing on the far side of a skipped cell — the map edge is too.
 */
const MAX_SUBSTEP = 0.5

/**
 * Most increments a single displacement may be walked in.
 *
 * `Math.ceil` of a large enough quotient is `Infinity`, and a loop counting to
 * `Infinity` never ends — so an unbounded displacement is not a slow sweep, it
 * is a hang. Nothing in this system produces a step remotely near this cap: it
 * is 2^20 increments, half a million tiles, against maps measured in hundreds.
 */
const MAX_SUBSTEP_COUNT = 1 << 20

/**
 * How many increments a displacement of `d` is walked in. At least one, so a
 * zero-length or sub-increment step still gets exactly one test.
 *
 * A non-finite displacement — which nothing should produce, but which would be
 * permanent if it reached a position — yields 0, the caller's signal to leave
 * the unit where it stands rather than to loop forever. A displacement so large
 * that sweeping it would need more than `MAX_SUBSTEP_COUNT` tests is refused the
 * same way and for the same reason: it is likewise nothing this system can
 * produce, and the alternative is a tick that never returns.
 */
function substepCount(d: number): number {
  if (!Number.isFinite(d)) return 0
  const steps = Math.ceil(Math.abs(d) / MAX_SUBSTEP)
  if (steps > MAX_SUBSTEP_COUNT) return 0
  return steps < 1 ? 1 : steps
}

/** Where a unit at (x, y) ends up after attempting `dx`, staying on row `y`. */
export function slideX(
  grid: NavGrid,
  mask: TraversalMask,
  x: number,
  y: number,
  dx: number,
): number {
  const steps = substepCount(dx)
  if (steps === 0) return x
  const row = Math.floor(y)
  let reached = x
  for (let i = 1; i <= steps; i += 1) {
    // Interpolated from the ORIGIN rather than accumulated, so the final sample
    // is exactly `x + dx` and a unit that walks its whole step lands where the
    // steering asked rather than a rounding error short of it.
    const next = x + dx * (i / steps)
    if (!grid.passable(Math.floor(next), row, mask)) return reached
    reached = next
  }
  return reached
}

/** Where a unit at (x, y) ends up after attempting `dy`, staying in column `x`. */
export function slideY(
  grid: NavGrid,
  mask: TraversalMask,
  x: number,
  y: number,
  dy: number,
): number {
  const steps = substepCount(dy)
  if (steps === 0) return y
  const column = Math.floor(x)
  let reached = y
  for (let i = 1; i <= steps; i += 1) {
    const next = y + dy * (i / steps)
    if (!grid.passable(column, Math.floor(next), mask)) return reached
    reached = next
  }
  return reached
}
