/**
 * Applying a command to the world (ticket 008).
 *
 * WHERE VALIDATION LIVES. All of it, and only here. The queue is a buffer; this
 * is the one function that holds a `World`, a `NavGrid` and a `SquadSystem` and
 * can therefore answer whether an id names anything living and whether a tile
 * exists. Keeping the two apart means a command that is going to be dropped is
 * still visible in the drained batch of the frame that dropped it.
 *
 * REJECT, DO NOT CLAMP. `core/view/projection.worldToTile` clamps an off-map
 * point to the nearest legal tile, which is right for a camera hint and wrong
 * for an order: a click a hundred tiles past the east edge would clamp to the
 * edge column and become a plausible-looking march into the map border. A click
 * that was not on the map was not an order, so it is refused outright. The
 * bounds test happens here, before anything is asked of the grid.
 *
 * RETARGET, DO NOT DROP. The opposite mistake is the blocked tile: clicking a
 * tree is a real order — "go to the tree" — and doing nothing is the failure
 * players read as "the game ignored me". A blocked in-bounds target is moved to
 * a nearby passable tile instead — the nearest by ring, see `nearestPassable`.
 *
 * The return value is "was this command accepted rather than refused", which is
 * what lets a caller count refusals without this function needing to throw or
 * log. Accepted is not the same as "changed something": `selectOrdnance` has
 * nothing to act on yet and is accepted without touching the world.
 */

import { INFANTRY, type NavGrid } from '../pathing'
import type { SquadSystem } from '../squad'
import type { World } from '../world/world'
import type { Command, CommandTarget } from './types'

/** Everything a command needs in order to be applied. */
export interface CommandContext {
  readonly world: World
  readonly squad: SquadSystem
  readonly grid: NavGrid
}

/**
 * How far from a blocked target we will look for somewhere to stand, in tiles
 * (Chebyshev, so a 17x17 neighbourhood at the maximum).
 *
 * Bounded rather than unbounded because an unbounded search always succeeds
 * while any tile on the map is passable, and "click the middle of a sealed
 * bunker, squad marches to the far side of the level" is not what the player
 * asked for — a refusal reads better than an order they did not give. Eight
 * tiles comfortably clears the scenery clusters the levels are built from
 * (see the `####` blocks in the pathing fixtures) while staying local.
 */
const MAX_RETARGET_RADIUS = 8

/**
 * Apply one command. Returns true when it was accepted, false when it was
 * refused — an unknown target, or an id list with nobody living in it.
 *
 * Accepted, not "changed something": `fire` and `selectOrdnance` have nothing to
 * act on until later tickets, so they validate and return true having changed
 * nothing. Only `move` currently writes to the world.
 *
 * Never throws on bad input: commands arrive from a click on a world a mortar
 * round may have edited since, so a stale id is expected traffic, not an error.
 */
export function applyCommand(command: Command, ctx: CommandContext): boolean {
  switch (command.type) {
    case 'move': {
      const ids = livingIds(command.unitIds, ctx.world)
      if (ids.length === 0) return false
      const target = resolveTarget(command.target, ctx.grid)
      if (target === null) return false
      ctx.squad.order(ids, target)
      return true
    }
    case 'fire': {
      const ids = livingIds(command.unitIds, ctx.world)
      if (ids.length === 0) return false
      // No retargeting here: unlike a move, an order to put ordnance onto a
      // blocked tile is exactly what shooting at a wall means. Only "that tile
      // is not on the map" is a refusal.
      return inBounds(command.target, ctx.grid)
    }
    case 'selectOrdnance':
      // Names no units and no tile, so there is nothing to validate against the
      // world. Which ordnance strings exist is ticket 016's question.
      return true
    default:
      return assertNever(command)
  }
}

/** Fails to compile if a variant is added to `Command` without a case above. */
function assertNever(command: never): never {
  throw new Error(`unhandled command: ${JSON.stringify(command)}`)
}

/**
 * The ids naming a living unit, in the order given.
 *
 * Order matters downstream: `SquadSystem.order` promotes the first id to leader,
 * so filtering must preserve the sequence rather than, say, using a Set.
 */
function livingIds(unitIds: readonly number[], world: World): number[] {
  const living: number[] = []
  for (const id of unitIds) {
    if (world.isAlive(id)) living.push(id)
  }
  return living
}

/** True when this tile index exists on the grid. Non-integers are not tiles. */
function inBounds(target: CommandTarget, grid: NavGrid): boolean {
  // `Number.isInteger` also rejects NaN and the infinities, which is the point:
  // a comparison against NaN is false either way and would be easy to write
  // backwards.
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y)) return false
  return target.x >= 0 && target.y >= 0 && target.x < grid.w && target.y < grid.h
}

/**
 * The tile a move should actually head for: the requested one if it is on the
 * map and passable, a nearby passable tile if it is on the map and blocked, or
 * `null` if it is off the map or walled in beyond `MAX_RETARGET_RADIUS`.
 *
 * "Nearby" is nearest-by-ring, not nearest by true distance: see
 * `nearestPassable` for what the search actually promises.
 */
function resolveTarget(target: CommandTarget, grid: NavGrid): CommandTarget | null {
  if (!inBounds(target, grid)) return null
  if (grid.passable(target.x, target.y, INFANTRY)) return target
  return nearestPassable(target, grid)
}

/**
 * Search outward from a blocked tile in square rings.
 *
 * Rings rather than a flood fill because passability is all that matters here —
 * whether the tile can be *reached* is the flow field's question, and answering
 * it twice would mean solving a field just to validate a click. Within a ring
 * the closest tile by true (Euclidean) distance wins, so an orthogonal
 * neighbour beats a diagonal one; ties break on scan order, which is fixed, so
 * the same click on the same map always retargets to the same tile.
 *
 * The first ring holding anything passable wins outright, so this is not
 * Euclidean-nearest: from r = 3 outward a ring's corner is farther than a later
 * ring's edge (a hit at (+3,+3) is 4.243 away, one at (+4,0) is 4.000), and the
 * corner is returned. Deliberate — the rings are cheap, and at retarget
 * distances of a tile or two the difference is not visible in play.
 */
function nearestPassable(target: CommandTarget, grid: NavGrid): CommandTarget | null {
  for (let r = 1; r <= MAX_RETARGET_RADIUS; r += 1) {
    let best: CommandTarget | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // Only the ring's edge: everything inside it was covered by a smaller r.
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const x = target.x + dx
        const y = target.y + dy
        if (!grid.passable(x, y, INFANTRY)) continue
        const distance = dx * dx + dy * dy
        if (distance >= bestDistance) continue
        bestDistance = distance
        best = { x, y }
      }
    }
    if (best !== null) return best
  }
  return null
}
