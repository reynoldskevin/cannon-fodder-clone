/**
 * Tracers, drawn (ticket 025a).
 *
 * A LOOP OVER AN ARRAY, AND NOTHING ELSE. Which streaks exist, how long they
 * live and how faded each one is were all decided in
 * `src/core/render-state/tracers.ts`, under Node, where Vitest can see them.
 * What is left here is turning four numbers and a fade into triangles: there is
 * no branch below that could draw the WRONG tracer, only one that could draw it
 * badly, and badly is visible.
 *
 * IT USES ONLY THREE CLASSES THE GAME ALREADY BUNDLES, AND THAT IS A HARD
 * CONSTRAINT RATHER THAN A STYLE — the lesson `src/render/debug-overlay.ts`
 * paid for. `three` is a SHARED dependency, so a class only this file uses is
 * tree-shaken INTO THE MAIN CHUNK whether or not anybody ever fires a round.
 * The obvious spelling — `LineSegments` and `LineBasicMaterial` — costs kilobytes
 * of main bundle for two draw calls' worth of geometry. So a tracer is a thin
 * ribbon of triangles out of the `BufferGeometry` / `Mesh` / `MeshBasicMaterial`
 * set the renderer already carries. Adding a new three class here is not free;
 * measure the build.
 *
 * ONE MESH, SIZED FROM THE BUFFER'S CAPACITY, WITH NO GROWTH PATH. The tracer
 * buffer is a fixed-capacity ring, so the largest frame this can ever be asked
 * to draw is known at construction — which means the geometry is allocated once
 * and never reallocated. That matters beyond tidiness: `BufferGeometry.
 * deleteAttribute` in three 0.185.1 does not free the GL buffer behind it (see
 * `RibbonBatch` in `debug-overlay.ts` for the full autopsy), so the safest
 * growth path is not having one.
 *
 * THE FADE IS A VERTEX COLOUR, not a material opacity, because one mesh holds
 * every live tracer and they are all at different ages. A four-component colour
 * attribute gives three the per-vertex alpha it compiles `USE_COLOR_ALPHA` for,
 * and it is an attribute rather than a class — so it costs the bundle nothing.
 */

import * as THREE from 'three'
import { worldToTileX, worldToTileY } from '../core/view/projection'
import type { Tracer } from '../core/render-state/tracers'
import type { LevelSize } from '../core/level'

/** How the ground height under a tile is sampled — the terrain's own sampler. */
export type GroundHeightAt = (tileX: number, tileY: number) => number

export interface TracerRendererOptions {
  /** The level, so world positions can be turned into height-sampler indices. */
  readonly size: LevelSize
  readonly heightAt: GroundHeightAt
  /**
   * The most tracers that can ever be live at once — the buffer's `capacity`.
   * A bound, not a hint: this geometry has no growth path, and a frame handed
   * more than this draws the first `capacity` of them.
   */
  readonly capacity: number
}

/** Hot brass. Warm enough to read against the jungle without looking like UI. */
const TRACER_COLOUR = { r: 1, g: 0.85, b: 0.45 }

/**
 * How far above the ground a round flies, in world units.
 *
 * Roughly the muzzle of a standing man, and the same height at both ends: a
 * tracer that followed the terrain would sink into a hillside it is passing
 * over. `ShotFired` carries no elevation — the simulation is flat — so this is
 * presentation choosing a plausible one rather than reading a real one.
 */
const TRACER_LIFT = 0.9

/** Half-width of the ribbon in world units. A tile is 1, so this is a hairline. */
const TRACER_HALF_WIDTH = 0.035

/** Vertices one tracer costs: two triangles, unindexed. */
const VERTICES_PER_TRACER = 6

/**
 * The tracer layer's scene graph. Add `object` to the scene, call `update` with
 * the buffer's `visible()` every frame, and `dispose` with the rest of the scene.
 */
export class TracerRenderer {
  readonly object: THREE.Mesh

  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshBasicMaterial
  private readonly positions: Float32Array
  private readonly colours: Float32Array
  private readonly size: LevelSize
  private readonly heightAt: GroundHeightAt
  private readonly capacity: number

