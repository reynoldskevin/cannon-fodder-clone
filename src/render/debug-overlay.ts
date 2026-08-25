/**
 * The debug overlay's drawing half (ticket 014).
 *
 * A LOOP OVER ARRAYS, AND NOTHING ELSE. Every decision the overlay makes —
 * which tiles, which arrows, which rays, whose state, whose position — was made
 * in `src/core/debug`, under Node, where Vitest can see it. What is left here is
 * turning numbers into geometry: there is no branch below that could draw the
 * WRONG thing, only one that could draw it badly, and badly is visible.
 *
 * IT USES ONLY THREE CLASSES THE GAME ALREADY BUNDLES, AND THAT IS A HARD
 * CONSTRAINT RATHER THAN A STYLE. This module is reached exclusively through the
 * dynamic `import()` in `src/app/main.ts`, so its own code lands in a chunk a
 * normal build never fetches — but `three` is SHARED, so any three class only
 * this file uses is tree-shaken INTO THE MAIN CHUNK, where every player pays for
 * it. The obvious spelling of this overlay — `LineSegments`, `LineBasicMaterial`,
 * `Sprite`, `SpriteMaterial`, `CanvasTexture` — costs 12.5 kB of main bundle for
 * a tool nobody in production runs, which is measurably the acceptance criterion
 * this ticket was given. So lines are drawn as thin ribbons of triangles and
 * labels as textured quads, out of the `BufferGeometry` / `Mesh` /
 * `MeshBasicMaterial` / `PlaneGeometry` / `Texture` set the renderer already
 * carries. Adding a new three class here is not free; measure the build.
 *
 * BUFFERS ARE REUSED, NEVER REBUILT. `update` runs every frame with a layer set
 * the player toggles at will, and allocating a `BufferGeometry` per layer per
 * frame would hand the GPU a new upload and the nursery a new typed array 60
 * times a second — on a machine that is already struggling enough for somebody
 * to have opened the overlay. Each batch grows its buffer to the largest frame
 * it has ever seen and then stops; a layer switched off draws zero vertices out
 * of a buffer that is still there when it comes back. That is what makes
 * "toggle every layer on and off repeatedly" leak nothing.
 *
 * DEPTH TEST OFF, and it is deliberate. A grid ribbon lying on the terrain
 * z-fights with it, and an LOS ray that vanishes behind a hill is a ray the
 * tuner cannot see at the moment it matters. The overlay draws on top of the
 * world because it is not part of it.
 */

import * as THREE from 'three'
import { ELEVATION } from '../core/view/orientation'
import { tileToWorld, worldToTileX, worldToTileY } from '../core/view/projection'
import type { DebugSnapshot } from '../core/debug'
import type { LevelSize } from '../core/level'

/** How the ground height under a tile is sampled — the terrain's own sampler. */
export type GroundHeightAt = (tileX: number, tileY: number) => number

export interface DebugOverlayOptions {
  readonly size: LevelSize
  readonly heightAt: GroundHeightAt
  /**
   * The camera's elevation in radians, for the label stretch. Defaults to the
   * rig's own, so a caller that has not read `?elev=` still gets square text.
   */
  readonly elevationRad?: number
}

/** Grid cells a man may walk on, and the ones he may not. */
const PASSABLE_COLOUR = 0x2f6f4a
const BLOCKED_COLOUR = 0xb3452f
const FLOW_COLOUR = 0x4fa3ff
const RAY_COLOUR = 0xffd166
const PLAYER_COLOUR = '#8fd694'
const ENEMY_COLOUR = '#ff8f6b'
const AI_COLOUR = '#ffd166'

/**
 * How far above the ground each layer floats, in world units.
 *
 * Small and DIFFERENT per layer: everything here is drawn without a depth test,
 * so what separates a grid ribbon from the arrow on the same tile is only the
 * order they are added to the group — the offsets are what keep them from
 * reading as one smeared line when the camera is low.
 */
const GRID_LIFT = 0.02
const FLOW_LIFT = 0.06
const RAY_LIFT = 0.9
const LABEL_LIFT = 1.5

