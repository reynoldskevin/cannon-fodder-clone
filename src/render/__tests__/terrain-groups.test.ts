import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { TerrainRenderer } from '../terrain-renderer'
import { GROUND_SURFACES, groundSurfaceFor, type GroundSurface } from '../../core/view/ground-surface'
import { TERRAIN } from '../../core/level/terrain'
import type { LevelData } from '../../core/level'

/**
 * Ticket 034 — the terrain mesh's material groups.
 *
 * `src/render` HAS NEVER HAD A TEST, AND THE STATED REASON WAS WRONG. Every
 * module in this layer carries some version of "Vitest runs in
 * `environment: 'node'`, so there is no WebGL context and nothing here can be
 * checked" — and I wrote that sentence into two of this ticket's own files
 * before checking it. It is false for a large and important part of what the
 * renderer does. `BufferGeometry`, `MeshStandardMaterial` and `THREE.Texture`
 * are plain JavaScript objects: they only touch the GPU when a `WebGLRenderer`
 * uploads them, and nothing here constructs one. This whole file runs in a few
 * milliseconds in plain node.
 *
 * WHAT THAT ASSUMPTION WAS COSTING, measured by mutation against the suite as it
 * stood: dropping an entire geometry group, making the groups non-contiguous,
 * pointing a group's material slot at the wrong texture, and skipping
 * `configureFloorTexture` for the two new textures ALL left 1980 tests green.
 * Four ways to render the map wrong, none of them caught, all of them cheap to
 * catch.
 *
 * The genuine limit is narrower than the folklore: shaders, uploads, draw calls
 * and anything reading pixels back need a GL context and remain untestable here.
 * The arrangement of the data handed to them does not.
 */

/** A level whose tiles cycle through every terrain id the importer can emit. */
function level(w = 6, h = 6): LevelData {
  return {
    schemaVersion: 1,
    name: 'groups-fixture',
    size: { w, h },
    terrain: Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => (y * w + x) % 6),
    ),
    walkable: Array.from({ length: h }, () => Array.from({ length: w }, () => true)),
    walkableSource: 'heuristic',
    spawns: { avatars: [], enemies: [], props: [], chests: [] },
    objectives: [{ type: 'kill_all' }],
  }
}

function textures(): Record<GroundSurface, THREE.Texture> {
  // Named so a mis-slotted material can be identified by which texture it holds,
  // rather than by three indistinguishable blank ones.
  const made = {} as Record<GroundSurface, THREE.Texture>
  for (const surface of GROUND_SURFACES) {
    const texture = new THREE.Texture()
    texture.name = surface
    made[surface] = texture
  }
  return made
}

const build = (data: LevelData = level()) => new TerrainRenderer(data, textures())

const materialsOf = (mesh: THREE.Mesh): THREE.MeshStandardMaterial[] =>
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]

describe('the terrain is one geometry addressing several materials', () => {
  it('bakes a single BufferGeometry, not one mesh per tile', () => {
    // The property the whole class exists for: 57x45 is 2565 tiles, and a mesh
    // each would be 2565 draw calls and 2565 matrix updates every frame.
    const renderer = build()
    expect(renderer.mesh.geometry).toBeInstanceOf(THREE.BufferGeometry)
    expect(renderer.mesh.matrixAutoUpdate).toBe(false)
  })

  it('has one group per ground texture plus one for the skirts', () => {
    expect(build().mesh.geometry.groups).toHaveLength(GROUND_SURFACES.length + 1)
  })

  it('starts at zero, runs contiguously, and covers the whole index buffer', () => {
    /**
     * THE ONE THAT SILENTLY DROPS TRIANGLES. `addGroup` describes a RANGE of the
     * index buffer, so a gap between two groups is a run of indices no material
     * ever draws — a stripe of the map simply missing, with the geometry, the
     * vertex data and the materials all perfectly correct. Nothing else in the
     * codebase would notice.
     */
    const geometry = build().mesh.geometry
    const total = geometry.getIndex()?.count ?? 0
    expect(total).toBeGreaterThan(0)

    let cursor = 0
    for (const group of geometry.groups) {
      expect({ start: group.start, cursor }).toEqual({ start: cursor, cursor })
      cursor += group.count
    }
    expect(cursor).toBe(total)
  })

  it('and a surface absent from a level still gets its (empty) group', () => {
    /**
     * Slot numbering has to be a property of `GROUND_SURFACES`, not of what the
     * level happens to contain. A level with no water that simply omitted the
     * water group would shift the bridge and the skirts down a slot and paint
     * both with the wrong material — and level 1 has neither water nor bridge,
     * so this is the common case, not the exotic one.
     */
    const dryLevel: LevelData = {
      ...level(),
      terrain: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => TERRAIN.GRASS)),
    }
    const geometry = build(dryLevel).mesh.geometry
    expect(geometry.groups).toHaveLength(GROUND_SURFACES.length + 1)
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2, 3])
  })
})

