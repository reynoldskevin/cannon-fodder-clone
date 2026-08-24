/**
 * Minimal spawn markers: a coloured box on each spawn tile so the map is legible
 * before real units exist (ticket 010 replaces these). Deliberately NOT an
 * entity system — one static group, built once, never updated.
 *
 * Blue = avatars, red = enemies, yellow = props, white = chests.
 */

import * as THREE from 'three'
import type { LevelData, SpawnPoint } from '../core/level'
import { tileToWorld } from '../core/view/projection'
import type { TerrainRenderer } from './terrain-renderer'

const MARKER_COLOURS = {
  avatars: 0x3d7bff,
  enemies: 0xe23b3b,
  props: 0xf2c744,
  chests: 0xf2f2f2,
} as const

const MARKER_SIZE = { avatars: 0.55, enemies: 0.55, props: 0.4, chests: 0.45 } as const
const MARKER_HEIGHT = { avatars: 1.1, enemies: 1.1, props: 0.6, chests: 0.5 } as const

export function buildSpawnMarkers(level: LevelData, terrain: TerrainRenderer): THREE.Group {
  const group = new THREE.Group()
  group.name = 'spawn-markers'

  const categories: readonly (keyof typeof MARKER_COLOURS)[] = [
    'avatars',
    'enemies',
    'props',
    'chests',
  ]

  for (const category of categories) {
    const spawns: readonly SpawnPoint[] = level.spawns[category]
    if (spawns.length === 0) continue

    // One geometry and one material per category, shared by every instance of it.
    const size = MARKER_SIZE[category]
    const height = MARKER_HEIGHT[category]
    const geometry = new THREE.BoxGeometry(size, height, size)
    const material = new THREE.MeshStandardMaterial({
      color: MARKER_COLOURS[category],
      roughness: 0.5,
      metalness: 0.05,
      emissive: MARKER_COLOURS[category],
      emissiveIntensity: 0.18,
    })

    for (const spawn of spawns) {
      const p = tileToWorld(spawn.x, spawn.y, level.size)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(p.x, terrain.heightAt(spawn.x, spawn.y) + height / 2, p.z)
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      mesh.name = `spawn:${category}:${String(spawn.x)},${String(spawn.y)}`
      group.add(mesh)
    }
  }

  group.matrixAutoUpdate = false
  group.updateMatrix()
  return group
}

/**
 * Release the geometries/materials created above.
 *
 * Deduplicated first: one geometry and one material are SHARED by every marker
 * in a category, so walking the meshes naively would dispose each of them once
 * per instance. Three's second `dispose()` re-fires the `dispose` event on an
 * object whose GPU resources are already gone, which is at best wasted work and
 * at worst frees a resource a later-built scene has re-registered.
 */
export function disposeSpawnMarkers(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()

  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue
    geometries.add(child.geometry)
    const material: THREE.Material | THREE.Material[] = child.material
    if (Array.isArray(material)) for (const m of material) materials.add(m)
    else materials.add(material)
  }

  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
}
