/**
 * EntityRenderer — draws a `RenderEntity[]` as instanced sprite quads.
 *
 * It knows nothing about `World` and nothing about atlases (that is
 * `UnitVisual`). It knows about instancing, and it delegates
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
 *
 * ── WHY SCENERY HAS ITS OWN PATH ─────────────────────────────────────────────
 *
 * `update` rebuilds every instance matrix every frame, which is right for
 * things that move and animate and costs ~2 short-lived objects per entity per
 * frame. Ticket 010a puts 727 trees in level 1 — the exact scale that comment
 * named as the point where "a few tiny objects a frame" stops being true.
 *
 * Trees do not move, do not animate, do not turn and do not despawn. So
 * `setScenery` writes their instance buffers ONCE and the per-frame path never
 * looks at them again: no interpolation, no facing lookup, no frame lookup, no
 * allocation, and no matrix writes proportional to the tree count. They are
 * still real instanced draws and still counted in `drawCalls`; they are simply
 * not rebuilt for a frame in which nothing about them changed.
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

/**
 * Which way a source's ART IS ALREADY POINTING, in screen radians measured
 * anticlockwise from screen-right (ticket 055).
 *
 * `rocket.png` is painted flying south-west to north-east and aiming NORTH-EAST,
 * which on screen is up and to the right: a quarter turn's worth, `PI / 4`. The
 * spin applied to it is therefore the difference between where it is going and
 * where it is already drawn as going — an unrotated rocket is one flying
 * north-east, which is correct rather than a special case.
 *
 * A TABLE, AND DELIBERATELY SPARSE. Every source absent from it is drawn exactly
 * as it always was, and that is most of the game: a soldier picks his direction
 * by choosing one of eight FRAMES, and a grenade tumbles and has no nose to
 * point. Rotating either would invent a heading its art does not have.
 *
 * IT IS A FACT ABOUT THE PICTURE, so it lives here beside `CELL_WORLD_HEIGHT`
 * rather than in `core` — which decides where a round is going and must not have
 * to know how the artist drew it.
 */
const ART_HEADING_RADIANS: Readonly<Record<string, number>> = {
  rocket: Math.PI / 4,
}

/**
 * The clip whose batches are ordered behind everything else alive (ticket 050).
 *
 * Spelled here rather than imported from `sprite-atlas.ts`'s `ONE_SHOT_ANIMATIONS`,
 * which is a set about PLAYBACK — whether a clip holds its last frame — and
 * happens to contain the same single name today. Ordering the dead behind the
 * living and refusing to loop a death are two different claims, and a future
 * one-shot that is not a corpse would silently acquire this one.
 */
const DIE_CLIP = 'die'

/**
 * Where sprites sit among the transparent draws, and where corpses sit among
 * sprites.
 *
 * The GAP is the point, not the values: lower draws first, so a corpse's
 * fragments land before any living man's and lose every exact tie to him. Both
 * stay above the FX layer's default 0, so a burst still composites over a body.
 */
const SPRITE_RENDER_ORDER = 1
const CORPSE_RENDER_ORDER = 0.5

