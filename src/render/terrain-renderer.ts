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
 * TICKET 009C — THE JUNGLE FLOOR. Tops are no longer flat colour: they sample
 * the tileable `floor.png` through world-space UVs and take their per-tile
 * colour as a TINT over it (see `floorTint` below). Skirts are not textured at
 * all and keep the flat shaded colour they always had — see `SIDE_MATERIAL`.
 * That is two materials, so the mesh carries two geometry groups and costs two
 * draw calls instead of one; still one geometry, still built once at load.
 */

import * as THREE from 'three'
import type { LevelData } from '../core/level'
import { FLOOR_REPEAT_WORLD_UNITS, floorUv } from '../core/view/floor-uv'
import { TILE_WORLD_SIZE, tileToWorld } from '../core/view/projection'
import { TERRAIN_SKIRT_FLOOR } from '../core/view/relief'
import { CANOPY_INTERIOR_COLOUR, canopyMassHeight, tileStyle } from '../core/view/terrain-style'
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
 * Mean colour of `floor.png` in LINEAR space, measured off the asset:
 *
 *     node -e "const {PNG}=require('pngjs'),fs=require('fs');
 *       const p=PNG.sync.read(fs.readFileSync('public/generated/sprites/floor.png'));
 *       const lin=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4};
 *       let a=[0,0,0];for(let i=0;i<p.data.length;i+=4)for(let c=0;c<3;c++)a[c]+=lin(p.data[i+c]);
 *       console.log(a.map(v=>(v/(p.width*p.height)).toFixed(4)))"
 *
 * It matters because the floor is DARK — luminance 0.061 linear, a deep olive —
 * and multiplying it by the old vertex colours unchanged would have dropped the
 * whole map to about a fifth of the brightness ticket 009 tuned. The tint has to
 * be a gain, and the gain has to be computed against this number. Hardcoded
 * rather than measured at runtime: reading it back from the GPU would mean a
 * canvas round trip on boot to recover a constant that only changes when the
 * art does.
 */
const FLOOR_MEAN_LINEAR = { r: 0.0693, g: 0.0642, b: 0.0093 } as const

/** Rec. 709 luminance — the same weighting three uses internally. */
const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

const FLOOR_MEAN_LUMINANCE = luminance(FLOOR_MEAN_LINEAR.r, FLOOR_MEAN_LINEAR.g, FLOOR_MEAN_LINEAR.b)

/**
 * How much of a tile's own HUE is pushed onto the floor texture, 0..1.
 *
 * 0 leaves the texture's own colour alone and only matches its brightness to the
 * tile; 1 forces the tile's average colour to equal ticket 009's flat colour
 * exactly. 1 is wrong here: the floor's blue channel is nearly empty (0.009
 * linear), so an exact match needs an 8x blue gain, and that turns every grey
 * pebble in the art violet and drains the greens.
 *
 * 0.35 is the compromise that shipped. It is enough that canopy tiles pull the
 * floor visibly greener and deeper, and that rock tiles pull it paler and
 * greyer, while the ferns and leaf litter keep their painted colour on all of
 * them. Below about 0.2 the terrain types stop separating by hue and rely on
 * brightness alone; above about 0.5 the rock tiles go grey enough that the
 * jungle art stops reading as jungle on them.
 */
const TINT_HUE_STRENGTH = 0.35

/**
 * What fraction of ticket 009's flat albedo the textured floor reproduces.
 *
 * 1.0 makes the floor's MEAN colour equal the old flat colour exactly — which
 * sounds like the obviously correct answer and is not. The floor has a wide
 * dynamic range (deep soil against sunlit fronds) where the flat colour had
 * none, so a gain that lifts its mean to 0.288 linear takes the fronds to about
 * 1.9 before the sun is even applied. Everything above white clips, the greens
 * flatten into a pale yellow wash, and the map stops looking like jungle floor
 * and starts looking like straw. That is exactly what 1.0 rendered.
 *
 * 0.5 is the value that keeps the fronds inside the range once the sun and the
 * hemisphere fill are applied, so the floor arrives on screen looking like the
 * art it was painted as: deep soil, mossy green, orange leaf litter. It costs
 * half a stop of overall map brightness against ticket 009, which is a fair
 * trade and arguably an improvement — the old map was a bright green that no
 * jungle floor is.
 *
 * It is applied to the SKIRTS as well, so the tops/sides relationship is
 * untouched by it.
 */
const TINT_EXPOSURE = 0.5

/**
 * The tint a tile's flat colour becomes once the floor texture is multiplied in.
 *
 * The material computes `texture * vertexColour`, so the vertex colour is no
 * longer "the colour of the tile" — it is "what the floor has to be multiplied
 * by to LOOK like that tile". Two components:
 *
 *   gain — a scalar that lifts the floor's mean luminance to the tile's, so the
 *     textured map has exactly the brightness ticket 009 chose. This is why
 *     canopy still reads darker than grass and blocked still reads distinct from
 *     walkable: the hierarchy is preserved by construction, not by eye.
 *   correction — the per-channel ratio between the tile's hue and the floor's,
 *     mixed in at `TINT_HUE_STRENGTH`.
 *
 * The result is renormalised so the mixing cannot drift the luminance it was the
 * whole point of preserving. Values above 1 are expected and fine: this is a
 * linear float multiplier, not a colour, and it is only clamped at output.
 */
