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
 *
 * TICKET 009C — THE JUNGLE FLOOR. Tops are no longer flat colour: they sample a
 * tileable texture through world-space UVs and take their per-tile colour as a
 * TINT over it (see `groundTint` in `core/view/ground-tint`). Skirts are not
 * textured at all and keep the flat shaded colour they always had — see
 * `SIDE_MATERIAL_NOTE`.
 *
 * TICKET 034 — THREE GROUND TEXTURES. Water and the bridge sample their own art
 * instead of the jungle floor tinted blue and brown. A geometry group is how one
 * geometry addresses more than one material and groups must be CONTIGUOUS, so
 * the index buffer is now four concatenated lists — jungle tops, water tops,
 * bridge tops, skirts — over the same single vertex buffer. Four draw calls for
 * the whole terrain instead of two; still ONE geometry, still built once at load,
 * still nothing allocated per frame.
 */

import * as THREE from 'three'
import type { LevelData } from '../core/level'
import { FLOOR_REPEAT_WORLD_UNITS, floorUv } from '../core/view/floor-uv'
import { TILE_WORLD_SIZE, tileToWorld } from '../core/view/projection'
import { TERRAIN_SKIRT_FLOOR } from '../core/view/relief'
import { CANOPY_INTERIOR_COLOUR, tileStyle } from '../core/view/terrain-style'
import { GROUND_SURFACES, groundSurfaceFor, type GroundSurface } from '../core/view/ground-surface'
import { TINT_EXPOSURE, groundTint } from '../core/view/ground-tint'
import { CANOPY_TILE_ID, canopyDepth } from '../core/render-state/scenery'

/**
 * Bottom of the skirt at the map edge — deep enough that no gap shows at any
 * angle. Defined in `src/core/view/relief` because fit-to-level has to leave
 * room for this face on screen; one definition, two consumers.
 */
const SKIRT_FLOOR = TERRAIN_SKIRT_FLOOR

/** Side faces are darkened against their top face so edges read without a normal map. */
const SIDE_SHADE = 0.62

/**
 * Geometry-group material slots: one per ground texture, then the untextured
 * skirts.
 *
 * The tops are laid out in `GROUND_SURFACES` order so the slot for a surface is
 * its index in that list — one list, no second table to keep in step.
 */
const MATERIAL_SIDE = GROUND_SURFACES.length

interface Vec3 {
  x: number
  y: number
  z: number
}

/** The arrays one quad is appended to — one bundle so `pushQuad` keeps a readable signature. */
interface QuadTarget {
  readonly positions: number[]
  readonly normals: number[]
  readonly colours: number[]
  readonly uvs: number[]
  readonly indices: number[]
}

export class TerrainRenderer {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly materials: readonly THREE.MeshStandardMaterial[]
  /** Top-surface height of each tile, in row-major order — reused for placing markers. */
  private readonly heights: Float32Array
  private readonly size: { readonly w: number; readonly h: number }