/** Ribbon half-widths in world units — a tile is 1, so these are hairlines. */
const GRID_HALF_WIDTH = 0.012
const FLOW_HALF_WIDTH = 0.02
const RAY_HALF_WIDTH = 0.035

/** Segments a tile's outline costs, and a flow arrow: four edges, a shaft and two barbs. */
const TILE_OUTLINE_SEGMENTS = 4
const ARROW_SEGMENTS = 3

/**
 * Rays the LOS batch is sized for before it has to grow.
 *
 * A whole platoon engaging at once, which is more than level 1 contains. It is a
 * starting size and not a bound — see `RibbonBatch.reserve`.
 */
const INITIAL_RAY_SEGMENTS = 64

/** Half the length of a flow arrow, in tiles. Short enough to read as a field. */
const ARROW_HALF = 0.32
/** How far the barbs of an arrow head splay back from its tip, in tiles. */
const ARROW_BARB = 0.14

/** Label bitmaps, at a size that stays legible at the game's default zoom. */
const LABEL_FONT_PX = 48
const LABEL_PAD_PX = 10
/** World height of a label quad. Its width follows the text's aspect ratio. */
const LABEL_WORLD_HEIGHT = 0.5

/**
 * The steepest elevation the label stretch is computed from.
 *
 * `1 / cos(elevation)` runs away to infinity at 90 degrees, and a straight-down
 * camera has no upright quad to foreshorten anyway. The same cap, for the same
 * reason, as `EntityRenderer`'s.
 */
const MAX_LABEL_ELEVATION = (80 * Math.PI) / 180

/** Vertices one ribbon segment costs: two triangles, unindexed. */
const VERTICES_PER_SEGMENT = 6

/**
 * A reusable batch of flat ribbons — this overlay's "lines".
 *
 * Six vertices per segment (two triangles) laid flat in the XZ plane, with the
 * ribbon's width along the segment's perpendicular. The whole point is the draw
 * range: `begin`/`push`/`end` refills the buffer in place each frame and tells
 * the GPU how much of it is live, so a frame with no segments costs one
 * `setDrawRange(0, 0)` rather than a fresh geometry.
 *
 * SIZED FROM A KNOWN BOUND WHERE ONE EXISTS, AND THAT IS NOT AN OPTIMISATION.
 * Growing a batch used to mean `deleteAttribute` plus a fresh `BufferAttribute`,
 * and in three 0.185.1 `BufferGeometry.deleteAttribute` is nothing but
 * `delete this.attributes[name]` — `gl.deleteBuffer` is reached ONLY through
 * `WebGLAttributes.remove()`, which a geometry that is still alive never calls.
 * The `WeakMap` entry is collected and the DRIVER ALLOCATION IS NOT. The nav
 * grid on a 57x45 map doubles from 1152 floats through about eight growths to
 * hold ~180k, orphaning roughly 1.2 MB of GPU memory on a machine that is
 * already struggling enough for somebody to have opened the overlay. Bounded,
 * and still wrong.
 *
 * So the two grid batches, which ARE bounded by `w * h`, are handed their full
 * capacity by `DebugOverlay` and can never grow at all. The flow and LOS batches
 * have no bound the level knows — a field per destination under orders, a ray
 * per engaging unit, both mission-time quantities — so they keep a growth path,
 * and that path disposes the whole geometry rather than swapping an attribute
 * out of it, because `BufferGeometry.dispose()` is what fires the event
 * `WebGLRenderer` turns into `gl.deleteBuffer`.
 */
class RibbonBatch {
  readonly object: THREE.Mesh
  private geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshBasicMaterial
  private positions: Float32Array
  private count = 0