  constructor(options: TracerRendererOptions) {
    this.size = options.size
    this.heightAt = options.heightAt
    // Never zero: a zero-length attribute is a draw call with nothing behind it,
    // and the whole point of this class is that the buffer is allocated once.
    this.capacity = Math.max(1, Math.floor(options.capacity))
    const vertices = this.capacity * VERTICES_PER_TRACER
    this.positions = new Float32Array(vertices * 3)
    // Four components, so the alpha rides along per vertex: this is what lets
    // one mesh hold tracers at a dozen different ages. Colour is written every
    // frame beside the positions rather than seeded here, because the alpha is
    // the fade and the fade changes on every one of them.
    this.colours = new Float32Array(vertices * 4)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colours, 4))
    this.geometry.setDrawRange(0, 0)
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      // Additive, because a tracer is light rather than paint: it brightens the
      // jungle it crosses instead of stamping an opaque stripe over it, and two
      // rounds down the same line read as two rounds.
      blending: THREE.AdditiveBlending,
      // Tested against the world but writing no depth: a round passes IN FRONT
      // of the terrain it flies over and behind the hill it does not clear, but
      // it must never occlude the tracers or sprites drawn after it.
      depthWrite: false,
      // A flat ribbon has one normal and the camera looks down on it, but a
      // segment whose perpendicular happens to flip winding must not disappear;
      // double-sided is one word against a whole class of invisible-line bug.
      side: THREE.DoubleSide,
      fog: false,
    })
    this.object = new THREE.Mesh(this.geometry, this.material)
    this.object.name = 'fx:tracers'
    // The bounding volume is never recomputed as the buffer refills, so a culled
    // mesh would blink every tracer out at once. `renderOrder` puts it after the
    // opaque world and before the debug overlay's 999.
    this.object.frustumCulled = false
    this.object.renderOrder = 500
    this.object.visible = false
  }

  /**
   * Refill the geometry from this frame's live tracers.
   *
   * IN PLACE, EVERY FRAME. `setDrawRange` is what makes a frame with no tracers
   * — which is most of them — cost one number rather than a fresh geometry and
   * a fresh GPU upload sixty times a second.
   */
  update(tracers: readonly Tracer[]): void {
    let count = 0
    for (let i = 0; i < tracers.length && count < this.capacity * VERTICES_PER_TRACER; i += 1) {
      const tracer = tracers[i]
      if (tracer === undefined) continue
      const dx = tracer.targetX - tracer.originX
      const dz = tracer.targetZ - tracer.originZ
      const length = Math.hypot(dx, dz)
      // A round aimed at the tile its shooter stands on. The buffer keeps it on
      // purpose — it is a real event and hiding it would hide a genuine oddity
      // from anyone debugging one — and this is the renderer declining to draw
      // it: there is no perpendicular to give a zero-length segment a width, and
      // the normalisation below would put NaN into the buffer, which never
      // comes back.
      if (length === 0) continue
      const px = (-dz / length) * TRACER_HALF_WIDTH
      const pz = (dx / length) * TRACER_HALF_WIDTH
      const ay = this.groundAt(tracer.originX, tracer.originZ) + TRACER_LIFT
      const by = this.groundAt(tracer.targetX, tracer.targetZ) + TRACER_LIFT
      // Linear burn-down. The eye is reading a flick, not a curve, and anything
      // fancier is invisible inside a tenth of a second.
      const alpha = 1 - tracer.fade
      // The ribbon's four corners, named once: each end offset either side of
      // the centreline by the perpendicular. Two of them are used twice, because
      // the quad is two triangles sharing an edge.
      const aLeftX = tracer.originX + px
      const aLeftZ = tracer.originZ + pz
      const aRightX = tracer.originX - px
      const aRightZ = tracer.originZ - pz
      const bLeftX = tracer.targetX + px
      const bLeftZ = tracer.targetZ + pz
      const bRightX = tracer.targetX - px
      const bRightZ = tracer.targetZ - pz
      // Two triangles, wound the same way round for both. The vertex INDEX is
      // passed rather than carried in a closure — see `writeVertex`.
      this.writeVertex(count, aLeftX, ay, aLeftZ, alpha)
      this.writeVertex(count + 1, aRightX, ay, aRightZ, alpha)
      this.writeVertex(count + 2, bRightX, by, bRightZ, alpha)
      this.writeVertex(count + 3, aLeftX, ay, aLeftZ, alpha)
      this.writeVertex(count + 4, bRightX, by, bRightZ, alpha)
      this.writeVertex(count + 5, bLeftX, by, bLeftZ, alpha)
      count += VERTICES_PER_TRACER
    }

    this.object.visible = count > 0
    this.geometry.setDrawRange(0, count)
    // Only the live prefix is re-uploaded; the tail is stale and unread. The
    // ranges are cleared first because they accumulate — left alone, this would
    // hand the driver one more range per frame for the length of the mission.
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute
    position.clearUpdateRanges()
    position.addUpdateRange(0, count * 3)
    position.needsUpdate = true
    const colour = this.geometry.getAttribute('color') as THREE.BufferAttribute
    colour.clearUpdateRanges()
    colour.addUpdateRange(0, count * 4)
    colour.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.object.removeFromParent()
  }

  /**
   * One vertex: its position, and the tracer's colour at the fade it has reached.
   *
   * A METHOD, NOT A CLOSURE INSIDE THE LOOP. The obvious spelling declares a
   * local `write` that captures the running offsets and the alpha, which
   * allocates one closure PER TRACER PER FRAME — a few hundred a second under
   * sustained fire. Immaterial to frame time, and beside the point: this file's
   * header makes a case for allocating once and never growing, and a header that
   * says one thing while the code beneath it does another is how the next person
   * learns to stop trusting the headers. The vertex INDEX is the argument, so
   * the two attributes' differing strides (3 and 4) are derived here rather than
   * being two more things for the caller to keep in step.
   */
  private writeVertex(vertex: number, x: number, y: number, z: number, alpha: number): void {
    const p = vertex * 3
    this.positions[p] = x
    this.positions[p + 1] = y
    this.positions[p + 2] = z
    const c = vertex * 4
    this.colours[c] = TRACER_COLOUR.r
    this.colours[c + 1] = TRACER_COLOUR.g
    this.colours[c + 2] = TRACER_COLOUR.b
    this.colours[c + 3] = alpha
  }

  /**
   * Ground height under a WORLD position.
   *
   * `worldToTileX`/`worldToTileY` and NEVER a hand-rolled `floor(worldX + w/2)`.
   * The height sampler is indexed by CENTRE-INDEXED tile coordinates — integers
   * name tile centres — so the conversion is a round against `(w - 1) / 2`, and
   * the corner-indexed spelling half a tile away samples the tile next door.
   * Two review cycles of this project have already gone on that exact half tile.
   */
  private groundAt(worldX: number, worldZ: number): number {
    return this.heightAt(worldToTileX(worldX, this.size), worldToTileY(worldZ, this.size))
  }
}