/** The animation half of a batch key, which is `unit|animation|direction|frame`. */
function animationOf(key: string): string {
  return key.split('|')[1] ?? ''
}

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
  /**
   * The entity's heading on the ground plane, carried through UNSMOOTHED and
   * unrelated to `direction` (ticket 055).
   *
   * `direction` is one of eight compass names and is part of the batch KEY,
   * because it selects an atlas rect. This is the continuous heading a turned
   * sprite is spun by, and it must not reach the key: two rockets a degree apart
   * would otherwise be two batches, which is the failure `batching.ts` exists to
   * prevent.
   */
  readonly dx: number
  readonly dz: number
  /** See `RenderEntity.submersion`. A fraction of this sprite's own height. */
  readonly submersion: number
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

  /** The previous and current sim states — what `update`'s alpha blends between. */
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
   * Static scenery: the entities as given, and the batch keys they built.
   *
   * The entities are retained only so `setElevation` can rebuild the buffers —
   * the vertical pre-stretch is baked into every instance matrix, so a camera
   * angle change has to redo them. Nothing per-frame reads either of these.
   */
  private scenery: readonly RenderEntity[] = []
  private readonly sceneryKeys = new Set<string>()

  /**
   * How much taller than its on-screen height a quad is built, `1 / cos(e)`.
   * See the header. Set by `setElevation`, never a constant.
   */
  private verticalStretch = 1

  /** The camera elevation the stretch was computed from, clamped. See `setElevation`. */
  private elevationRad = 0

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
  /** A second matrix, so a turned sprite composes without allocating. */
  private readonly scratchRotation = new THREE.Matrix4()
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
    const stretch = 1 / Math.cos(clamped)
    if (stretch === this.verticalStretch) return
    this.verticalStretch = stretch
    // Kept because the SPIN needs the angle itself, not the stretch derived from
    // it: a ground heading is foreshortened by `sin(elevation)` on screen, which
    // `1 / cos` cannot be turned back into without a sign ambiguity.
    this.elevationRad = clamped
    // Scenery matrices have the old stretch baked in and are never rewritten by
    // `update`. Nothing rebuilds them if this does not.
    if (this.scenery.length > 0) this.buildScenery()
  }

  /**
   * Hand the renderer the level's static scenery — trees, and whatever else is
   * derived from terrain rather than from the sim.
   *
   * Written to the GPU once, here, and then left alone. Anything that moves,
   * animates or is destroyed belongs in `setEntities` instead; there is no
   * mechanism to update a single scenery instance, because the moment one is
   * needed the thing is not scenery.
   */
  setScenery(entities: readonly RenderEntity[]): void {
    this.scenery = [...entities]
    this.buildScenery()
  }

  /**
   * Hand the renderer a new sim state.
   *
   * The state it was last given becomes the previous one, which is what
   * `update`'s alpha interpolates from. Call it once per SIM TICK, not per
   * frame: `src/app/main.ts` calls it only on a frame that actually ran a step,
   * because calling it on a frame that ran none makes previous and current the
   * same state and `alpha` then blends a state with itself.
   */
  setEntities(entities: readonly RenderEntity[]): void {
    this.previous = this.current
    this.current = [...entities]
  }

  /**
   * How many instanced draws the renderer is currently issuing — asserted by
   * acceptance. Scenery is included: it is drawn every frame like everything
   * else, it is merely not rebuilt every frame.
   */
  get drawCalls(): number {
    return this.visibleBatches + this.sceneryKeys.size
  }

  /**
   * Fill the scenery batches from `this.scenery`. Called on `setScenery` and on
   * an elevation change, and on nothing else.
   *
   * Scenery keys are namespaced so a static tree and a hypothetical simulated
   * one could never land in the same instanced mesh — one of which is rewritten
   * per frame and one of which is not, so sharing a mesh would have the dynamic
   * fill silently truncate the static instances with its own `mesh.count`.
   */
  private buildScenery(): void {
    for (const key of this.sceneryKeys) {
      const batch = this.meshes.get(key)
      if (!batch) continue
      this.destroy(batch)
      this.meshes.delete(key)
    }
    this.sceneryKeys.clear()

    const items: SpriteDrawItem[] = []
    for (const entity of this.scenery) {
      // Frame 0 of the default facing, directly: scenery has no animation clock
      // to consult and no direction to derive, so routing it through `frameAt`
      // and `stableFacing` would be ceremony around two constants.
      const sprite = this.visual.frame(entity.unit, entity.animation, DEFAULT_FACING, 0)
      if (!sprite) continue
      items.push({
        id: entity.id,
        unit: entity.unit,
        animation: entity.animation,
        direction: DEFAULT_FACING,
        frame: 0,
        // Scenery is rooted where the level put it and has no heading; a tree is
        // never spun. Stated rather than inherited, so the day a turned prop
        // exists this is the line that has to say so.
        dx: 0,
        dz: 0,
        x: entity.x,
        z: entity.z,
        y: entity.y,
        // Honoured for scenery too, even though everything that reaches this
        // path answers 0 today: a batch built here is written once and never
        // rebuilt, so a producer that later says otherwise would be silently
        // ignored rather than visibly wrong.
        submersion: entity.submersion ?? 0,
        sprite,
        tint: entity.tint,
      })
    }

    for (const batch of groupIntoBatches(items)) {
      const key = `scenery:${batch.key}`
      this.fill(key, batch.items)
      this.sceneryKeys.add(key)
    }
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
        // The RAW heading, not `facing`. See `SpriteDrawItem.dx`.
        dx: entity.dx,
        dz: entity.dz,
        // From the CURRENT sim state, not interpolated between the two.
        // `interpolateEntities` smooths position because a sprite sliding
        // between ticks is what 60fps rendering is for; submersion is a step
        // function of the tile underfoot, and blending it would draw a man
        // half-sunk for the frames either side of the waterline — a
        // three-frame ramp nobody asked for on a value that has two states.
        submersion: entity.submersion ?? 0,
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
      if (this.drawn.has(key) || this.sceneryKeys.has(key)) continue
      batch.mesh.count = 0
      batch.mesh.visible = false
    }

    this.visibleBatches = visible
  }

  /**
   * How far to turn this sprite in the screen plane, in radians. Zero for
   * everything whose art has no heading — which is everything but the rocket.
   *
   * THE ANGLE IS COMPUTED ON SCREEN, NOT ON THE GROUND, and that is the part
   * worth reading twice. The camera looks down at `elevationRad`, so the ground's
   * north-south axis is squashed by `sin(elevation)` on its way to the screen
   * while its east-west axis is not. A round flying north-east does not appear to
   * lean at 45 degrees: at the shipped 55 it leans at `atan(sin 55)`, 39.3.
   *
   * SO `atan2(-dz, dx)` IS WRONG, AND WRONG IN THE WAY THAT SURVIVES A LOOK. It
   * is exactly right for all four axis-aligned headings — due east, west, north
   * and south — and off by up to six degrees for everything between. `-dz`
   * because `+z` is south and screen-y counts upward.
   */
  private spinFor(item: SpriteDrawItem): number {
    const baked = ART_HEADING_RADIANS[item.unit]
    if (baked === undefined) return 0
    const { dx, dz } = item
    // A round with no heading — a degenerate trajectory, or any producer that
    // leaves the field at zero — is drawn exactly as the artist painted it rather
    // than snapped to `atan2(0, 0)`, which is 0 and would mean due east.
    if (dx === 0 && dz === 0) return 0
    const screenAngle = Math.atan2(-dz * Math.sin(this.elevationRad), dx)
    return screenAngle - baked
  }

  /** Write one batch's instances into its mesh. */
  private fill(key: string, items: readonly SpriteDrawItem[]): void {
    const batch = this.meshFor(key, items.length)
    const { mesh, uv } = batch

    items.forEach((item, index) => {
      const sprite = item.sprite

      // THE QUAD'S WORLD HEIGHT, which is the number `core` is not allowed to
      // know and this is therefore the only place that can apply a submersion
      // (ticket 041). It is the sprite's authored height TIMES the vertical
      // pre-stretch — see the header — because the stretch is what makes the
      // quad project at its authored on-screen size. Sinking by a fraction of
      // the unstretched height would hide `cos(elevation)` of what was asked
      // for, i.e. 40% of the man rather than 70%, and would change with the
      // `?elev=` knob.
      const quadHeight = sprite.height * this.verticalStretch

      // HOW A MAN ENDS UP IN THE RIVER RATHER THAN ON IT. There is no shader
      // and no clipping: the whole quad is simply lowered, and the depth buffer
      // does the hiding. The material already runs `depthTest` and `depthWrite`
      // (see `ALPHA_TEST`, which is what makes writing depth from a blended
      // sprite safe), and the terrain and its water surface are opaque, so
      // whatever is pushed below the surface SHOULD fail the depth test and not
      // appear. Reasoned from the material settings and the geometry, not
      // watched — nobody has rendered this build, and if the sink turns out to
      // read wrong on screen this is the sentence that was doing the guessing. A dry sprite has `submersion === 0` and this term is
      // exactly zero, so it is drawn precisely where it always was.
      const sink = item.submersion * quadHeight

      // The quad centre, offset from the ground anchor: anchor + offset + rect,
      // exactly as the manifest defines them — never the rect's own centre, or
      // `die` slides. The vertical offset is stretched by the same factor as the
      // quad itself, so the anchor row still lands on the ground and the centre
      // still projects where the manifest says it should.
      this.scratchPosition.set(
        item.x + sprite.centreX,
        item.y + GROUND_LIFT + sprite.centreY * this.verticalStretch - sink,
        item.z,
      )
      const spin = this.spinFor(item)
      if (spin === 0) {
        // THE PATH EVERY SPRITE IN THE GAME BUT ONE TAKES, unchanged and taken
        // first: identical arithmetic to before ticket 055, so nothing that was
        // already drawn moves by even a float.
        this.scratchScale.set(sprite.width, quadHeight, 1)
        this.scratchMatrix.compose(this.scratchPosition, this.quadRotation, this.scratchScale)
      } else {
        /**
         * A TURNED SPRITE, AND THE ORDER IS THE WHOLE OF IT:
         *
         *     T . Sy(stretch) . Rz(spin) . S(width, height, 1)
         *
         * The rotation sits INSIDE the vertical stretch rather than outside it,
         * and composing them the other way round is the obvious bug. The stretch
         * exists because an upright quad is foreshortened by `cos(elevation)` on
         * its way to the screen; pre-stretching by `1 / cos` cancels that exactly.
         * So a direction rotated BEFORE the stretch, then stretched, then
         * projected, comes out at the angle it was rotated to — while rotating
         * AFTER the stretch turns an already-elongated quad and skews it, which
         * reads as a rocket that stretches and leans as it turns.
         *
         * At `spin === 0` this reduces to `S(width, height * stretch, 1)`, which
         * is exactly the branch above — asserted, not assumed, in
         * `rocket-facing.test.ts`.
         */
        this.scratchScale.set(sprite.width, sprite.height, 1)
        this.scratchMatrix.makeScale(this.scratchScale.x, this.scratchScale.y, 1)
        this.scratchRotation.makeRotationZ(spin)
        this.scratchMatrix.premultiply(this.scratchRotation)
        this.scratchRotation.makeScale(1, this.verticalStretch, 1)
        this.scratchMatrix.premultiply(this.scratchRotation)
        this.scratchMatrix.setPosition(this.scratchPosition)
      }
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
    // sprites ahead of any later transparent effects, which sit at the default 0.
    //
    // AND THE DEAD ARE ORDERED BELOW THE LIVING (ticket 050). A man walking
    // across a body was drawn UNDER it, and the cause was a TIE rather than a
    // depth bug: his feet and the corpse share a tile at the same ground height,
    // so their fragments carry the same depth, and `LessEqualDepth` lets whatever
    // is drawn LAST overwrite. Every batch is a separate mesh sharing one
    // material at one render order, all sitting at the origin — the geometry is a
    // unit quad and real positions ride in the instance matrices — so Three's
    // transparent sort had no distance to compare, fell through to object id, and
    // ended up deciding by MESH CREATION ORDER. Nobody dies before somebody
    // walks, so the corpse mesh was always the younger object and always drew
    // last.
    //
    // Stating the order fixes only the tie. A living man genuinely BEHIND a body
    // still fails the depth test and is still hidden by it, exactly as before.
    mesh.renderOrder = animationOf(key) === DIE_CLIP ? CORPSE_RENDER_ORDER : SPRITE_RENDER_ORDER
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
   * once per level transition.
   */
  dispose(): void {
    for (const batch of this.meshes.values()) this.destroy(batch)
    this.meshes.clear()
    this.sceneryKeys.clear()
    this.scenery = []
    this.facings.clear()
    this.geometry.dispose()
    this.material.dispose()
    // The unit visual — and so the sprite atlas texture — is NOT disposed here:
    // it is loaded once at boot and owned by the caller, which may build a
    // second level from it (ticket 020). Disposing it with the renderer would
    // release the texture the NEXT level's renderer is already bound to.
    this.group.clear()
  }
}
