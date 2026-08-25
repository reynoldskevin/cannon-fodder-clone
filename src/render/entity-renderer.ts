/**
 * EntityRenderer — draws a `RenderEntity[]` as instanced sprite quads.
 *
 * It knows nothing about `World` (ticket 005, not built yet) and nothing about
 * atlases (that is `UnitVisual`). It knows about instancing, and it delegates
 * every actual DECISION — which facing, which frame, which batch, where between
 * two sim states — to the pure, unit-tested modules in `core/render-state`.
 * Nothing in this file re-implements any of that logic; if a rule about frames
 * or facings is worth having, it is worth having under test, which means it is
 * not in here.
 *
 * ── WHY AN UPRIGHT QUAD PRE-STRETCHED BY 1/cos(elevation) ────────────────────
 *
 * The camera is locked: yaw 0, elevation 55 degrees, orthographic (`CameraRig`).
 * The source art was DRAWN at that same 55 degrees — that is the whole premise
 * of ticket 004 replacing the planned voxelisation. So the art already contains
 * the foreshortening, and whatever we put it on must project at its authored
 * size or it is foreshortened twice.
 *
 * Three candidates, and the first is the one that is easy to ship by accident:
 *
 * 1. A PLAIN UPRIGHT BILLBOARD of the sprite's authored height. A vertical
 *    segment of length `h` projects to `h * cos(55) = 0.57h` on screen, so
 *    every soldier is squashed to 57% — uniformly enough to read as a
 *    stylistic choice rather than as a projection bug. Rejected outright.
 *
 * 2. A QUAD TILTED TO FACE THE CAMERA — normal `(0, sin e, cos e)`, up axis
 *    `(0, cos e, -sin e)`. It projects 1:1 and its bottom edge lies on the
 *    ground, which is right; and it was what shipped first. It is wrong for a
 *    reason that has nothing to do with size: because the quad's normal IS the
 *    view direction, every pixel of a sprite shares the depth of its feet. Its
 *    up axis has risen only `0.5 * cot(55) = 0.35` world units by the time it
 *    reaches the near edge of the tile to the NORTH, so any northern neighbour
 *    taller than that physically intersects the quad and slices it. Measured
 *    over level 1: 209 of 1481 walkable tiles have such a neighbour, and on the
 *    common one — walkable grass at 0.05 south of blocked canopy at 0.95 — the
 *    soldier is cut off from `v = 0.62` upward, i.e. everything from mid-thigh
 *    up disappears behind the jungle line. That is a gameplay-critical unit
 *    hidden by scenery BEHIND it.
 *
 * 3. AN UPRIGHT QUAD PRE-STRETCHED BY `1 / cos(e)`, which is what this is. The
 *    quad stays vertical and its world height is `h / cos(55) = 1.74h`, so it
 *    projects to exactly `h` — the same on-screen rectangle as (2), to within
 *    floating error, at every elevation (verified corner by corner at 25, 55
 *    and 89 degrees). What it buys is depth. Work out the depth of a sprite
 *    pixel `v` up the screen and of whatever terrain covers that same screen
 *    position, and the difference comes out at exactly `dz / cos(e)`: the
 *    sprite loses to terrain SOUTH of it, wins against terrain NORTH of it, and
 *    the height of that terrain never enters into it. Depth ordering becomes
 *    ground-plane ordering, which is the painter's order this projection wants.
 *    Re-measured over the same 1481 walkable tiles at 25, 40, 55, 70, 80 and 89
 *    degrees: 0 tiles lose a single sprite pixel to terrain north of the unit.
 *
 * The tradeoff (3) makes, stated plainly: a sprite's head now sits `h * tan(e)`
 * = 2.2 world units closer to the camera than its feet, so where a sprite and
 * terrain occupy the SAME z the sprite wins. It hides scenery rather than being
 * hidden by it, which is the right way round — the unit is what the player is
 * trying to look at.
 *
 * The stretch is taken from the rig's live elevation rather than a constant,
 * because elevation is a runtime knob (`?elev=`) and a quad stretched for 55
 * under a 40-degree camera would foreshorten again, just less. It is clamped at
 * 89 degrees (`MAX_QUAD_ELEVATION`) because at exactly 90 an upright quad has no
 * on-screen height at all — the same value `parseElevation` already caps at.
 * The stretch is what makes `CameraRig`'s ortho depth box symmetric: a tree at
 * 89 degrees stands 238 world units toward the camera, which a near plane at
 * 0.1 would clip.
 *
 * ── HOW ONE MATERIAL SERVES EVERY FRAME ─────────────────────────────────────
 *
 * Batches differ only in which atlas rect they sample. Giving each its own
 * material would mean a material — and a shader program lookup — per animation
 * frame per direction, ~96 for the soldier alone. Instead there is exactly ONE
 * material, and the UV rect is a per-instance vertex attribute (`aUvRect`)
 * injected into the stock shader. Every batch is the same program and the same
 * texture, so the driver switches nothing between draws.
 */