  /** `capacityVertices` is a bound, not a hint: a batch given a true one never grows. */
  constructor(colour: number, opacity: number, capacityVertices: number) {
    // Never zero: the growth path doubles, which would double 0 forever, and a
    // zero-length attribute is a draw call with nothing behind it.
    this.positions = new Float32Array(Math.max(capacityVertices, VERTICES_PER_SEGMENT) * 3)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.material = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      // A flat ribbon has one normal and the camera looks down on it, but a
      // segment whose perpendicular happens to flip winding must not disappear;
      // double-sided is one word against a whole class of invisible-line bug.
      side: THREE.DoubleSide,
      fog: false,
    })
    this.object = new THREE.Mesh(this.geometry, this.material)
    // Nothing about this belongs in a frustum test: the bounding volume is
    // never recomputed as the buffer refills, so a culled batch would blink out
    // the moment the overlay was most interesting. `renderOrder` puts the
    // depth-test-free draw on top of everything the game drew.
    this.object.frustumCulled = false
    this.object.renderOrder = 999
    this.object.visible = false
  }

  begin(): void {
    this.count = 0
  }

  /** One segment, as a ribbon `halfWidth` wide either side of its centreline. */
  push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    halfWidth: number,
  ): void {
    const dx = bx - ax
    const dz = bz - az
    const length = Math.hypot(dx, dz)
    // A segment with no length in the ground plane has no perpendicular to give
    // — a ray straight up, or two men standing on the same spot — and the
    // normalisation below would put NaN into the buffer, which never comes back.
    if (length === 0) return
    const px = (-dz / length) * halfWidth
    const pz = (dx / length) * halfWidth
    this.reserve(this.count + VERTICES_PER_SEGMENT)
    let i = this.count * 3
    const write = (x: number, y: number, z: number): void => {
      this.positions[i] = x
      this.positions[i + 1] = y
      this.positions[i + 2] = z
      i += 3
    }
    write(ax + px, ay, az + pz)
    write(ax - px, ay, az - pz)
    write(bx - px, by, bz - pz)
    write(ax + px, ay, az + pz)
    write(bx - px, by, bz - pz)
    write(bx + px, by, bz + pz)
    this.count += VERTICES_PER_SEGMENT
  }

  end(): void {
    this.object.visible = this.count > 0
    this.geometry.setDrawRange(0, this.count)
    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute
    // Only the live prefix is re-uploaded; the tail is stale and unread. The
    // ranges are cleared first because they accumulate — left alone, this would
    // hand the driver one more range per frame for the length of the mission.
    attribute.clearUpdateRanges()
    attribute.addUpdateRange(0, this.count * 3)
    attribute.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  /**
   * Double until `vertices` fit, and REPLACE THE GEOMETRY rather than the
   * attribute inside it.
   *
   * A no-op for any batch constructed with a real bound, which is the intended
   * state for all but the LOS batch. When it does run: `deleteAttribute` +
   * `setAttribute` would leave the old GL buffer allocated forever (see the
   * class header), where disposing the geometry fires the event
   * `WebGLRenderer` listens for and frees it. The stale geometry is disposed
   * AFTER the mesh has been pointed at the new one, so there is no instant at
   * which the mesh holds a disposed geometry.
   */
  private reserve(vertices: number): void {
    if (vertices * 3 <= this.positions.length) return
    let length = this.positions.length
    while (length < vertices * 3) length *= 2
    const grown = new Float32Array(length)
    grown.set(this.positions)
    this.positions = grown
    const stale = this.geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(grown, 3))
    this.geometry = geometry
    this.object.geometry = geometry
    stale.dispose()
  }
}

/**
 * A pool of text quads, reused across frames and shared across layers.
 *
 * TWO CACHES, AND THEY BOUND DIFFERENT THINGS. Quads are pooled by INDEX — a
 * frame wants some number of labels and takes the first that many out of the
 * pool, so the object count settles at the busiest frame ever drawn. Bitmaps are
 * cached by TEXT AND COLOUR, because rasterising a canvas per label per frame is
 * the one genuinely expensive thing this file could do; the key space is entity
 * ids (bounded by the mission's roster) and the four AI state names.
 *
 * Upright quads with identity rotation, exactly like `EntityRenderer`'s sprites:
 * the camera is locked to yaw 0, so "face the camera" and "stand up straight"
 * are the same instruction, and the vertical stretch by `1 / cos(elevation)`
 * undoes the foreshortening that would otherwise squash the text.
 */