describe('each group draws with the texture its surface was painted for', () => {
  it('maps slot to texture in GROUND_SURFACES order', () => {
    /**
     * AN OFF-BY-ONE HERE PAVES THE RIVER WITH PLANKS. Every group would still be
     * contiguous, every count would still be right, and the map would render
     * with water art on the bridge and bridge art on the water. Asserted by
     * texture identity rather than by index, so the check cannot be satisfied by
     * the same mistake it is looking for.
     */
    const ground = textures()
    const renderer = new TerrainRenderer(level(), ground)
    const materials = materialsOf(renderer.mesh)

    GROUND_SURFACES.forEach((surface, slot) => {
      expect({ surface, map: materials[slot]?.map?.name }).toEqual({ surface, map: surface })
    })
  })

  it('and the skirts sample no texture at all', () => {
    /**
     * A skirt is a vertical face; a top-down floor sampled on one is either a
     * smear of whatever sat at that world z or a fern growing sideways out of a
     * cliff. `SIDE_MATERIAL_NOTE` argues this at length — this is what makes the
     * argument survive an edit.
     */
    const materials = materialsOf(build().mesh)
    expect(materials).toHaveLength(GROUND_SURFACES.length + 1)
    expect(materials[GROUND_SURFACES.length]?.map).toBeNull()
  })

  it('and every index inside a group belongs to a tile of that group`s surface', () => {
    /**
     * The strongest form of the check: not "the groups look plausible" but "each
     * index in this range really is a corner of a tile whose `groundSurfaceFor`
     * is this slot's surface". This is what says the sorting into lists is right,
     * rather than merely that the counts add up.
     *
     * Tops only — the skirt group is the remainder and is excluded by the loop
     * bound, since a skirt belongs to the tile below as much as the tile above.
     */
    const data = level()
    const renderer = build(data)
    const geometry = renderer.mesh.geometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    expect(index).not.toBeNull()

    // Every top vertex sits at its tile's style height; recovering the tile from
    // world position needs the same projection the renderer used, so instead the
    // check goes the other way — collect the distinct heights per group and
    // confirm each matches a tile of that surface.
    const wrong: string[] = []
    GROUND_SURFACES.forEach((surface, slot) => {
      const group = geometry.groups[slot]
      if (!group) return
      for (let i = group.start; i < group.start + group.count; i += 1) {
        const vertex = index?.getX(i) ?? 0
        const y = position.getY(vertex)
        // Which tile ids could have produced a top at this height AND this slot.
        const plausible = [0, 1, 2, 3, 4, 5].some(
          (id) => groundSurfaceFor(id) === surface && Math.abs(heightOf(renderer, data, id) - y) < 1e-6,
        )
        if (!plausible) wrong.push(`${surface}@${String(i)}:y=${String(y)}`)
      }
    })
    expect(wrong).toEqual([])
  })
})

/** The baked top height of the first tile carrying `id`, read back from the renderer. */
function heightOf(renderer: TerrainRenderer, data: LevelData, id: number): number {
  for (let y = 0; y < data.size.h; y += 1) {
    for (let x = 0; x < data.size.w; x += 1) {
      if (data.terrain[y]?.[x] === id) return renderer.heightAt(x, y)
    }
  }
  return Number.NaN
}

describe('disposal does not release what it does not own', () => {
  it('leaves all three ground textures alive', () => {
    /**
     * TICKET 024's BUG, IN THE ONE PLACE IT COULD COME BACK. `EntityRenderer`
     * released the shared page-lifetime sprite atlas on every level swap,
     * deallocating the texture the incoming stage was already bound to. It
     * re-uploads lazily, so it looked fine in a browser walk-through and fired
     * before the first frame of any save resuming past level 1.
     *
     * The ground textures are loaded once at boot and reused by every stage, so
     * they are owned by `main.ts`'s `teardown`, not by a level's terrain.
     * `Texture.dispose()` is observable without a GL context: it fires a
     * `dispose` event, which is exactly what a renderer listens for to free the
     * upload.
     */
    const ground = textures()
    const released: string[] = []
    for (const texture of Object.values(ground)) {
      texture.addEventListener('dispose', () => released.push(texture.name))
    }

    const renderer = new TerrainRenderer(level(), ground)
    renderer.dispose()

    expect(released).toEqual([])
  })

  it('but does release the geometry and materials it built', () => {
    // The other half: a terrain that leaked its own geometry on every level
    // change would grow the GPU's memory for the length of a campaign.
    const renderer = build()
    const materials = materialsOf(renderer.mesh)
    const released: number[] = []
    renderer.mesh.geometry.addEventListener('dispose', () => released.push(-1))
    materials.forEach((material, i) => material.addEventListener('dispose', () => released.push(i)))

    renderer.dispose()
    expect(released.sort((a, b) => a - b)).toEqual([-1, 0, 1, 2, 3])
  })
})
