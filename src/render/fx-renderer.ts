/**
 * Effects, drawn (ticket 025).
 *
 * A LOOP OVER AN ARRAY, AND NOTHING ELSE — the same split, for the same reason,
 * as `tracer-renderer.ts`. Which effects exist, how long each kind lives, how big
 * it is and how far through its life it has got were all decided in
 * `src/core/render-state/fx.ts`, under Node, where Vitest can see them. What is
 * left here is turning a position, a size and a fade into triangles: there is no
 * branch below that could draw the WRONG effect, only one that could draw it
 * badly, and badly is visible.
 *
 * IT ADDS NO THREE CLASS THE GAME DOES NOT ALREADY BUNDLE, and that is a hard
 * constraint rather than a style — the lesson `debug-overlay.ts` paid for and
 * `tracer-renderer.ts` restates. `three` is a SHARED dependency, so a class only
 * this file uses is tree-shaken INTO THE MAIN CHUNK whether or not anybody ever
 * throws a grenade. `Points`/`PointsMaterial` — the obvious spelling for a
 * particle effect — would cost kilobytes of main bundle for two draw calls'
 * worth of geometry, and would also hand the size of a particle to the GPU in
 * PIXELS, so an effect would stay the same size on screen as the player zoomed
 * out. So an effect is a quad of two triangles out of the `BufferGeometry` /
 * `Mesh` / `MeshBasicMaterial` set the renderer already carries. Adding a new
 * three class here is not free; measure the build.
 *
 * FLAT ON THE GROUND PLANE, LIFTED PER KIND. A billboard would need the camera,
 * which would make this a thing that cannot be built without one and therefore a
 * thing no test can hold. The camera looks down at a fixed elevation, so a quad
 * in the XZ plane is foreshortened but never edge-on — and a scorch mark, which
 * is the one effect that genuinely lies on the ground, comes out exactly right.
 *
 * ONE MESH, SIZED FROM ITS CAPACITY, WITH NO GROWTH PATH, because the buffer
 * upstream is a fixed-capacity ring and so the largest frame this can ever be
 * asked to draw is known at construction. That matters beyond tidiness:
 * `BufferGeometry.deleteAttribute` in three 0.185.1 does not free the GL buffer
 * behind it (see `RibbonBatch` in `debug-overlay.ts` for the full autopsy), so
 * the safest growth path is not having one. A frame handed more effects than the
 * mesh has room for draws the first `capacity` of them and drops the rest rather
 * than throwing — "the buffer's cap" and "the mesh's cap" are two numbers, and
 * the busiest frame of the mission is the worst possible moment to discover they
 * disagree.
 *
 * THE FADE IS A VERTEX COLOUR, not a material opacity, because one mesh holds
 * every live effect and they are all at different ages. A four-component colour
 * attribute gives three the per-vertex alpha it compiles `USE_COLOR_ALPHA` for,
 * and it is an attribute rather than a class — so it costs the bundle nothing.
 */

import * as THREE from 'three'
import { worldToTileX, worldToTileY } from '../core/view/projection'
import { DEFAULT_FX_CAPACITY, type Fx, type FxKind } from '../core/render-state/fx'
import type { LevelSize } from '../core/level'

/** How the ground height under a tile is sampled — the terrain's own sampler. */
export type GroundHeightAt = (tileX: number, tileY: number) => number

/**
 * The terrain to sit effects on.
 *
 * ONE OPTIONAL FIELD RATHER THAN TWO, because the sampler is useless without the
 * level size that indexes it: made separately optional, a caller could pass one
 * and not the other and every effect would be drawn at the wrong tile.
 */
export interface FxGround {
  readonly size: LevelSize
  readonly heightAt: GroundHeightAt
}

export interface FxRendererOptions {
  /**
   * The most effects that can ever be drawn at once — normally the feeding
   * buffer's `capacity`. A bound, not a hint: this geometry has no growth path.
   */
  readonly capacity?: number
  /**
   * Where the ground is. WITHOUT IT EVERY EFFECT SITS ON THE y = 0 PLANE, which
   * is right for a test and wrong for a level with any relief in it — so
   * `main.ts` always passes one.
   */
  readonly ground?: FxGround
  /**
   * How the effects are composited.
   *
   * `'additive'` is light — a flash brightens the jungle it crosses instead of
   * stamping an opaque patch over it, and two bursts in the same place read as
   * two bursts. `'normal'` is PAINT, and the decal pool must be built with it: a
   * scorch mark is a dark stain, and additively blended dark is invisible.
   */
  readonly blending?: 'additive' | 'normal'
}

export interface FxRenderer {
  /**
   * The scene graph this layer owns. THE SAME OBJECT FOR THE RENDERER'S WHOLE
   * LIFE — added to the scene once, never swapped — so nothing has to notice
   * when a frame draws a different number of effects.
   */
  readonly object: THREE.Mesh
  /** Effects drawn by the last `update`. Exposed so the pooling is assertable. */
  readonly drawnCount: number
  /** Refill the geometry from this frame's live effects. */
  update(effects: readonly Fx[]): void
  /** Release the GPU resources. Call with the rest of the scene. */
  dispose(): void
}