class LabelPool {
  readonly group = new THREE.Group()
  private readonly geometry = new THREE.PlaneGeometry(1, 1)
  private readonly meshes: THREE.Mesh[] = []
  private readonly materials: THREE.MeshBasicMaterial[] = []
  private readonly textures = new Map<string, THREE.Texture>()
  private readonly stretch: number
  private used = 0

  constructor(elevationRad: number) {
    this.group.renderOrder = 1000
    const clamped = Math.min(Math.abs(elevationRad), MAX_LABEL_ELEVATION)
    this.stretch = Number.isFinite(clamped) ? 1 / Math.cos(clamped) : 1
  }

  begin(): void {
    this.used = 0
  }

  /** Place one label. `text` and `colour` together key the rasterised bitmap. */
  push(text: string, colour: string, x: number, y: number, z: number): void {
    const index = this.used
    this.used += 1
    const mesh = this.meshAt(index)
    const material = this.materials[index]
    if (material === undefined) return
    const texture = this.textureFor(text, colour)
    if (material.map !== texture) {
      material.map = texture
      material.needsUpdate = true
    }
    const image = texture.image as { width: number; height: number } | null
    const aspect = image === null || image.height === 0 ? 1 : image.width / image.height
    mesh.scale.set(LABEL_WORLD_HEIGHT * aspect, LABEL_WORLD_HEIGHT * this.stretch, 1)
    mesh.position.set(x, y, z)
    mesh.visible = true
  }

