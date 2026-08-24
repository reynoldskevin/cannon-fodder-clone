/**
 * TerrainRenderer — bakes a whole level into ONE merged BufferGeometry.
 *
 * 57x45 = 2565 tiles. A mesh per tile would be 2565 draw calls and 2565 matrix
 * updates a frame; this is one draw call and one static geometry, built once at
 * level load and never touched again (acceptance criterion: no per-frame
 * geometry allocation).
 *
 * Appearance comes entirely from `src/core/view/terrain-style` — the renderer
 * decides nothing about colour or height, it only turns those numbers into
 * vertices, so the decision stays unit tested on the engine-free side.
 *
 * Geometry per tile: one top quad at the tile's style height, plus a vertical
 * skirt quad on each side where the neighbour is *lower* (or where the level
 * ends). Hidden interior walls are never emitted, which is what keeps a
 * mostly-flat map cheap while blocked tiles still read as solid raised blocks.
 */

import * as THREE from 'three'
import type { LevelData } from '../core/level'
import { TILE_WORLD_SIZE, tileToWorld } from '../core/view/projection'
import { TERRAIN_SKIRT_FLOOR } from '../core/view/relief'
import { tileStyle } from '../core/view/terrain-style'

/**
 * Bottom of the skirt at the map edge — deep enough that no gap shows at any
 * angle. Defined in `src/core/view/relief` because fit-to-level has to leave
 * room for this face on screen; one definition, two consumers.
 */
const SKIRT_FLOOR = TERRAIN_SKIRT_FLOOR

/** Side faces are darkened against their top face so edges read without a normal map. */
const SIDE_SHADE = 0.62

interface Vec3 {
  x: number
  y: number
  z: number
}

export class TerrainRenderer {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshStandardMaterial
  /** Top-surface height of each tile, in row-major order — reused for placing markers. */
  private readonly heights: Float32Array
  private readonly size: { readonly w: number; readonly h: number }

  constructor(level: LevelData) {
    this.size = level.size
    const { w, h } = level.size

    this.heights = new Float32Array(w * h)
    const colours = new Array<THREE.Color>(w * h)

    const fallbackColour = new THREE.Color('#ff00ff')
    for (let y = 0; y < h; y += 1) {
      const terrainRow = level.terrain[y]
      const walkRow = level.walkable[y]
      for (let x = 0; x < w; x += 1) {
        const id = terrainRow?.[x] ?? 0
        const walkable = walkRow?.[x] ?? false
        const style = tileStyle(id, walkable)
        const index = y * w + x
        this.heights[index] = style.height
        colours[index] = new THREE.Color(style.colour)
      }
    }

    const positions: number[] = []
    const normals: number[] = []
    const vertexColours: number[] = []
    const indices: number[] = []

    const half = TILE_WORLD_SIZE / 2
    const sideColour = new THREE.Color()

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const index = y * w + x
        const top = this.heights[index] ?? 0
        const colour = colours[index] ?? fallbackColour

        const centre = tileToWorld(x, y, level.size)
        const x0 = centre.x - half
        const x1 = centre.x + half
        const z0 = centre.z - half
        const z1 = centre.z + half

        // Top face.
        this.pushQuad(
          positions,
          normals,
          vertexColours,
          indices,
          { x: x0, y: top, z: z0 },
          { x: x1, y: top, z: z0 },
          { x: x1, y: top, z: z1 },
          { x: x0, y: top, z: z1 },
          { x: 0, y: 1, z: 0 },
          colour,
        )

        sideColour.copy(colour).multiplyScalar(SIDE_SHADE)

        // Skirts, one per neighbour that sits lower (or off the map).
        const neighbours: readonly [number, number, Vec3][] = [
          [-1, 0, { x: -1, y: 0, z: 0 }],
          [1, 0, { x: 1, y: 0, z: 0 }],
          [0, -1, { x: 0, y: 0, z: -1 }],
          [0, 1, { x: 0, y: 0, z: 1 }],
        ]

        for (const [dx, dy, normal] of neighbours) {
          const nx = x + dx
          const ny = y + dy
          const inside = nx >= 0 && nx < w && ny >= 0 && ny < h
          const bottom = inside ? (this.heights[ny * w + nx] ?? 0) : SKIRT_FLOOR
          if (bottom >= top) continue

          // The shared edge between this tile and that neighbour.
          const [a, b] =
            dx === -1
              ? ([{ x: x0, z: z0 }, { x: x0, z: z1 }] as const)
              : dx === 1
                ? ([{ x: x1, z: z0 }, { x: x1, z: z1 }] as const)
                : dy === -1
                  ? ([{ x: x0, z: z0 }, { x: x1, z: z0 }] as const)
                  : ([{ x: x0, z: z1 }, { x: x1, z: z1 }] as const)

          this.pushQuad(
            positions,
            normals,
            vertexColours,
            indices,
            { x: a.x, y: top, z: a.z },
            { x: b.x, y: top, z: b.z },
            { x: b.x, y: bottom, z: b.z },
            { x: a.x, y: bottom, z: a.z },
            normal,
            sideColour,
          )
        }
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColours, 3))
    geometry.setIndex(indices)
    geometry.computeBoundingSphere()
    this.geometry = geometry

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = `terrain:${level.name}`
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    // Static for the level's lifetime: skip the per-frame world-matrix rebuild.
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
  }

  /** Number of triangles in the baked mesh — surfaced for the boot log. */
  get triangleCount(): number {
    return (this.geometry.getIndex()?.count ?? 0) / 3
  }

  /** Top-surface height of a tile, so markers and (later) units sit on the ground. */
  heightAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.size.w || y >= this.size.h) return 0
    return this.heights[y * this.size.w + x] ?? 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  /**
   * Emit one quad as two triangles, winding it so the face normal matches
   * `normal` rather than trusting the caller to get vertex order right per side.
   */
  private pushQuad(
    positions: number[],
    normals: number[],
    colours: number[],
    indices: number[],
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    normal: Vec3,
    colour: THREE.Color,
  ): void {
    const base = positions.length / 3

    // Geometric normal of triangle (a, b, c); flip the winding if it faces away.
    const ux = b.x - a.x
    const uy = b.y - a.y
    const uz = b.z - a.z
    const vx = c.x - a.x
    const vy = c.y - a.y
    const vz = c.z - a.z
    const gx = uy * vz - uz * vy
    const gy = uz * vx - ux * vz
    const gz = ux * vy - uy * vx
    const facesAway = gx * normal.x + gy * normal.y + gz * normal.z < 0

    for (const v of [a, b, c, d]) {
      positions.push(v.x, v.y, v.z)
      normals.push(normal.x, normal.y, normal.z)
      colours.push(colour.r, colour.g, colour.b)
    }

    if (facesAway) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
}
