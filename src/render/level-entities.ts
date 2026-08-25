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
 * The atlas holds `tree1`, `tree2`, `tree3` and `bush` and nothing else, while
 * level 1 annotates `tree`, `shrub` and `bird_left`. Trees pick a variant from
 * their tile position so a future forest is not one sprite repeated; `shrub`
 * is the bush.
 *
 * `bird_left` has no art in this atlas — `tools/spritegen` does not emit birds
 * yet — so it falls through to the default and draws as scenery. That is a
 * knowing placeholder, not an oversight: leaving it undrawn would put a hole in
 * the level where the annotation says something is, and inventing a bird from
 * the tree art would be worse.
 */
const TREE_VARIANTS = ['tree1', 'tree2', 'tree3'] as const
const PROP_SPRITES: Readonly<Record<string, string>> = {
  shrub: 'bush',
  bush: 'bush',
}
const DEFAULT_PROP_SPRITE = 'bush'

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
    const world = tileToWorld(spawn.x, spawn.y, level.size)
    entities.push({
      id: nextId++,
      unit: propSprite(spawn),
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

function propSprite(spawn: SpawnPoint): string {
  const type = typeof spawn.type === 'string' ? spawn.type : ''
  if (type.startsWith('tree')) {
    // Position-derived, not random: the same level must look the same on every
    // load, and re-rolling on a mission restart would be visible churn.
    const index = (spawn.x * 7 + spawn.y * 13) % TREE_VARIANTS.length
    return TREE_VARIANTS[index] ?? TREE_VARIANTS[0]
  }
  return PROP_SPRITES[type] ?? DEFAULT_PROP_SPRITE
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
