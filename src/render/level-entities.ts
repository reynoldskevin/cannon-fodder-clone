/**
 * Level spawn data -> `RenderEntity[]`.
 *
 * A STAND-IN FOR TICKET 005, and deliberately a thin one. `World` does not
 * exist yet, so something has to say where the soldiers are; when it does, it
 * emits the same `RenderEntity[]` and this file is deleted rather than
 * refactored. That is the point of `EntityRenderer` consuming plain data — it
 * never learns where the data came from.
 *
 * This replaces ticket 009's `spawn-markers.ts` coloured boxes.
 */

import type { LevelData, SpawnPoint } from '../core/level'
import type { RenderEntity } from '../core/render-state/entity'
import { tileToWorld } from '../core/view/projection'

/**
 * What the level's prop `type` strings map to in the ticket-004 atlas.
 *
 * EVERY ENTRY HERE IS A CLAIM THAT THE ART IS THE RIGHT ART, and a prop with no
 * entry draws NOTHING (ticket 010a). There is no default. Level 1 annotates
 * three props:
 *
 * - `shrub` -> `bush`. A substitution, and a defensible one: bush is the only
 *   shrub-like thing in the atlas and a shrub drawn as a bush is a shrub.
 * - `tree` -> nothing. Ticket 010 pointed this at a palm, which is where that
 *   ticket went wrong twice over. The map's trees are its 1,000 CANOPY TILES
 *   (see `scenery-entities.ts`); this single annotation at (45,36) is a
 *   separate gameplay marker — an objective landmark, a patrol anchor,
 *   something the sim will read — that has no art of its own yet. Drawing a
 *   palm there made one arbitrary tile look like the only tree on a map that is
 *   half jungle.
 * - `bird_left` -> nothing. `tools/spritegen` emits no birds. The previous
 *   fallback drew a bush, on the argument that a hole in the level is worse
 *   than a stand-in. It is not: a bush where a bird should be is a lie that
 *   nobody will ever notice and therefore nobody will ever fix, whereas an
 *   empty tile is a visible, honest, findable gap.
 */
const PROP_SPRITES: Readonly<Record<string, string>> = {
  shrub: 'bush',
  bush: 'bush',
}

/** Enemies are tinted so the two sides read apart at a glance. */
const ENEMY_TINT = 0xff9a86

/**
 * The animation every unit plays until a sim drives them.
 *
 * `walk` rather than `fire` or an idle: the atlas has no idle, and a walk cycle
 * on the spot at least proves the animation pipeline — fps, phase offset,
 * looping — is doing its job on screen. `die` is what one-shot holding is for
 * and is exercised the moment ticket 005 kills anything.
 */
const DEFAULT_ANIMATION = 'walk'

/**
 * Build the frame's worth of entities for a level's spawns.
 *
 * `groundHeightAt` comes from the terrain so feet sit on the tile's top face
 * rather than at y = 0 — a raised blocked tile would otherwise have a soldier
 * standing knee-deep in it.
 */
export function levelRenderEntities(
  level: LevelData,
  groundHeightAt: (tileX: number, tileY: number) => number,
): RenderEntity[] {
  const entities: RenderEntity[] = []
  // Ids must be unique across categories and stable frame to frame: they drive
  // the animation phase offset and the facing hysteresis memory.
  let nextId = 1

  const unit = (spawn: SpawnPoint, tint: number | undefined): RenderEntity => {
    const world = tileToWorld(spawn.x, spawn.y, level.size)
    const direction = facingVector(spawn.facing)
    return {
      id: nextId++,
      unit: 'soldier',
      animation: DEFAULT_ANIMATION,
      x: world.x,
      z: world.z,
      y: groundHeightAt(spawn.x, spawn.y),
      dx: direction.dx,
      dz: direction.dz,
      animationStart: 0,
      tint,
    }
  }

  for (const spawn of level.spawns.avatars) entities.push(unit(spawn, undefined))
  for (const spawn of level.spawns.enemies) entities.push(unit(spawn, ENEMY_TINT))

  for (const spawn of level.spawns.props) {
    const sprite = propSprite(spawn)
    // No art, no entity — and no id burned either, so the ids a level produces
    // do not shift the day a bird sprite appears.
    if (!sprite) continue
    const world = tileToWorld(spawn.x, spawn.y, level.size)
    entities.push({
      id: nextId++,
      unit: sprite,
      // Props are static; `UnitVisual` resolves any animation name to their one
      // held frame, so this never has to know that.
      animation: 'static',
      x: world.x,
      z: world.z,
      y: groundHeightAt(spawn.x, spawn.y),
      dx: 0,
      dz: 0,
      animationStart: 0,
      tint: undefined,
    })
  }

  return entities
}

/** The atlas source for a prop, or `null` when this build has no art for it. */
function propSprite(spawn: SpawnPoint): string | null {
  const type = typeof spawn.type === 'string' ? spawn.type : ''
  return PROP_SPRITES[type] ?? null
}

interface Direction {
  readonly dx: number
  readonly dz: number
}

/** `-z` is north — the convention `core/render-state/facing` is built on. */
const FACING_VECTORS: Readonly<Record<string, Direction>> = {
  N: { dx: 0, dz: -1 },
  NE: { dx: 1, dz: -1 },
  E: { dx: 1, dz: 0 },
  SE: { dx: 1, dz: 1 },
  S: { dx: 0, dz: 1 },
  SW: { dx: -1, dz: 1 },
  W: { dx: -1, dz: 0 },
  NW: { dx: -1, dz: -1 },
}

/**
 * A spawn's authored facing as a direction vector.
 *
 * Level 1 annotates no facings at all, so the fallback is what is actually
 * used: south, toward the camera. A unit whose direction is unknown should be
 * looking at the player rather than showing its back.
 */
function facingVector(facing: unknown): Direction {
  if (typeof facing !== 'string') return FACING_VECTORS.S ?? { dx: 0, dz: 1 }
  return FACING_VECTORS[facing.toUpperCase()] ?? { dx: 0, dz: 1 }
}