/** How one kind of effect looks. Everything that varies between them is here. */
interface FxStyle {
  /** Linear RGB, before the fade is applied as alpha. */
  readonly r: number
  readonly g: number
  readonly b: number
  /**
   * Half the quad's edge, in world units, at `scale` 1. A tile is 1.
   *
   * HALF, because `Fx.scale` on a burst is the blast RADIUS the `Explosion`
   * reported — so at a base of 1 the quad's half-edge is the radius itself and
   * the effect covers the circle the ordnance actually damaged. Getting this the
   * other way round would draw every blast at half the size it killed at, which
   * teaches the player the wrong distance to stand at.
   */
  readonly halfSize: number
  /**
   * How far above the ground it floats, in world units.
   *
   * Not zero for anything but the scar: a quad exactly on the terrain fights the
   * ground for the depth test and z-fights across the whole of its surface.
   */
  readonly lift: number
  /** Alpha at the instant it is born. The fade takes it to nothing from here. */
  readonly peakAlpha: number
}

const FX_STYLES: Record<FxKind, FxStyle> = {
  /** Hot white-yellow, roughly the muzzle of a standing man, and small. */
  muzzle: { r: 1, g: 0.92, b: 0.62, halfSize: 0.22, lift: 0.9, peakAlpha: 0.9 },
  /** Fire. Sized from the blast radius itself — see `FxStyle.halfSize`. */
  burst: { r: 1, g: 0.55, b: 0.18, halfSize: 1, lift: 0.35, peakAlpha: 1 },
  /**
   * A dull red puff at chest height. Deliberately not bright: it has to be
   * findable by an eye that was looking elsewhere without competing with the
   * detonation that may have caused it.
   */
  death: { r: 0.72, g: 0.12, b: 0.1, halfSize: 0.45, lift: 0.55, peakAlpha: 0.75 },
  /**
   * Scorched earth, barely off the ground. Dark, so it only reads at all under
   * `'normal'` blending — see `FxRendererOptions.blending`.
   */
  decal: { r: 0.06, g: 0.05, b: 0.04, halfSize: 0.9, lift: 0.02, peakAlpha: 0.7 },
}

/** Vertices one effect costs: two triangles, unindexed. */
const VERTICES_PER_FX = 6

/**
 * Build an effects layer. Add `object` to the scene, call `update` with the
 * buffer's `visible()` every frame, and `dispose` with the rest of the scene.
 *
 * A FACTORY OVER A CLOSURE rather than a class, matching `createFxBuffer` on the
 * other side of the boundary: everything below is private except the four things
 * the interface names, with no `private` keyword needed to say so.
 */
