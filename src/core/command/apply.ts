/**
 * Applying a command to the world (ticket 008).
 *
 * WHERE VALIDATION LIVES. All of it, and only here. The queue is a buffer; this
 * is the one function that holds a `World`, a `NavGrid`, a `SquadSystem` and a
 * `CombatSystem`, and can therefore answer whether an id names anything living
 * and whether a tile exists. Keeping the two apart means a command that is going
 * to be dropped is still visible in the drained batch of the frame that dropped
 * it.
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
 * log. Accepted is not the same as "changed something": `selectOrdnance` names
 * no units and no tile, and changes the pouch's selection without touching the
 * world at all.
 *
 * WHY A FIRE COMMAND HAS TO REACH SOMETHING (ticket 011a). `fire` used to
 * validate and return true having done nothing at all, which is exactly what a
 * right-click that appears broken looks like from here: a well-formed command,
 * accepted, and no bullet ever leaving a rifle. A boolean that means
 * "well-formed" is not a boolean that means "something happened".
 */

import { INFANTRY, type NavGrid } from '../pathing'
import { ORDNANCE } from '../ordnance'
import type { Armoury } from '../armoury'
import type { CombatSystem } from '../combat'
import type { OrdnanceSystem } from '../ordnance'
import type { SquadSystem } from '../squad'
import type { FireCommand } from './types'
import type { World } from '../world/world'
import type { Command, CommandTarget } from './types'

/** Everything a command needs in order to be applied. */
export interface CommandContext {
  readonly world: World
  readonly squad: SquadSystem
  /** Where `fire` and `ceaseFire` go. Holds the standing orders. */
  readonly combat: CombatSystem
  readonly grid: NavGrid
  /**
   * Where a `fire` naming a row of `ORDNANCE` goes instead (ticket 016).
   *
   * OPTIONAL, AND THE FALLBACK IS THE PRE-016 BEHAVIOUR: without it every
   * `fire` is a rifle order, whatever it names. A context with no ordnance
   * system is a caller that has not registered one, and refusing its throws
   * outright would turn "this harness does not fly grenades" into "this
   * harness's squad cannot shoot".
   */
  readonly ordnance?: OrdnanceSystem
  /** The squad's pouch and its selection (ticket 016). Optional for the same reason. */
  readonly armoury?: Armoury
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
 * `move` retargets the squad system; a rifle `fire` and `ceaseFire` set and
 * clear a standing order on the combat system; a `fire` naming a row of
 * `ORDNANCE` throws a single round and spends one from the pouch;
 * `selectOrdnance` changes what the input layer will name next.
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
      if (!inBounds(command.target, ctx.grid)) return false
      // THE COMMAND'S OWN `ordnance` DECIDES THE ROUTING, NOT THE SELECTION
      // (ticket 016). The input layer is what consults `armoury.selected` when
      // it builds the command; reading it here would make the simulation a
      // function of what the HUD happened to have selected, and a mission
      // replayed from a command log would then diverge from the one it recorded.
      //
      // A name in the table is a SINGLE round out of a finite pouch; anything
      // else is the rifle, and the rifle is untouched — a standing order the
      // combat system fires once per cooldown until a `ceaseFire` arrives, with
      // no ammunition anywhere in it. That split is what stops this branch from
      // being able to break the only offensive verb the game already had.
      const launcher = ctx.ordnance
      const armoury = ctx.armoury
      if (
        ORDNANCE[command.ordnance] !== undefined &&
        launcher !== undefined &&
        armoury !== undefined
      ) {
        return launchOrdnance(command, ids, launcher, armoury, ctx.world)
      }
      ctx.combat.orderFire(ids, command.target)
      return true
    }
    case 'ceaseFire': {
      const ids = livingIds(command.unitIds, ctx.world)
      if (ids.length === 0) return false
      ctx.combat.ceaseFire(ids)
      return true
    }
    case 'selectOrdnance':
      // Names no units and no tile, so there is nothing to validate against the
      // world — only against the list of weapons that exist, which is the
      // armoury's. A context without one has nothing to select and accepts the
      // command unchanged, exactly as it did from ticket 008 to ticket 015.
      if (ctx.armoury === undefined) return true
      return ctx.armoury.select(command.ordnance)
    default:
      return assertNever(command)
  }
}

/**
 * Put one round of ordnance into the air, and charge the pouch for it.
 *
 * ONE ROUND PER COMMAND, THROWN BY THE FIRST LIVING MAN NAMED. A `fire` command
 * arrives EVERY FRAME the button is held — that is how ticket 011a's standing
 * order works — so the rate at which grenades leave has to be bounded by
 * something other than the command stream. Ticket 015's PER-UNIT cooldown is
 * that bound, and it only bounds anything if the same man is asked each time:
 * walking the whole selection until somebody was off cooldown would empty a
 * five-man squad's entire supply in five frames of one press.
 *
 * THE POUCH IS CHARGED FOR A ROUND THAT ACTUALLY LEFT, never for a request.
 * `launch` returns false for a man still on cooldown, and spending on that
 * would cost the squad a grenade sixty times a second for holding a button.
 *
 * A refusal for an EMPTY POUCH is announced; a refusal for a cooldown is not.
 * The first is a fact the player cannot otherwise discover — an empty pouch and
 * a dead button look identical — and the second is the weapon working as
 * designed, sixty times a second, which on the bus would be noise.
 */
function launchOrdnance(
  command: FireCommand,
  ids: readonly number[],
  ordnance: OrdnanceSystem,
  armoury: Armoury,
  world: World,
): boolean {
  if (armoury.count(command.ordnance) <= 0) {
    world.emit({
      type: 'FireRejected',
      ordnance: command.ordnance,
      reason: 'no rounds left',
    })
    return false
  }
  const thrower = ids[0]
  if (thrower === undefined) return false
  if (!ordnance.launch(thrower, command.ordnance, command.target)) return false
  armoury.consume(command.ordnance)
  return true
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