  /**
   * `ground` carries all three tileable textures, required rather than optional:
   * a terrain built without them would be the flat-colour map ticket 009c exists
   * to replace, and silently falling back to the jungle for a missing water or
   * bridge image is exactly the "looks plausible, is wrong" outcome the boot
   * error overlay exists to prevent. The caller loads them and reports the
   * failure.
   */
  constructor(level: LevelData, ground: Record<GroundSurface, THREE.Texture>) {
    this.size = level.size
    const { w, h } = level.size

    this.heights = new Float32Array(w * h)
    const colours = new Array<THREE.Color>(w * h)
    const surfaces = new Array<GroundSurface>(w * h)

    const fallbackColour = new THREE.Color('#ff00ff')
    for (let y = 0; y < h; y += 1) {
      const terrainRow = level.terrain[y]
      const walkRow = level.walkable[y]
      for (let x = 0; x < w; x += 1) {
        const id = terrainRow?.[x] ?? 0
        const walkable = walkRow?.[x] ?? false
        const style = tileStyle(id, walkable)
        const index = y * w + x

        // THE CANOPY MASS (ticket 010a revision). Trees are planted on the
        // fringe of the jungle only, so interior canopy has nothing standing on
        // it and must read as solid canopy by itself: it rises toward the middle
        // of the mass and takes a lighter, sunlit-crown green. Height and colour
        // only — `walkable` is untouched, so nothing about movement changes.
        const depth = !walkable && id === CANOPY_TILE_ID ? canopyDepth(level, x, y) : 0
        // FLAT, whatever the depth. Canopy used to rise toward its middle; it
        // no longer rises at all — see `CANOPY_HEIGHT`. `depth` survives because
        // it still picks the interior COLOUR on the line below, which is now the
        // only thing distinguishing the inside of a forest from its edge.
        this.heights[index] = style.height
        colours[index] = new THREE.Color(depth > 0 ? CANOPY_INTERIOR_COLOUR : style.colour)
        // Which texture this tile's top samples. A decision taken in
        // `core/view`, where it is unit tested; all the renderer does with it is
        // choose an index list.
        surfaces[index] = groundSurfaceFor(id)
      }
    }

    const positions: number[] = []
    const normals: number[] = []
    const vertexColours: number[] = []
    const uvs: number[] = []
    // FOUR index lists over ONE vertex buffer: a top samples one of three ground
    // textures, a skirt samples none, and a group is how a single geometry
    // addresses more than one material. Concatenated below in this order, so the
    // groups are contiguous — which is the only layout `addGroup` can describe.
    const topIndices = {} as Record<GroundSurface, number[]>
    for (const surface of GROUND_SURFACES) topIndices[surface] = []
    const sideIndices: number[] = []

    const half = TILE_WORLD_SIZE / 2
    const sideColour = new THREE.Color()
    const topTint = new THREE.Color()

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const index = y * w + x
        const top = this.heights[index] ?? 0
        const colour = colours[index] ?? fallbackColour
        const surface = surfaces[index] ?? 'jungle'

        const centre = tileToWorld(x, y, level.size)
        const x0 = centre.x - half
        const x1 = centre.x + half
        const z0 = centre.z - half
        const z1 = centre.z + half

        // Top face. UVs come from the CORNERS' world positions — for EVERY
        // surface, not just the jungle — so the pattern runs straight through the
        // tile and into its neighbours and the tile grid leaves no trace in the
        // texture at all. It is what stops a run of river reading as a row of
        // squares.
        const tint = groundTint(surface, colour)
        this.pushQuad(
          { positions, normals, colours: vertexColours, uvs, indices: topIndices[surface] },
          { x: x0, y: top, z: z0 },
          { x: x1, y: top, z: z0 },
          { x: x1, y: top, z: z1 },
          { x: x0, y: top, z: z1 },
          { x: 0, y: 1, z: 0 },
          topTint.setRGB(tint.r, tint.g, tint.b),
          true,
        )

        // Sides stay flat and untextured — see SIDE_MATERIAL_NOTE at
        // `buildMaterials`. `TINT_EXPOSURE` is applied here too, and has to be:
        // it is what the top face's average brightness now is, so leaving the
        // skirts at ticket 009's raw colour would make the SIDES BRIGHTER THAN
        // THE TOPS and turn every raised block inside out.
        sideColour.copy(colour).multiplyScalar(SIDE_SHADE * TINT_EXPOSURE)

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
            { positions, normals, colours: vertexColours, uvs, indices: sideIndices },
            { x: a.x, y: top, z: a.z },
            { x: b.x, y: top, z: b.z },
            { x: b.x, y: bottom, z: b.z },
            { x: a.x, y: bottom, z: a.z },
            normal,
            sideColour,
            false,
          )
        }
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColours, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    // One index buffer, the four lists laid end to end, and one group per list.
    // A group is a (start, count) RANGE into that buffer, so the lists have to be
    // contiguous and the running offset is what makes them so.
    // Appended one at a time rather than spread: the lists run to tens of
    // thousands of entries and `push(...list)` passes each as an argument.
    let index: number[] = []
    let start = 0
    for (const surface of GROUND_SURFACES) {
      const list = topIndices[surface]
      index = index.concat(list)
      // A surface with no tiles on this map still gets a zero-length group, so
      // the slot numbering matches `materials` on every level.
      geometry.addGroup(start, list.length, GROUND_SURFACES.indexOf(surface))
      start += list.length
    }
    index = index.concat(sideIndices)
    geometry.addGroup(start, sideIndices.length, MATERIAL_SIDE)
    geometry.setIndex(index)
    geometry.computeBoundingSphere()
    this.geometry = geometry

    this.materials = TerrainRenderer.buildMaterials(ground)

    this.mesh = new THREE.Mesh(geometry, [...this.materials])
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
    for (const material of this.materials) material.dispose()
    // The ground textures are NOT disposed here: they are loaded once at boot
    // and owned by the caller, which may build a second level from them
    // (ticket 020, and ticket 024 fixing exactly this ownership bug for the
    // sprite atlas).
  }

  /**
   * The terrain materials: one per ground texture in `GROUND_SURFACES` order,
   * then `MATERIAL_SIDE`.
   *
   * SIDE_MATERIAL_NOTE — WHY THE SKIRTS ARE NOT TEXTURED. A skirt is a vertical
   * face. Sampling a top-down floor on it means either stretching one row of the
   * image down the whole face (a smear of whatever happened to be at that world
   * z — sometimes soil, sometimes half a fern pulled into a vertical streak), or
   * projecting the floor down the y axis so a fern appears to be growing out of
   * a cliff face at ninety degrees. Both look wrong, and both fight the one job
   * the skirts have: reading as the SIDE of a raised block so blocked terrain
   * looks solid. So they keep exactly the flat `SIDE_SHADE` colour ticket 009
   * gave them, which is a shaded version of the tile's own colour and therefore
   * still guaranteed darker than the top — the tint math above makes a textured
   * top average out to that same colour, and 0.62 of it is darker than it by
   * construction.
   *
   * The cost is one extra draw call for the whole terrain, which is not a cost.
   *
   * The skirts keep ONE flat material across every surface, water included. A
   * vertical face of the river is the bank it is cut into, not the water, and it
   * is what makes the river read as sunk below the ground rather than painted on
   * it.
   */
  private static buildMaterials(
    ground: Record<GroundSurface, THREE.Texture>,
  ): readonly THREE.MeshStandardMaterial[] {
    const common = { vertexColors: true, roughness: 0.95, metalness: 0 } as const
    const materials: THREE.MeshStandardMaterial[] = []
    for (const [slot, surface] of GROUND_SURFACES.entries()) {
      materials[slot] = new THREE.MeshStandardMaterial({ ...common, map: ground[surface] })
    }
    materials[MATERIAL_SIDE] = new THREE.MeshStandardMaterial({ ...common })
    return materials
  }

  /**
   * Emit one quad as two triangles, winding it so the face normal matches
   * `normal` rather than trusting the caller to get vertex order right per side.
   *
   * `textured` selects where the UVs come from: world position through
   * `floorUv` for a top face, and a single degenerate (0, 0) for a skirt, whose
   * material has no map and never reads them.
   */
  private pushQuad(
    target: QuadTarget,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    normal: Vec3,
    colour: THREE.Color,
    textured: boolean,
  ): void {
    const { positions, normals, colours, uvs, indices } = target
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
      if (textured) {
        const uv = floorUv(v.x, v.z, FLOOR_REPEAT_WORLD_UNITS)
        uvs.push(uv.u, uv.v)
      } else {
        uvs.push(0, 0)
      }
    }

    if (facesAway) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
}