import * as THREE from 'three'
import { frameAt, phaseOffset } from '../core/render-state/animation'
import { groupIntoBatches, type DrawItem } from '../core/render-state/batching'
import type { RenderEntity } from '../core/render-state/entity'
import { DEFAULT_FACING, stableFacing, type Facing } from '../core/render-state/facing'
import { interpolateEntities, type EntitySnapshot } from '../core/render-state/interpolation'
import type { SpriteFrame, UnitVisual } from './sprite-atlas'

/**
 * Alpha below which a fragment is discarded outright.
 *
 * The compromise this ticket has to make. The sprites have antialiased edges —
 * they want alpha BLENDING, and blended geometry cannot write depth without
 * mis-ordering its own fringes. But sprites must also occlude each other and be
 * occluded by terrain correctly, which needs depth. Pure blending with
 * `depthWrite: false` gives soldiers that show through hills.
 *
 * So: blend AND write depth, with a low alpha test. Fragments below the
 * threshold — the transparent padding and the outermost feathering — are
 * discarded and never pollute the depth buffer; everything above it blends
 * normally and sorts correctly per pixel. What is lost is correct ordering
 * within the ~1px band between the threshold and opaque, on the rare pixels
 * where two sprites' soft edges overlap. That is invisible; a soldier drawn
 * through a hillside is not.
 */
const ALPHA_TEST = 0.25

/**
 * How far the anchor is lifted off the terrain, in world units.
 *
 * The quad's bottom edge is exactly the ground plane, so at grazing depth
 * precision it z-fights with the terrain top face it stands on. A fiftieth of a
 * tile is far below anything visible at any legal zoom and comfortably clears
 * the depth buffer's resolution here.
 */
const GROUND_LIFT = 0.02

/** Instance capacity a fresh batch mesh starts at; it grows by doubling. */
const INITIAL_CAPACITY = 16

/**
 * Ceiling on the elevation the vertical stretch is computed from, in radians.
 *
 * `1 / cos(e)` runs away to infinity at 90 degrees, where an upright quad
 * projects to a horizontal line and there is no size that would be right. 89 is
 * where `parseElevation` already caps the `?elev=` knob, for the same reason
 * `lookAt` degenerates there; matching it keeps the stretch finite (57.3x at
 * worst) without inventing a second, different limit.
 */
const MAX_QUAD_ELEVATION = (89 * Math.PI) / 180

/** Per-instance data batching carries through for us, on top of what it keys on. */
interface SpriteDrawItem extends DrawItem {
  readonly y: number
  readonly sprite: SpriteFrame
  readonly tint: number | undefined
}

/** One instanced draw: a mesh plus the UV attribute the shader reads. */
interface BatchMesh {
  mesh: THREE.InstancedMesh
  uv: THREE.InstancedBufferAttribute
  capacity: number
}

export class EntityRenderer {
  /** Everything this renderer owns, ready to add to a scene. */
  readonly group: THREE.Group

  private readonly visual: UnitVisual
  private readonly material: THREE.MeshBasicMaterial
  private readonly geometry: THREE.PlaneGeometry
  private readonly meshes = new Map<string, BatchMesh>()

  /** The previous and current sim states. Identical until ticket 005 exists. */
  private previous: RenderEntity[] = []
  private current: RenderEntity[] = []