  /** Hide every quad the frame did not claim. They stay pooled for the next one. */
  end(): void {
    for (let i = this.used; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i]
      if (mesh !== undefined) mesh.visible = false
    }
  }

  dispose(): void {
    for (const texture of this.textures.values()) texture.dispose()
    this.textures.clear()
    for (const material of this.materials) material.dispose()
    this.materials.length = 0
    this.geometry.dispose()
    this.group.clear()
    this.meshes.length = 0
  }

  private meshAt(index: number): THREE.Mesh {
    const existing = this.meshes[index]
    if (existing !== undefined) return existing
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const mesh = new THREE.Mesh(this.geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 1000
    this.materials[index] = material
    this.meshes[index] = mesh
    this.group.add(mesh)
    return mesh
  }

  private textureFor(text: string, colour: string): THREE.Texture {
    const key = `${colour}:${text}`
    const cached = this.textures.get(key)
    if (cached !== undefined) return cached
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (context === null) {
      // No 2D context is a browser without canvas, which is a browser without
      // WebGL: the game is already dead by then. An empty texture keeps this
      // from being the thing that throws.
      const blank = new THREE.Texture()
      this.textures.set(key, blank)
      return blank
    }
    const font = `600 ${String(LABEL_FONT_PX)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    context.font = font
    const width = Math.ceil(context.measureText(text).width) + LABEL_PAD_PX * 2
    canvas.width = width
    canvas.height = LABEL_FONT_PX + LABEL_PAD_PX * 2
    // Resizing a canvas resets its context, so the font is set a second time.
    context.font = font
    context.textBaseline = 'middle'
    context.fillStyle = 'rgba(13,16,18,0.72)'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = colour
    context.fillText(text, LABEL_PAD_PX, canvas.height / 2)
    // `Texture` plus `needsUpdate`, not `CanvasTexture` — the two are the same
    // thing, and only one of them is already in the main bundle. See the header.
    const texture = new THREE.Texture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    this.textures.set(key, texture)
    return texture
  }
}

/**
 * The overlay's scene graph. Add `group` to the scene, call `update` with a
 * snapshot every frame, and `dispose` with the rest of the scene.
 */
export class DebugOverlay {
  readonly group = new THREE.Group()

  private readonly size: LevelSize
  private readonly heightAt: GroundHeightAt
  private readonly passable: RibbonBatch
  private readonly blocked: RibbonBatch
  private readonly flow: RibbonBatch
  private readonly rays: RibbonBatch
  private readonly labels: LabelPool

  constructor(options: DebugOverlayOptions) {
    this.size = options.size
    this.heightAt = options.heightAt
    this.labels = new LabelPool(options.elevationRad ?? ELEVATION)
    // THE BOUNDS, STATED — and only two of the four are real bounds.
    //
    // The GRID batches are: `debugSnapshot` emits exactly one cell per tile and
    // each cell draws one outline, so every tile can land in EITHER batch — a
    // level with no walls puts all of them in `passable`, one solid with rock
    // puts all of them in `blocked` — and each is therefore sized for the whole
    // map rather than for a share of it. Neither can ever reach the growth path
    // in `reserve`, which is the point; see its header for what growing costs.
    // On level 1 (57x45) that is about 0.74 MB per grid batch, allocated once,
    // only under `?debug=1`, and never orphaned.
    //
    // The FLOW batch is sized for ONE FIELD and that is a typical case, not a
    // bound: the snapshot draws a field per distinct destination under orders,
    // so a squad split between two objectives draws two mapfuls of arrows. Two
    // detachments is the common maximum and a mission could exceed it, which is
    // why the growth path still has to be correct rather than merely unused.
    const cells = Math.max(options.size.w * options.size.h, 1)
    const outlineVertices = cells * TILE_OUTLINE_SEGMENTS * VERTICES_PER_SEGMENT
    this.passable = new RibbonBatch(PASSABLE_COLOUR, 0.35, outlineVertices)
    this.blocked = new RibbonBatch(BLOCKED_COLOUR, 0.55, outlineVertices)
    this.flow = new RibbonBatch(FLOW_COLOUR, 0.9, cells * ARROW_SEGMENTS * VERTICES_PER_SEGMENT)
    // The batch with no bound the level knows at all: one ray per ENGAGING unit,
    // which is a fact about the mission and not about the map. It starts at a
    // firefight's worth and grows — correctly — from there.
    this.rays = new RibbonBatch(RAY_COLOUR, 0.9, INITIAL_RAY_SEGMENTS * VERTICES_PER_SEGMENT)
    this.group.name = 'debug:overlay'
    this.group.add(
      this.passable.object,
      this.blocked.object,
      this.flow.object,
      this.rays.object,
      this.labels.group,
    )
  }

  update(snapshot: DebugSnapshot): void {
    this.drawGrid(snapshot)
    this.drawFlow(snapshot)
    this.drawRays(snapshot)
    this.drawLabels(snapshot)
  }

  dispose(): void {
    this.passable.dispose()
    this.blocked.dispose()
    this.flow.dispose()
    this.rays.dispose()
    this.labels.dispose()
    this.group.clear()
    this.group.removeFromParent()
  }

  /** One square per tile, in the batch its passability chooses. */
  private drawGrid(snapshot: DebugSnapshot): void {
    this.passable.begin()
    this.blocked.begin()
    for (const cell of snapshot.navGrid) {
      const centre = tileToWorld(cell.x, cell.y, this.size)
      const y = this.heightAt(cell.x, cell.y) + GRID_LIFT
      const x0 = centre.x - 0.5
      const x1 = centre.x + 0.5
      const z0 = centre.z - 0.5
      const z1 = centre.z + 0.5
      const batch = cell.passable ? this.passable : this.blocked
      batch.push(x0, y, z0, x1, y, z0, GRID_HALF_WIDTH)
      batch.push(x1, y, z0, x1, y, z1, GRID_HALF_WIDTH)
      batch.push(x1, y, z1, x0, y, z1, GRID_HALF_WIDTH)
      batch.push(x0, y, z1, x0, y, z0, GRID_HALF_WIDTH)
    }
    this.passable.end()
    this.blocked.end()
  }

  /** A shaft and two barbs per arrow: three segments, drawn in the tile centre. */
  private drawFlow(snapshot: DebugSnapshot): void {
    this.flow.begin()
    for (const arrow of snapshot.flowField) {
      const centre = tileToWorld(arrow.x, arrow.y, this.size)
      const y = this.heightAt(arrow.x, arrow.y) + FLOW_LIFT
      // The field's step is one of eight, so a diagonal is longer than an
      // orthogonal until it is normalised — unnormalised, a field of diagonals
      // reads as a field of longer arrows rather than a field of turns.
      const length = Math.hypot(arrow.dx, arrow.dy)
      if (length === 0) continue
      const ux = arrow.dx / length
      const uz = arrow.dy / length
      const tipX = centre.x + ux * ARROW_HALF
      const tipZ = centre.z + uz * ARROW_HALF
      this.flow.push(
        centre.x - ux * ARROW_HALF,
        y,
        centre.z - uz * ARROW_HALF,
        tipX,
        y,
        tipZ,
        FLOW_HALF_WIDTH,
      )
      // Barbs are the shaft stepped back from the tip and splayed out along its
      // perpendicular — the same rotation by ±135 degrees, without a matrix.
      const backX = tipX - ux * ARROW_BARB
      const backZ = tipZ - uz * ARROW_BARB
      this.flow.push(
        tipX,
        y,
        tipZ,
        backX - uz * ARROW_BARB,
        y,
        backZ + ux * ARROW_BARB,
        FLOW_HALF_WIDTH,
      )
      this.flow.push(
        tipX,
        y,
        tipZ,
        backX + uz * ARROW_BARB,
        y,
        backZ - ux * ARROW_BARB,
        FLOW_HALF_WIDTH,
      )
    }
    this.flow.end()
  }

  /** One ribbon per live sightline, lifted to roughly chest height at both ends. */
  private drawRays(snapshot: DebugSnapshot): void {
    this.rays.begin()
    for (const ray of snapshot.losRays) {
      this.rays.push(
        ray.fromX,
        this.groundAt(ray.fromX, ray.fromZ) + RAY_LIFT,
        ray.fromZ,
        ray.toX,
        this.groundAt(ray.toX, ray.toZ) + RAY_LIFT,
        ray.toZ,
        RAY_HALF_WIDTH,
      )
    }
    this.rays.end()
  }

  /**
   * AI state above entity id, both layers sharing one quad pool.
   *
   * Shared because they are the same kind of object in the same places, and two
   * pools would each settle at the roster size for a total of twice as many
   * quads as any frame ever draws. The AI label sits higher so a man with both
   * layers on reads as two stacked lines rather than one overlapping smear.
   */
  private drawLabels(snapshot: DebugSnapshot): void {
    this.labels.begin()
    for (const marker of snapshot.ai) {
      this.labels.push(
        marker.state,
        AI_COLOUR,
        marker.x,
        this.groundAt(marker.x, marker.z) + LABEL_LIFT + LABEL_WORLD_HEIGHT,
        marker.z,
      )
    }
    for (const label of snapshot.entityIds) {
      this.labels.push(
        `#${String(label.id)}`,
        label.team === 'enemy' ? ENEMY_COLOUR : PLAYER_COLOUR,
        label.x,
        this.groundAt(label.x, label.z) + LABEL_LIFT,
        label.z,
      )
    }
    this.labels.end()
  }

  /**
   * Ground height under a WORLD position.
   *
   * `worldToTileX`/`worldToTileY` and NEVER a hand-rolled `floor(worldX + w/2)`.
   * The height sampler is indexed by CENTRE-INDEXED tile coordinates — integers
   * name tile centres — so the conversion is a round against `(w - 1) / 2`, and
   * the corner-indexed spelling half a tile away puts a label on the tile next
   * door. Two review cycles of this project have already gone on that exact half
   * tile. The per-axis pair is used rather than `worldToTile` because this runs
   * per label per frame and no `TileCoord` object is wanted.
   */
  private groundAt(worldX: number, worldZ: number): number {
    return this.heightAt(worldToTileX(worldX, this.size), worldToTileY(worldZ, this.size))
  }
}
