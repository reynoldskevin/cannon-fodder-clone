/**
 * Canopy scenery -> `RenderEntity[]` (ticket 010a).
 *
 * The bridge between `core/render-state/scenery` (which decides, in tile
 * coordinates, what stands where) and `EntityRenderer` (which draws
 * `RenderEntity`s and knows nothing about levels). Trees are not simulation
 * entities, but pushing them down the same path costs nothing and buys the
 * instanced batching for free: level 1's 727 fringe trees over three atlas rects
 * is three draws, the same three whether the forest is 727 trees or 10,000.
 *
 * SEPARATE FROM THE SESSION'S RENDER STATE DELIBERATELY. `core/session` assembles
 * the frame's soldiers, corpses and prop annotations — things that change, or at
 * least that a level author placed one at a time. The canopy is derived from the
 * terrain grid, is identical on every frame of the level's life, and is written
 * to the GPU once by `setScenery`; running it through the per-frame path would
 * rebuild 727 instances a frame to draw the same forest.
 */

import { canopyScenery, type SceneryLevel } from '../core/render-state/scenery'
import type { RenderEntity } from '../core/render-state/entity'
import { TILE_WORLD_SIZE, tileToWorld } from '../core/view/projection'

/**
 * Id space for scenery, kept clear of the simulation entity ids `World` issues
 * from 1 and of the prop-annotation ids `core/session` issues from 2,000,000.
 *
 * Ids are the key for facing memory and animation phase inside
 * `EntityRenderer`, so a collision between a tree and a soldier would have them
 * overwrite each other's state. A base far above any plausible unit count is
 * cheaper than a shared allocator that every producer would have to agree on.
 */
export const SCENERY_ID_BASE = 1_000_000

/**
 * The synthetic animation name static props answer to (`sprite-atlas`'s
 * `STATIC_CLIP`). Restated rather than imported so this module does not depend
 * on the atlas implementation; `AtlasUnitVisual` resolves any unknown animation
 * to the prop's single held frame anyway.
 */
const STATIC_ANIMATION = 'static'

/**
 * Every canopy tile's tree, as renderer input.
 *
 * `groundHeightAt` comes from the baked terrain so a tree's trunk meets the top
 * face of the block it grows out of rather than the ground plane below it.
 *
 * The jitter is in TILES and is scaled to world units here, because that
 * conversion is a projection concern and `core/render-state` deliberately knows
 * nothing about world space.
 */
export function canopyRenderEntities(
  level: SceneryLevel,
  groundHeightAt: (tileX: number, tileY: number) => number,
): RenderEntity[] {
  return canopyScenery(level).map((tree) => {
    const world = tileToWorld(tree.tileX, tree.tileY, level.size)
    return {
      id: SCENERY_ID_BASE + tree.id,
      unit: tree.sprite,
      // Trees do not animate. `frameAt` short-circuits a one-frame clip to
      // frame 0 before it touches fps or the clock, so nothing here has to
      // fake a clip or special-case the animation path — a static sprite is
      // already the degenerate case it handles.
      animation: STATIC_ANIMATION,
      x: world.x + tree.jitterX * TILE_WORLD_SIZE,
      z: world.z + tree.jitterY * TILE_WORLD_SIZE,
      // The tree's own tile, not the jittered position: the trunk belongs to
      // the block it grows from, and sampling the neighbour it leans toward
      // would leave it floating or sunk by that block's height difference.
      y: groundHeightAt(tree.tileX, tree.tileY),
      // No facing: props are direction-agnostic and `stableFacing` keeps the
      // default when handed a zero vector, so every tree lands in the same
      // batch as every other tree of its variant.
      dx: 0,
      dz: 0,
      animationStart: 0,
      tint: undefined,
    }
  })
}