  /**
   * Last facing drawn for each entity, which is what makes `stableFacing`
   * hysteretic rather than merely a mapping. Pruned every frame against the
   * live entity set, so a despawned unit's entry does not outlive it — this map
   * is the only thing in here that could accumulate across a mission.
   */
  private readonly facings = new Map<number, Facing>()

  /**
   * How much taller than its on-screen height a quad is built, `1 / cos(e)`.
   * See the header. Set by `setElevation`, never a constant.
   */
  private verticalStretch = 1

  /**
   * Reused every frame.
   *
   * Not "nothing allocates" — see `update`, which is honest about what does.
   * These are the pieces where reuse is worth the mutable state: the item list
   * (grows once to the peak entity count and is then only truncated), the
   * lookup maps, and the Three.js scratch objects, which would otherwise be
   * three vectors, a matrix and a colour PER ENTITY per frame.
   */
  private readonly items: SpriteDrawItem[] = []
  private readonly positions = new Map<number, EntitySnapshot>()
  private readonly live = new Set<number>()
  private readonly drawn = new Set<string>()
  /** Identity: the quads are upright and the camera never yaws. */
  private readonly quadRotation = new THREE.Quaternion()
  private readonly scratchPosition = new THREE.Vector3()
  private readonly scratchScale = new THREE.Vector3()
  private readonly scratchMatrix = new THREE.Matrix4()
  private readonly scratchColour = new THREE.Color()

  private visibleBatches = 0

