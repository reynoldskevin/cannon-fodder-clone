/**
 * SceneBuilder — turns a validated `LevelData` into a ready-to-render Three.js
 * scene: sky, fog, lights with shadows, the baked terrain mesh and the
 * placeholder spawn markers.
 *
 * Everything it builds is static for the level's lifetime. Nothing here runs per
 * frame; `dispose()` tears the whole thing down when a level is unloaded.
 */

import * as THREE from 'three'
import type { LevelData } from '../core/level'
import { levelWorldBounds } from '../core/view/projection'
import { TerrainRenderer } from './terrain-renderer'
import { buildSpawnMarkers, disposeSpawnMarkers } from './spawn-markers'

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
  readonly sun: THREE.DirectionalLight
  readonly bounds: ReturnType<typeof levelWorldBounds>
  dispose(): void
}

export class SceneBuilder {
  /** Build the complete scene graph for a level. */
  static build(level: LevelData): BuiltScene {
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

    const markers = buildSpawnMarkers(level, terrain)
    scene.add(markers)

    return {
      scene,
      terrain,
      sun,
      bounds,
      dispose(): void {
        disposeSpawnMarkers(markers)
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