export function createFxRenderer(options: FxRendererOptions = {}): FxRenderer {
  // Never zero: a zero-length attribute is a draw call with nothing behind it,
  // and the whole point of this module is that the buffer is allocated once.
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_FX_CAPACITY))
  const ground = options.ground
  const vertices = capacity * VERTICES_PER_FX
  const positions = new Float32Array(vertices * 3)
  // Four components, so the alpha rides along per vertex: this is what lets one
  // mesh hold effects at a dozen different ages. Written every frame beside the
  // positions rather than seeded here, because the alpha IS the fade.
  const colours = new Float32Array(vertices * 4)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 4))
  geometry.setDrawRange(0, 0)

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending:
      options.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
    // Tested against the world but writing no depth: a burst is occluded by the
    // hill in front of it, but it must never occlude the sprites and tracers
    // drawn after it — and two effects overlapping must not punch a hole in each
    // other, which is exactly what depth writing between two transparent quads
    // does.
    depthWrite: false,
    // A flat quad has one normal and the camera looks down on it, but a quad
    // whose winding happens to flip must not disappear; double-sided is one word
    // against a whole class of invisible-effect bug.
    side: THREE.DoubleSide,
    fog: false,
  })

  const object = new THREE.Mesh(geometry, material)
  object.name = 'fx:effects'
  // The bounding volume is never recomputed as the buffer refills, so a culled
  // mesh would blink every effect out at once. `renderOrder` puts it with the
  // tracers: after the opaque world, before the debug overlay's 999.
  object.frustumCulled = false
  object.renderOrder = 500
  object.visible = false

  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute

  /** Effects drawn last frame. Backs the interface's readonly `drawnCount`. */
  let drawn = 0

  /**
   * Ground height under a WORLD position, or the ground plane when this layer
   * was built without terrain.
   *
   * `worldToTileX`/`worldToTileY` and NEVER a hand-rolled `floor(worldX + w/2)`.
   * The height sampler is indexed by CENTRE-INDEXED tile coordinates — integers
   * name tile centres — so the conversion is a round against `(w - 1) / 2`, and
   * the corner-indexed spelling half a tile away samples the tile next door.
   * Two review cycles of this project have already gone on that exact half tile.
   */
  function groundAt(worldX: number, worldZ: number): number {
    if (ground === undefined) return 0
    return ground.heightAt(worldToTileX(worldX, ground.size), worldToTileY(worldZ, ground.size))
  }

  /**
   * One vertex: its position, and the effect's colour at the alpha it has
   * reached.
   *
   * A FUNCTION, NOT A CLOSURE INSIDE THE LOOP. The obvious spelling declares a
   * local `write` that captures the running offset and the style, which allocates
   * one closure PER EFFECT PER FRAME — a few hundred a second in a firefight.
   * Immaterial to frame time, and beside the point: this file's header makes a
   * case for allocating once, and a header that says one thing while the code
   * beneath it does another is how the next person learns to stop trusting the
   * headers. The vertex INDEX is the argument, so the two attributes' differing
   * strides (3 and 4) are derived here rather than being two more things for the
   * caller to keep in step.
   */
  function writeVertex(
    vertex: number,
    x: number,
    y: number,
    z: number,
    style: FxStyle,
    alpha: number,
  ): void {
    const p = vertex * 3
    positions[p] = x
    positions[p + 1] = y
    positions[p + 2] = z
    const c = vertex * 4
    colours[c] = style.r
    colours[c + 1] = style.g
    colours[c + 2] = style.b
    colours[c + 3] = alpha
  }

  /**
   * Refill the geometry from this frame's live effects.
   *
   * IN PLACE, EVERY FRAME. `setDrawRange` is what makes a frame with no effects
   * — which is most of them — cost one number rather than a fresh geometry and a
   * fresh GPU upload sixty times a second. It is also what stops the quiet
   * failure of a pooled renderer: leftover vertices from the last frame drawn as
   * effects that never fade.
   */
  function update(effects: readonly Fx[]): void {
    let count = 0
    for (let i = 0; i < effects.length && count < capacity; i += 1) {
      const effect = effects[i]
      if (effect === undefined) continue
      const style = FX_STYLES[effect.kind]
      // A blast the ordnance table gave no radius, or a spawn that arrived with
      // a nonsense scale. There is nothing to draw at zero size and a negative
      // one would wind the quad inside out, so it is skipped here rather than
      // clamped: the buffer keeps the effect on purpose — it is a real event, and
      // hiding it would hide a genuine oddity from anyone debugging one.
      const half = style.halfSize * effect.scale
      if (!(half > 0)) continue
      // Linear burn-down. The eye is reading a flash, not a curve, and anything
      // fancier is invisible inside four tenths of a second.
      const alpha = style.peakAlpha * (1 - effect.fade)
      /**
       * A SCAR IS ON THE TERRAIN BY DEFINITION, so it ignores the effect's
       * height; everything else honours it.
       *
       * `Explosion` carries a `y` because a fuse can expire before impact and
       * detonate the round in mid-air — the event's own comment says an airburst
       * reported on the ground would hide the whole mechanic. A decal that
       * inherited that altitude would be a scorch mark hanging in the sky over
       * ground nothing burned.
       */
      const airborne = effect.kind === 'decal' ? 0 : (effect.y ?? 0)
      const y = groundAt(effect.x, effect.z) + style.lift + airborne
      const minX = effect.x - half
      const maxX = effect.x + half
      const minZ = effect.z - half
      const maxZ = effect.z + half
      // Two triangles sharing the diagonal, wound the same way round for both.
      const v = count * VERTICES_PER_FX
      writeVertex(v, minX, y, minZ, style, alpha)
      writeVertex(v + 1, maxX, y, minZ, style, alpha)
      writeVertex(v + 2, maxX, y, maxZ, style, alpha)
      writeVertex(v + 3, minX, y, minZ, style, alpha)
      writeVertex(v + 4, maxX, y, maxZ, style, alpha)
      writeVertex(v + 5, minX, y, maxZ, style, alpha)
      count += 1
    }

    drawn = count
    const drawnVertices = count * VERTICES_PER_FX
    object.visible = count > 0
    geometry.setDrawRange(0, drawnVertices)
    // Only the live prefix is re-uploaded; the tail is stale and unread. The
    // ranges are cleared first because they accumulate — left alone, this would
    // hand the driver one more range per frame for the length of the mission.
    position.clearUpdateRanges()
    position.addUpdateRange(0, drawnVertices * 3)
    position.needsUpdate = true
    colour.clearUpdateRanges()
    colour.addUpdateRange(0, drawnVertices * 4)
    colour.needsUpdate = true
  }

  function dispose(): void {
    geometry.dispose()
    material.dispose()
    object.removeFromParent()
  }

  return {
    object,
    get drawnCount() {
      return drawn
    },
    update,
    dispose,
  }
}