function floorTint(colour: THREE.Color, out: THREE.Color): THREE.Color {
  const tileLuminance = luminance(colour.r, colour.g, colour.b)
  if (tileLuminance <= 0) return out.setRGB(0, 0, 0)

  const target = tileLuminance * TINT_EXPOSURE
  const gain = target / FLOOR_MEAN_LUMINANCE
  const mix = (tile: number, floor: number): number => {
    // Both normalised to luminance 1 first, so this is hue and nothing else.
    const correction = tile / tileLuminance / (floor / FLOOR_MEAN_LUMINANCE)
    return 1 - TINT_HUE_STRENGTH + TINT_HUE_STRENGTH * correction
  }

  out.setRGB(
    gain * mix(colour.r, FLOOR_MEAN_LINEAR.r),
    gain * mix(colour.g, FLOOR_MEAN_LINEAR.g),
    gain * mix(colour.b, FLOOR_MEAN_LINEAR.b),
  )

  // Renormalise: `mix` preserves hue direction but not luminance exactly.
  const achieved = luminance(
    out.r * FLOOR_MEAN_LINEAR.r,
    out.g * FLOOR_MEAN_LINEAR.g,
    out.b * FLOOR_MEAN_LINEAR.b,
  )
  return achieved > 0 ? out.multiplyScalar(target / achieved) : out
}

/** Geometry-group material slots: tops sample the floor, skirts do not. */
const MATERIAL_TOP = 0
const MATERIAL_SIDE = 1

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
   * `floor` is the tileable jungle texture, required rather than optional: a
   * terrain built without it would be the flat-colour map ticket 009c exists to
   * replace, and silently falling back to it is exactly the "looks plausible, is
   * wrong" outcome the boot error overlay exists to prevent. The caller loads it
   * and reports the failure.
   */
  constructor(level: LevelData, floor: THREE.Texture) {
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

        // THE CANOPY MASS (ticket 010a revision). Trees are planted on the
        // fringe of the jungle only, so interior canopy has nothing standing on
        // it and must read as solid canopy by itself: it rises toward the middle
        // of the mass and takes a lighter, sunlit-crown green. Height and colour
        // only — `walkable` is untouched, so nothing about movement changes.
        const depth = !walkable && id === CANOPY_TILE_ID ? canopyDepth(level, x, y) : 0
        this.heights[index] = depth > 0 ? canopyMassHeight(depth) : style.height
        colours[index] = new THREE.Color(depth > 0 ? CANOPY_INTERIOR_COLOUR : style.colour)
      }
    }

    const positions: number[] = []
    const normals: number[] = []
    const vertexColours: number[] = []
    const uvs: number[] = []
    // Two index lists over ONE vertex buffer: tops sample the floor texture,
    // skirts do not, and a group is how a single geometry addresses two
    // materials. Concatenated below, tops first, so the groups are contiguous.
    const topIndices: number[] = []
    const sideIndices: number[] = []

    const half = TILE_WORLD_SIZE / 2
    const sideColour = new THREE.Color()
    const topTint = new THREE.Color()

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

        // Top face. UVs come from the CORNERS' world positions, so the pattern
        // runs straight through the tile and into its neighbours — the tile grid
        // leaves no trace in the texture at all.
        this.pushQuad(
          { positions, normals, colours: vertexColours, uvs, indices: topIndices },
          { x: x0, y: top, z: z0 },
          { x: x1, y: top, z: z0 },
          { x: x1, y: top, z: z1 },
          { x: x0, y: top, z: z1 },
          { x: 0, y: 1, z: 0 },
          floorTint(colour, topTint),
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
    geometry.setIndex([...topIndices, ...sideIndices])
    geometry.addGroup(0, topIndices.length, MATERIAL_TOP)
    geometry.addGroup(topIndices.length, sideIndices.length, MATERIAL_SIDE)
    geometry.computeBoundingSphere()
    this.geometry = geometry

    this.materials = TerrainRenderer.buildMaterials(floor)

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
    // The floor texture is NOT disposed here: it is loaded once at boot and
    // owned by the caller, which may build a second level from it (ticket 020).
  }

  /**
   * The two terrain materials, in `MATERIAL_TOP` / `MATERIAL_SIDE` order.
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
   */
  private static buildMaterials(floor: THREE.Texture): readonly THREE.MeshStandardMaterial[] {
    const common = { vertexColors: true, roughness: 0.95, metalness: 0 } as const
    const materials: THREE.MeshStandardMaterial[] = []
    materials[MATERIAL_TOP] = new THREE.MeshStandardMaterial({ ...common, map: floor })
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
