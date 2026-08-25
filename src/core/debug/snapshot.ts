/**
 * What the debug overlay would draw, as plain data (ticket 014).
 *
 * THE DECISIONS ON THIS SIDE, THE DRAWING ON THE OTHER. Vitest runs
 * `environment: 'node'`: there is no DOM and no WebGL at test time, so an
 * overlay written as one Three.js file would be verified by loading the page and
 * squinting at it. Everything that can be WRONG about the overlay — which tiles,
 * which arrows, which rays, whose state, whose position — is decided here and
 * asserted under Node; `src/render/debug-overlay.ts` is then a loop over these
 * arrays with no branch in it worth testing.
 *
 * THIS IS AN INSTRUMENT, SO IT MAY NOT HAVE OPINIONS OF ITS OWN. Every layer
 * below reports what the simulation already decided rather than recomputing it:
 * the LOS ray goes to the target `AiSystem` picked, the AI label says what
 * `AiSystem.stateOf` says. An overlay free to disagree with the machine it is
 * debugging is worse than no overlay — it sends a tuner hunting a bug in the
 * code that was right.
 *
 * The one exception is the flow field, and it is not really one: the arrows are
 * RECOMPUTED with `computeFlowField` from the same grid, the same mask and the
 * destination `squad.targetOf` reports. Same function, same inputs, same field —
 * without prising `SquadSystem`'s cache out into a public API that would then
 * have to stay public forever for the sake of a tool.
 *
 * A PURE READ. Nothing here advances, mutates or otherwise disturbs the session:
 * a headless replay and an overlaid one must produce the same mission, and the
 * only way to guarantee that is for looking to change nothing.
 *
 * SWITCHED OFF MEANS NOT COMPUTED, not merely not drawn. The nav grid is one
 * entry per tile and the flow field is a whole-map Dijkstra sweep per
 * destination, per frame; the machine running this is already struggling enough
 * for somebody to have opened the overlay.
 */

import { computeFlowField } from '../pathing/flowfield'
import { INFANTRY } from '../pathing/navgrid'
import type { DebugLayerId } from './layers'
import type { AiState } from '../ai'
import type { NavGrid } from '../pathing'
import type { Session } from '../session'
import type { Team } from '../world'

/** One tile of the nav grid, and whether a man may walk on it. */
export interface NavGridCell {
  readonly x: number
  readonly y: number
  readonly passable: boolean
}

/**
 * One flow-field arrow: the tile it is drawn in, the step it points along, and
 * the destination the field it came from descends to.
 *
 * The destination travels WITH the arrow rather than beside the array, because
 * two detachments marching to two places produce two fields and the tuner's
 * question is which arrow belongs to which order. `dx`/`dy` are the field's own
 * step components, each -1, 0 or 1.
 */
export interface FlowArrow {
  readonly x: number
  readonly y: number
  readonly dx: number
  readonly dy: number
  readonly targetX: number
  readonly targetY: number
}

/**
 * One live sightline: who is shooting, at whom, and between which two points.
 *
 * Endpoints are in WORLD units and are taken from the entities themselves, not
 * rebuilt from their tiles. A ray drawn half a tile off is exactly the kind of
 * thing that makes a tuner distrust the LOS code instead of the overlay.
 */
export interface LosRay {
  readonly shooterId: number
  readonly targetId: number
  readonly fromX: number
  readonly fromZ: number
  readonly toX: number
  readonly toZ: number
}

/** One enemy's state machine, and where to write the label. */
export interface AiMarker {
  readonly id: number
  readonly state: AiState
  readonly x: number
  readonly z: number
}

/** One entity's id, with the team the label is coloured by. */
export interface EntityLabel {
  readonly id: number
  readonly team: Team
  readonly x: number
  readonly z: number
}

/**
 * A frame's worth of drawable debug data.
 *
 * Every layer is present and empty rather than optional: the renderer then
 * loops over five arrays unconditionally, and a switched-off layer is the same
 * code path as a layer with nothing in it.
 */
export interface DebugSnapshot {
  readonly navGrid: readonly NavGridCell[]
  readonly flowField: readonly FlowArrow[]
  readonly losRays: readonly LosRay[]
  readonly ai: readonly AiMarker[]
  readonly entityIds: readonly EntityLabel[]
}

/** A snapshot with every layer empty — what `debugSnapshot` returns for no layers. */
export function emptySnapshot(): DebugSnapshot {
  return { navGrid: [], flowField: [], losRays: [], ai: [], entityIds: [] }
}

/**
 * The traversal class every layer is computed for.
 *
 * Infantry, because that is what the game spawns and what `SquadSystem` and
 * `AiSystem` both default to. A grid drawn for a different mask than the units
 * actually path with would be an overlay that quietly disagrees with the
 * movement it is there to explain.
 */
const MASK = INFANTRY

