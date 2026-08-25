/**
 * SceneBuilder — turns a validated `LevelData` into a ready-to-render Three.js
 * scene: sky, fog, lights with shadows, the baked terrain mesh and the sprite
 * entities standing on it.
 *
 * The terrain half is static for the level's lifetime and nothing about it runs
 * per frame. The entity half is not: `BuiltScene.entities` must be updated
 * every frame, which is the caller's job. `dispose()` tears both down when a
 * level is unloaded.
 *
 * Ticket 010 replaced the placeholder coloured boxes (`spawn-markers.ts`, now
 * deleted) with the real sprite `EntityRenderer`.
 */

import * as THREE from 'three'
import type { LevelData } from '../core/level'
import { ELEVATION } from '../core/view/orientation'
import { levelWorldBounds } from '../core/view/projection'
import { TerrainRenderer } from './terrain-renderer'
import { EntityRenderer } from './entity-renderer'
import { levelRenderEntities } from './level-entities'
import { canopyRenderEntities } from './scenery-entities'
import type { UnitVisual } from './sprite-atlas'

/** Horizon/sky colour, also the fog colour so the map fades into it rather than into black. */
const SKY_COLOUR = 0x9fc6d8
const GROUND_BOUNCE_COLOUR = 0x4a5a3a
const SUN_COLOUR = 0xfff3dc

/** Fog sits well behind the level so it reads as aerial haze, not as a grey wash. */
const FOG_NEAR = 105
const FOG_FAR = 230

export interface BuiltScene {
  readonly scene: THREE.Scene
  readonly terrain: TerrainRenderer
  readonly entities: EntityRenderer
  readonly sun: THREE.DirectionalLight
  readonly bounds: ReturnType<typeof levelWorldBounds>
  dispose(): void
}

export class SceneBuilder {
  /**
   * Build the complete scene graph for a level.
   *
   * `visual` is passed in already loaded rather than fetched here: the atlas is
   * an async network resource and this stays synchronous, so a caller that has
   * not got the art yet is a compile error rather than a half-built scene.
   *
   * `elevationRad` is the camera's, and the sprite quads are tilted to match —
   * see `EntityRenderer`'s header for why the two must agree.
   */
  static build(level: LevelData, visual: UnitVisual, elevationRad: number = ELEVATION): BuiltScene {
    const scene = new THREE.Scene()
    scene.name = `level:${level.name}`
    scene.background = new THREE.Color(SKY_COLOUR)
    scene.fog = new THREE.Fog(SKY_COLOUR, FOG_NEAR, FOG_FAR)

    // Sky/ground bounce: cheap ambient that still gives the terrain a top-lit
    // feel, so unlit faces are tinted rather than flat black.
    const hemi = new THREE.HemisphereLight(SKY_COLOUR, GROUND_BOUNCE_COLOUR, 1.15)
    hemi.name = 'light:hemisphere'
    scene.add(hemi)

    const bounds = levelWorldBounds(level.size)
    const radius = Math.max(bounds.maxX, bounds.maxZ) * 1.25 + 4

    const sun = new THREE.DirectionalLight(SUN_COLOUR, 2.2)
    sun.name = 'light:sun'
    // Low-ish and off-axis from the camera yaw, so raised blocked tiles throw a
    // shadow the player can actually see rather than one hidden behind them.
    sun.position.set(-radius * 0.9, radius * 1.4, radius * 0.6)
    sun.target.position.set(0, 0, 0)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -radius
    sun.shadow.camera.right = radius
    sun.shadow.camera.top = radius
    sun.shadow.camera.bottom = -radius
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = radius * 4
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.02
    sun.shadow.camera.updateProjectionMatrix()
    scene.add(sun)
    scene.add(sun.target)

    const terrain = new TerrainRenderer(level)
    scene.add(terrain.mesh)

    const entities = new EntityRenderer(visual, elevationRad)
    scene.add(entities.group)
    // Seed both sim states with the same spawn list. Until ticket 005 exists
    // there is no motion to interpolate, and calling this twice is what makes
    // `previous` and `current` agree rather than the first frame lerping from
    // an empty world.
    // The forest, from the terrain itself (ticket 010a). Static for the level's
    // lifetime, so it is written to the GPU once here and never rebuilt — see
    // `EntityRenderer`'s header for why it does not go through `setEntities`.
    entities.setScenery(canopyRenderEntities(level, (x, y) => terrain.heightAt(x, y)))
    const spawned = levelRenderEntities(level, (x, y) => terrain.heightAt(x, y))
    entities.setEntities(spawned)
    entities.setEntities(spawned)
    // Prime the instance buffers so the scene is complete the moment it is
    // returned: the first rendered frame is then already right, and callers can
    // report the draw-call count without having rendered anything.
    entities.update(0, 1)

    return {
      scene,
      terrain,
      entities,
      sun,
      bounds,
      dispose(): void {
        entities.dispose()
        terrain.dispose()
        // The shadow map is a 2048x2048 depth render target (~16 MB) owned by
        // the light, not by the scene graph: `scene.clear()` drops the reference
        // but never frees the GPU texture. Ticket 020 rebuilds a scene per
        // mission, so skipping this leaks one map per transition.
        sun.shadow.dispose()
        scene.clear()
      },
    }
  }
}
