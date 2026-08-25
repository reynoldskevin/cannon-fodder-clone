/**
 * The level's hand-placed PROP ANNOTATIONS as `RenderEntity[]` (ticket 008a).
 *
 * This is the half of the deleted `src/render/level-entities.ts` that was never
 * a stand-in. That file did two jobs: drawing soldiers from spawn data, which
 * `World` now owns, and drawing the map's prop annotations, which no simulation
 * will ever own because a shrub is not a combatant. The first job died with the
 * file; the second is here, unchanged, along with the reasoning that settled it.
 *
 * It lives under `core/` rather than `render/` because it is pure data mapping —
 * a tile and a type string in, a `RenderEntity` out — with no engine anywhere in
 * it, and because the session is now the one place that assembles a frame's
 * worth of render entities.
 */

import type { LevelData, SpawnPoint } from '../level/types'
import type { RenderEntity } from '../render-state/entity'
import { palmVariantFor } from '../render-state/scenery'
import { tileToWorld } from '../view/projection'

/**
 * What the level's prop `type` strings map to in the ticket-004 atlas.
 *
 * EVERY ENTRY HERE IS A CLAIM THAT THE ART IS THE RIGHT ART, and a prop with no
 * entry draws NOTHING (ticket 010a). There is no default. Level 1 annotates
 * three props:
 *
 * - `shrub` -> `bush`. A substitution, and a defensible one: bush is the only
 *   shrub-like thing in the atlas and a shrub drawn as a bush is a shrub.
 * - `tree` -> a PALM, picked per tile from `palmtree1/2/3`. Not a fixed sprite,
 *   so it is not in the table below; see `propSprite`.
 *
 *   The history matters, because this entry has now been wrong in both
 *   directions. Ticket 010 drew a palm here AND left the actual jungle as bare
 *   green blocks, so the map's one annotated tree was the only tree on a map
 *   that is half forest — the palm was not the mistake, the missing forest was.
 *   Ticket 010a fixed the forest (`src/render/scenery-entities.ts` plants the
 *   broadleaf art on the canopy fringe) and then over-corrected here, drawing
 *   nothing at all, which silently discards a thing the map's author
 *   deliberately placed. An annotation is a hand-made mark: the forest is
 *   terrain, this is a landmark, and the palms are the art that says so — a
 *   different silhouette in a different style, which is exactly what a landmark
 *   in a broadleaf jungle should be. The tile still carries whatever gameplay
 *   meaning the sim later reads off it; drawing it does not spend that.
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

/** Prop types drawn with a per-tile palm rather than one fixed sprite. */
const PALM_PROP_TYPES: ReadonlySet<string> = new Set(['tree'])

/**
 * The synthetic animation name static props answer to. `UnitVisual` resolves any
 * animation it does not know to the prop's single held frame, so this never has
 * to look the prop up in a clip table.
 */
const STATIC_ANIMATION = 'static'

/**
 * Every drawable prop annotation on the level, in level order.
 *
 * Ids are handed out from `idBase` and only to props that actually draw, so a
 * prop with no art burns no id and the ids a level produces do not shift the day
 * a bird sprite appears. They are a pure function of the level, so they are the
 * same on every frame and in every session built from that level.
 *
 * `groundHeightAt` comes from the terrain so a prop sits on the top face of its
 * tile rather than at y = 0 — a shrub on a raised blocked tile would otherwise
 * be buried in it.
 */
export function propRenderEntities(
  level: LevelData,
  groundHeightAt: (tileX: number, tileY: number) => number,
  idBase: number,
): RenderEntity[] {
  const entities: RenderEntity[] = []
  let nextId = idBase
  for (const spawn of level.spawns.props) {
    const sprite = propSprite(spawn)
    if (sprite === null) continue
    const world = tileToWorld(spawn.x, spawn.y, level.size)
    entities.push({
      id: nextId,
      unit: sprite,
      animation: STATIC_ANIMATION,
      x: world.x,
      z: world.z,
      y: groundHeightAt(spawn.x, spawn.y),
      // Props are direction-agnostic, and the renderer reads a zero vector as
      // "keep the facing you had", so every prop of a variant stays in one batch.
      dx: 0,
      dz: 0,
      animationStart: 0,
      tint: undefined,
    })
    nextId += 1
  }
  return entities
}

/**
 * The atlas source for a prop, or `null` when this build has no art for it.
 *
 * Palms are chosen from the spawn's own tile, not from its index in the list, so
 * re-ordering or adding annotations elsewhere on the map never changes which
 * palm an existing one draws.
 */
function propSprite(spawn: SpawnPoint): string | null {
  const type = typeof spawn.type === 'string' ? spawn.type : ''
  if (PALM_PROP_TYPES.has(type)) return palmVariantFor(spawn.x, spawn.y)
  return PROP_SPRITES[type] ?? null
}