/** Every tile, with its passability. `O(w*h)`, which is why it is opt-in. */
function navGridCells(grid: NavGrid): NavGridCell[] {
  const cells: NavGridCell[] = []
  for (let y = 0; y < grid.h; y += 1) {
    for (let x = 0; x < grid.w; x += 1) {
      cells.push({ x, y, passable: grid.passable(x, y, MASK) })
    }
  }
  return cells
}

/**
 * One arrow per reachable cell with a direction, for every destination anybody
 * is currently marching to.
 *
 * The destinations come from `squad.targetOf` per living unit and are DEDUPED:
 * a squad of twelve under one order is one field, not twelve identical sweeps.
 * Nobody under orders means no destinations and therefore no arrows, which is
 * the honest answer — an arrow field drawn from a stale order is a picture of a
 * march that is not happening.
 *
 * Cells whose step is (0, 0) are skipped: that is the destination tile itself
 * and every cell walled off from it, and an arrow of zero length drawn at each
 * would be a dot on every unreachable tile on the map.
 */
function flowArrows(session: Session): FlowArrow[] {
  const arrows: FlowArrow[] = []
  const grid = session.grid
  // Insertion-ordered, and insertion is `world.entities` order, which is spawn
  // order: two runs of the same mission produce the arrows in the same order.
  const seen = new Set<string>()
  const entities = session.world.entities
  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i]
    if (entity === undefined) continue
    const target = session.squad.targetOf(entity.id)
    if (target === undefined) continue
    const key = `${String(target.x)},${String(target.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    // The same call `SquadSystem` makes, with the same grid and mask. Integer
    // tile indices mean the same tile in both of this engine's continuous tile
    // conventions, so there is no half-tile conversion to get wrong here.
    const field = computeFlowField(grid, target, MASK)
    for (let y = 0; y < grid.h; y += 1) {
      for (let x = 0; x < grid.w; x += 1) {
        const dx = field.dirX(x, y)
        const dy = field.dirY(x, y)
        if (dx === 0 && dy === 0) continue
        arrows.push({ x, y, dx, dy, targetX: field.target.x, targetY: field.target.y })
      }
    }
  }
  return arrows
}

/**
 * One ray per unit the state machine has in `engage`.
 *
 * The target is `AiSystem.targetOf`'s and never this file's. Recomputing
 * "nearest visible enemy" here would be a second rule for target choice, and
 * two rules disagree eventually — the man fires either way, and only the
 * overlay lies about where.
 *
 * A target that has died between the machine's last tick and this read simply
 * drops the ray rather than drawing one at the last known position: there is
 * nothing at the far end to point at.
 */
function losRays(session: Session): LosRay[] {
  const rays: LosRay[] = []
  const world = session.world
  const entities = world.entities
  for (let i = 0; i < entities.length; i += 1) {
    const shooter = entities[i]
    if (shooter === undefined) continue
    const targetId = session.ai.targetOf(shooter.id)
    if (targetId === undefined) continue
    const target = world.get(targetId)
    if (target === undefined) continue
    rays.push({
      shooterId: shooter.id,
      targetId,
      fromX: shooter.x,
      fromZ: shooter.z,
      toX: target.x,
      toZ: target.z,
    })
  }
  return rays
}

/**
 * One marker per living unit the state machine commands — the enemy, and only
 * the enemy.
 *
 * Membership is `stateOf(id) !== undefined` rather than `team === 'enemy'`,
 * because the team the machine commands is `AiOptions.team`'s business and not
 * this file's. It also answers the question the layer is actually asking: a
 * label reading `engage` over a man nobody is driving would be a fabrication.
 */
function aiMarkers(session: Session): AiMarker[] {
  const markers: AiMarker[] = []
  const entities = session.world.entities
  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i]
    if (entity === undefined) continue
    const state = session.ai.stateOf(entity.id)
    if (state === undefined) continue
    markers.push({ id: entity.id, state, x: entity.x, z: entity.z })
  }
  return markers
}

/** Every living entity, both teams. The dead are gone from the world already. */
function entityLabels(session: Session): EntityLabel[] {
  const labels: EntityLabel[] = []
  const entities = session.world.entities
  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i]
    if (entity === undefined) continue
    labels.push({ id: entity.id, team: entity.team, x: entity.x, z: entity.z })
  }
  return labels
}

/**
 * Compute the requested layers of `session`, and only those.
 *
 * `layers` is a list rather than a set of flags so the caller can hand this the
 * ids it toggled straight out of `DEBUG_LAYERS`; five entries make the
 * `includes` scans below cheaper than building a `Set` per frame would be.
 */
export function debugSnapshot(session: Session, layers: readonly DebugLayerId[]): DebugSnapshot {
  return {
    navGrid: layers.includes('navGrid') ? navGridCells(session.grid) : [],
    flowField: layers.includes('flowField') ? flowArrows(session) : [],
    losRays: layers.includes('losRays') ? losRays(session) : [],
    ai: layers.includes('ai') ? aiMarkers(session) : [],
    entityIds: layers.includes('entityIds') ? entityLabels(session) : [],
  }
}