  constructor(visual: UnitVisual, elevationRad: number) {
    this.visual = visual
    this.group = new THREE.Group()
    this.group.name = 'entities'

    // Unit quad in the XY plane, origin at its centre. Every per-frame size and
    // offset rides in the instance matrix, so this one geometry serves every
    // sprite in the game and is never rebuilt.
    this.geometry = new THREE.PlaneGeometry(1, 1)

    this.material = new THREE.MeshBasicMaterial({
      map: visual.texture,
      transparent: true,
      alphaTest: ALPHA_TEST,
      depthWrite: true,
      depthTest: true,
      // The quads face the camera, so only one side is ever seen — but the
      // material is `MeshBasicMaterial` precisely because the art is ALREADY
      // shaded, and a double-sided unlit quad cannot be got wrong by a winding
      // mistake. A lit material would double-light the art and, worse, shade
      // the flat quad by its own tilted normal.
      side: THREE.DoubleSide,
      // The scene is fogged as aerial haze; sprites must recede with the
      // terrain they stand on or they float in front of it at distance.
      fog: true,
    })
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aUvRect;')
        // `begin_vertex` runs after `uv_vertex` has already written vMapUv from
        // the geometry's own UVs, so this overwrites it with the instance's
        // rect. Injecting earlier would be silently undone.
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvMapUv = aUvRect.xy + uv * aUvRect.zw;',
        )
    }

    this.setElevation(elevationRad)
  }

  /**
   * Retune the vertical stretch to match the camera. See the header: the quad's
   * pre-stretch and the camera's elevation must agree, or the art that was
   * already drawn at an angle is foreshortened a second time.
   */
  setElevation(elevationRad: number): void {
    if (!Number.isFinite(elevationRad)) return
    const clamped = Math.min(Math.abs(elevationRad), MAX_QUAD_ELEVATION)
    this.verticalStretch = 1 / Math.cos(clamped)
  }

  /**
   * Hand the renderer a new sim state.
   *
   * The state it was last given becomes the previous one, which is what
   * `update`'s alpha interpolates from. Called once per SIM tick, not per
   * frame; today it is called once at level load, and previous and current are
   * therefore the same list.
   */
  setEntities(entities: readonly RenderEntity[]): void {
    this.previous = this.current
    this.current = [...entities]
  }

  /** How many draw calls the last `update` produced — asserted by acceptance. */
  get drawCalls(): number {
    return this.visibleBatches
  }

  /**
   * Rebuild the instance buffers for this frame.
   *
   * `elapsedSeconds` is the renderer's own monotonic clock (animations are
   * timed against it); `alpha` is the sim loop's fraction between the previous
   * and current tick.
   *
   * WHAT THIS ALLOCATES, since "nothing" would be a comfortable lie and the
   * kind someone later trusts. Per frame, for `n` entities and `b` batches:
   * `interpolateEntities` returns a fresh array with an object per entity;
   * `items.push({...})` is one more literal per entity; `groupIntoBatches`
   * builds a Map, an array per batch, a spread and a sort, and returns `b`
   * objects; and `fill` closes over its index inside `forEach`. Call it ~2n + 5b
   * short-lived objects.
   *
   * What is reused is the expensive half: the Three.js scratch vectors, matrix,
   * quaternion and colour (otherwise 5 per entity per frame, and `Matrix4` is 16
   * floats), the instance buffers, and the meshes, which only ever grow. At the
   * 8 entities on screen today, and at the 50 or so a mission is planned to
   * reach, ~110 tiny objects a frame is inside one nursery collection and below
   * measurement. It would stop being true in the thousands, and the fix then is
   * to key the per-entity state by id into preallocated arrays — not to shave
   * the scratch objects, which are already gone.
   */
  update(elapsedSeconds: number, alpha: number): void {
    this.items.length = 0
    this.live.clear()
    this.positions.clear()

    for (const p of interpolateEntities(this.previous, this.current, alpha)) {
      this.positions.set(p.id, p)
    }

    for (const entity of this.current) {
      const at = this.positions.get(entity.id)
      if (!at) continue
      this.live.add(entity.id)

      const clip = this.visual.clip(entity.unit, entity.animation)

      // Phase offset is applied in SECONDS, scaled by the clip's own cycle
      // length, so a squad spreads across its cycle whatever the fps.
      //
      // LOOPING CLIPS ONLY. Both halves of this are individually correct and
      // individually tested; composing them on a one-shot clip is not. `die` is
      // 4 frames at 8fps — a 0.5s cycle — so a phase offset uniform in [0, 1)
      // would start each corpse `phase * 0.5` seconds INTO its own death: a
      // quarter of all units would skip straight to the final frame and never
      // animate at all, half would miss most of it, and only ids with a phase
      // under 0.25 would play it in full. A one-shot clip has to start at its
      // own frame 0, and it has nothing to desynchronise anyway — deaths happen
      // when they happen, they are not a cycle to spread a squad across.
      const cycle = clip.loop && clip.fps > 0 ? clip.frameCount / clip.fps : 0
      const local = elapsedSeconds - entity.animationStart + phaseOffset(entity.id) * cycle
      const frame = frameAt(clip, local)

      const previousFacing = this.facings.get(entity.id) ?? DEFAULT_FACING
      const facing = stableFacing(previousFacing, entity.dx, entity.dz)
      this.facings.set(entity.id, facing)

      const sprite = this.visual.frame(entity.unit, entity.animation, facing, frame)
      // A visual with nothing for this entity draws nothing, rather than a
      // magenta box or a throw. A stub `UnitVisual` is allowed to be empty.
      if (!sprite) continue

      this.items.push({
        id: entity.id,
        unit: entity.unit,
        animation: entity.animation,
        direction: facing,
        frame,
        x: at.x,
        z: at.z,
        y: entity.y,
        sprite,
        tint: entity.tint,
      })
    }

    // Despawned entities release everything they held: their instance slots (by
    // simply not being in `items` — the batches describe only what is passed)
    // and their facing memory (here).
    if (this.facings.size > this.live.size) {
      for (const id of this.facings.keys()) if (!this.live.has(id)) this.facings.delete(id)
    }

    this.drawn.clear()
    let visible = 0
    for (const batch of groupIntoBatches(this.items)) {
      this.fill(batch.key, batch.items)
      this.drawn.add(batch.key)
      visible += 1
    }

    // Meshes whose batch has no members this frame: count 0 and hidden, so they
    // cost nothing but stay in the pool for when that frame comes round again.
    for (const [key, batch] of this.meshes) {
      if (this.drawn.has(key)) continue
      batch.mesh.count = 0
      batch.mesh.visible = false
    }

    this.visibleBatches = visible
  }

  /** Write one batch's instances into its mesh. */
  private fill(key: string, items: readonly SpriteDrawItem[]): void {
    const batch = this.meshFor(key, items.length)
    const { mesh, uv } = batch

    items.forEach((item, index) => {
      const sprite = item.sprite

      // The quad centre, offset from the ground anchor: anchor + offset + rect,
      // exactly as the manifest defines them — never the rect's own centre, or
      // `die` slides. The vertical offset is stretched by the same factor as the
      // quad itself, so the anchor row still lands on the ground and the centre
      // still projects where the manifest says it should.
      this.scratchPosition.set(
        item.x + sprite.centreX,
        item.y + GROUND_LIFT + sprite.centreY * this.verticalStretch,
        item.z,
      )
      this.scratchScale.set(sprite.width, sprite.height * this.verticalStretch, 1)
      this.scratchMatrix.compose(this.scratchPosition, this.quadRotation, this.scratchScale)
      mesh.setMatrixAt(index, this.scratchMatrix)

      const base = index * 4
      uv.array[base] = sprite.u0
      uv.array[base + 1] = sprite.v0
      uv.array[base + 2] = sprite.du
      uv.array[base + 3] = sprite.dv

      this.scratchColour.set(item.tint ?? 0xffffff)
      mesh.setColorAt(index, this.scratchColour)
    })

    mesh.count = items.length
    mesh.visible = items.length > 0
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    uv.needsUpdate = true
  }

  /**
   * The mesh for a batch key, grown if this frame needs more instances than it
   * can hold.
   *
   * Capacity DOUBLES rather than tracking the exact count. `InstancedMesh`
   * allocates its buffers at construction, so a resize means discarding GPU
   * buffers and building new ones; doubling makes that logarithmic in the peak
   * count and effectively never after the first seconds of a mission, instead
   * of once per new arrival.
   */
  private meshFor(key: string, needed: number): BatchMesh {
    const existing = this.meshes.get(key)
    if (existing && existing.capacity >= needed) return existing

    let capacity = existing?.capacity ?? INITIAL_CAPACITY
    while (capacity < needed) capacity *= 2

    if (existing) this.destroy(existing)

    const uv = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    uv.setUsage(THREE.DynamicDrawUsage)
    // The UV attribute is per-BATCH, so it goes on a per-batch clone of the
    // shared quad. Attaching it to `this.geometry` directly would give every
    // batch whichever rects were written last.
    const geometry = this.geometry.clone()
    geometry.setAttribute('aUvRect', uv)

    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity)
    mesh.name = `entities:${key}`
    mesh.count = 0
    // The geometry is a unit quad at the origin; every real position lives in
    // the instance matrices, so Three's bounding sphere describes nothing the
    // culler could use. There are only a handful of these and they are all on
    // screen by construction.
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    // Alpha-blended, so drawn after the opaque terrain regardless; this keeps
    // sprites ahead of any later transparent decal work.
    mesh.renderOrder = 1
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    // Allocate the colour buffer up front so `setColorAt` never has to, and so
    // the USE_INSTANCING_COLOR define is stable for the shared program.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

    const batch: BatchMesh = { mesh, uv, capacity }
    this.meshes.set(key, batch)
    this.group.add(mesh)
    return batch
  }

  private destroy(batch: BatchMesh): void {
    this.group.remove(batch.mesh)
    // The per-mesh geometry clone is this mesh's own and must go with it. The
    // shared source geometry and the shared material must NOT — they outlive
    // every individual batch and are released in `dispose`.
    batch.mesh.geometry.dispose()
    batch.mesh.dispose()
  }

  /**
   * Release every GPU resource this renderer owns.
   *
   * Ticket 020 rebuilds a scene per mission, so anything skipped here leaks
   * once per level transition — the texture especially, which is a 2048x2624
   * atlas, 21.5 MB of VRAM before its mip chain.
   */
  dispose(): void {
    for (const batch of this.meshes.values()) this.destroy(batch)
    this.meshes.clear()
    this.facings.clear()
    this.geometry.dispose()
    this.material.dispose()
    this.visual.dispose()
    this.group.clear()
  }
}
