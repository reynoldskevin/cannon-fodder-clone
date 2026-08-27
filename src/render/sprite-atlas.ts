/**
 * `UnitVisual` — the abstraction over "how a unit is drawn" — and the sprite
 * atlas implementation of it that ticket 004's `tools/spritegen` output feeds.
 *
 * ARCHITECTURE.md keeps `UnitVisual` an interface on purpose. It was written as
 * the escape hatch for voxel meshes failing; it is now the escape hatch in the
 * other direction, and it is what lets `EntityRenderer` be exercised against a
 * stub with no atlas, no fetch and no PNG.
 *
 * THE TWO THINGS THAT SILENTLY LOOK PLAUSIBLE IF YOU GET THEM WRONG:
 *
 * 1. **V FLIP.** The manifest states `origin: "top-left"`, y increasing
 *    downward — the PNG convention. Three.js texture UVs are bottom-left
 *    origin. With the default `flipY = true` the image is uploaded flipped, so
 *    a PNG row `y` lands at `v = 1 - y / atlasHeight`, and a rect spanning rows
 *    `[y, y + h)` occupies `v` from `1 - (y + h) / H` up to `1 - y / H`. Skip
 *    the flip and nothing crashes and nothing looks broken — every sprite is
 *    simply mirrored top-to-bottom, which on a symmetric-ish soldier reads as
 *    "the art is a bit odd" rather than as a bug.
 *
 * 2. **ANCHOR + OFFSET, NOT CONTENT CENTRING.** `anchor` is the source cell's
 *    bottom-centre — the point that meets the ground, constant across an
 *    animation. `offset` is where the trimmed rect sat inside that cell. Both
 *    are needed. Re-centring a frame on its own pixels instead would look right
 *    for `walk`, whose frames are all the same size, and then slide a dying
 *    soldier up the screen as the `die` frames shrink upward from a fixed
 *    baseline.
 */

import * as THREE from 'three'
import type { AnimationClip } from '../core/render-state/animation'
import type { Facing } from '../core/render-state/facing'

/** A failure loading or reading the atlas, phrased for the boot error overlay. */
export class SpriteAtlasError extends Error {
  constructor(
    readonly detail: string,
    readonly technical: string,
  ) {
    super(`${detail} (${technical})`)
    this.name = 'SpriteAtlasError'
  }
}

/**
 * One frame, already reduced to what the renderer needs: where to sample and
 * where to put it. All lengths are world units except the UV rect.
 *
 * `centreX` / `centreY` are the quad centre's offset FROM THE ANCHOR, measured
 * in the sprite's own plane with y up. The anchor itself sits on the ground.
 */
export interface SpriteFrame {
  readonly u0: number
  readonly v0: number
  readonly du: number
  readonly dv: number
  readonly width: number
  readonly height: number
  readonly centreX: number
  readonly centreY: number
}

/**
 * How a unit is drawn. `EntityRenderer` depends on this and on nothing about
 * atlases, manifests or PNGs.
 */
export interface UnitVisual {
  /** The single texture every batch samples. One texture is what makes one material possible. */
  readonly texture: THREE.Texture
  /** Playback properties for an animation, or a one-frame held clip if it is unknown. */
  clip(unit: string, animation: string): AnimationClip
  /** The frame to draw, or `null` if this visual has nothing for that request. */
  frame(unit: string, animation: string, direction: Facing, frame: number): SpriteFrame | null
  dispose(): void
}

/* ------------------------------------------------------------------ manifest */

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
interface Point {
  readonly x: number
  readonly y: number
}
interface Cell {
  readonly width: number
  readonly height: number
}
interface ManifestFrame {
  readonly rect: Rect
  readonly offset: Point
  readonly anchor: Point
}
interface ManifestAnimation {
  readonly fps: number
  readonly directions: Readonly<Record<string, { readonly frames: readonly ManifestFrame[] }>>
}
interface ManifestUnit {
  readonly cell: Cell
  readonly animations: Readonly<Record<string, ManifestAnimation>>
}
interface ManifestProp extends ManifestFrame {
  readonly cell: Cell
}
/**
 * One tileable ground texture (ticket 009c; three of them since ticket 034).
 *
 * Deliberately NOT in the atlas: these are the images that have to wrap, and a
 * packed rect cannot — `RepeatWrapping` wraps the whole texture, so a tiling
 * source must own its own image. The record is optional in the type because a
 * manifest emitted before ticket 034 has `floor` instead and no `ground` at all;
 * `loadGroundTextures` turns that into a named boot failure rather than a
 * `undefined.file` read.
 */
interface ManifestGround {
  readonly file: string
  readonly width: number
  readonly height: number
  readonly tileable: boolean
}

export interface SpriteManifest {
  readonly version: number
  readonly origin: string
  readonly scale: number
  readonly atlas: { readonly file: string; readonly width: number; readonly height: number }
  readonly units: Readonly<Record<string, ManifestUnit>>
  readonly props: Readonly<Record<string, ManifestProp>>
  readonly ground?: Readonly<Record<string, ManifestGround | undefined>>
}

/* --------------------------------------------------------------- world sizes */

/**
 * How tall one source CELL is in world units, per sprite source.
 *
 * The cell, not the trimmed rect: the rect changes shape from frame to frame
 * (a `die` frame is 83px tall where a `walk` frame is 163) and scaling by it
 * would make a soldier pulse as it animates. Tiles are 1 world unit across, so
 * a soldier's 180px cell at 1.7 puts the figure itself — 163 of those px —
 * about 1.5 tiles tall, which is the Cannon Fodder proportion.
 *
 * Trees and bushes share a 768px cell but are emphatically not the same size in
 * the world, so they are listed separately rather than derived from the cell.
 *
 * TREES AT 2.85 (ticket 010a). Measured on the palms, whose painted bbox is
 * 487x726 of their 768px cell: a crown 1.81 tiles across and 2.69 world units
 * tall — 1.75x a soldier's 1.539.
 *
 * THE BROADLEAVES SHARE IT, and that is a measurement rather than an
 * assumption. `tree1/2/3` — the canopy art, drawn on every fringe canopy tile —
 * is painted to nearly the same fraction of its cell as the palms, so at 2.85
 * those crowns stand 2.59, 2.60 and 2.79 world units tall against the palms'
 * 2.69: 1.68x to 1.81x a soldier, a spread narrow enough to read as one
 * treeline. Width varies more (1.94, 2.03 and 2.43 tiles against the palms'
 * 1.81): `tree3` is a deliberately broad crown, and since a tree is jittered up
 * to 0.42 tiles off its own tile it was always going to overhang its
 * neighbours. Overhang is what makes a canopy look continuous rather than
 * planted, so nothing here corrects for it.
 *
 * The palms keep the same height even though only the map's hand-placed `tree`
 * annotations draw them now. A landmark that is not to scale with the treeline
 * behind it reads as a mistake rather than as a landmark; its silhouette and
 * style are what make it stand out, and those are already different enough.
 *
 * The history is worth keeping, because both ends of it were wrong. 4.4 drew a
 * palm 2.8 tiles wide and 4.2 tall, and one per canopy tile was a plantation
 * that swamped the map and turned the soldiers into specks. 1.9 corrected that
 * but overshot: at 1.2 tiles the palms sat almost level with the figures and
 * the jungle lost its height. 2.85 is the owner's call between them — big
 * enough that the canopy has presence and a soldier reads as being *under* the
 * treeline, small enough that the figures stay the thing you watch.
 *
 * `bush` deliberately stays at 1.9: it is undergrowth, not canopy, and scaling
 * it with the trees would make shrubs the size of soldiers.
 */
const CELL_WORLD_HEIGHT: Readonly<Record<string, number>> = {
  soldier: 1.7,
  tree1: 2.85,
  tree2: 2.85,
  tree3: 2.85,
  palmtree1: 2.85,
  palmtree2: 2.85,
  palmtree3: 2.85,
  bush: 1.9,
  /**
   * ORDNANCE IN FLIGHT (ticket 053), and both are MEASURED off the art rather
   * than guessed at.
   *
   * The number is the whole 1024px CELL, and neither sprite fills its cell: the
   * grenade's painted bbox is 502x791 and the rocket's 929x884. So the figures
   * that matter — what a player actually sees against a soldier, whose painted
   * height is 1.54 world units — are:
   *
   *   grenade  0.58 x 791/1024 = 0.45 world, 29% of a soldier
   *   rocket   0.81 x 884/1024 = 0.70 world, 45% of a soldier
   *
   * NOT TO SCALE, DELIBERATELY. A real grenade beside a real man is a couple of
   * pixels at this zoom; the point of drawing the round at all is that the player
   * can follow the arc and see where it is going to land, and a faithful one
   * would be invisible. These are the Cannon Fodder proportions — a readable icon
   * that still reads as smaller than the man who threw it.
   *
   * The rocket is the bigger of the two because it is the bigger weapon, and
   * because its art is nearly square where the grenade's is tall: matching their
   * painted HEIGHTS would have drawn a rocket narrower than a grenade.
   */
  grenade: 0.58,
  rocket: 0.81,
}

/** Fallback for a source the table above does not name, so new art still draws. */
const DEFAULT_CELL_WORLD_HEIGHT = 2

/** The synthetic animation name every static prop answers to. */
export const STATIC_CLIP = 'static'

/** A prop has exactly one frame and holds it forever. */
const STATIC_ANIMATION: AnimationClip = { frameCount: 1, fps: 1, loop: false }

/**
 * The resting pose, SYNTHESISED HERE because the pipeline emits no such thing.
 *
 * `tools/spritegen` produces exactly three soldier animations — `walk`, `fire`
 * and `die` — so there is no idle art to load. Before this existed, a standing
 * soldier was drawn with `walk`, which loops: the whole squad jogged on the spot
 * whenever it was not going anywhere. That looked like a deliberate style choice
 * for as long as there was no simulation and therefore no soldier who was ever
 * NOT standing still.
 *
 * The derivation is `walk`'s first frame, held: same texels, same trim, same
 * anchor, so a man who stops does not change size or hop to a different pose —
 * he simply stops moving. It is built per DIRECTION, so a resting squad still
 * faces eight ways.
 *
 * Synthesised in the renderer rather than authored in the atlas on purpose: it
 * costs no texture area, it cannot drift from the walk cycle it is taken from,
 * and the day real idle art is drawn, the pipeline emits `idle` for real and
 * this derivation is skipped for any unit that already has one.
 */
export const IDLE_CLIP = 'idle'

/** One frame, held. `fps` is irrelevant to a single frame; 1 is the honest value. */
const IDLE_ANIMATION: AnimationClip = { frameCount: 1, fps: 1, loop: false }

/** The animation an idle pose is taken from, when the unit has no authored idle. */
const IDLE_SOURCE = 'walk'

/**
 * Animations that must NOT loop.
 *
 * The manifest declares `fps` but not looping, so the decision lives here. A
 * looping `die` resurrects corpses, which acceptance calls out by name.
 *
 * `fire` is NOT here, though it briefly was. Sustained fire is the model —
 * `core/session` plays the pose for as long as the fire order stands, not once
 * per round — and a one-shot clip would run its four frames and then freeze on
 * the last one for the rest of the burst. It loops, and the per-id phase offset
 * `EntityRenderer` gives looping clips is welcome here for the same reason it is
 * welcome on `walk`: a squad firing in perfect lockstep reads as one object.
 */
const ONE_SHOT_ANIMATIONS: ReadonlySet<string> = new Set(['die'])

/* ------------------------------------------------------------ implementation */

class AtlasUnitVisual implements UnitVisual {
  readonly texture: THREE.Texture

  /** Every frame pre-resolved at load: `unit|animation|direction|frame` -> quad + UVs. */
  private readonly frames = new Map<string, SpriteFrame>()
  private readonly clips = new Map<string, AnimationClip>()

  constructor(manifest: SpriteManifest, texture: THREE.Texture) {
    this.texture = texture

    const atlasW = manifest.atlas.width
    const atlasH = manifest.atlas.height
    if (!(atlasW > 0) || !(atlasH > 0)) {
      throw new SpriteAtlasError(
        'The sprite manifest does not describe a usable atlas.',
        `atlas ${String(atlasW)}x${String(atlasH)}`,
      )
    }

    for (const [unit, definition] of Object.entries(manifest.units)) {
      const perPixel = worldPerPixel(unit, definition.cell.height)
      for (const [animation, clip] of Object.entries(definition.animations)) {
        let frameCount = 0
        for (const [direction, dir] of Object.entries(clip.directions)) {
          frameCount = Math.max(frameCount, dir.frames.length)
          dir.frames.forEach((frame, index) => {
            this.frames.set(
              key(unit, animation, direction, index),
              resolve(frame, perPixel, atlasW, atlasH),
            )
          })
        }
        this.clips.set(`${unit}|${animation}`, {
          frameCount: Math.max(1, frameCount),
          fps: clip.fps,
          loop: !ONE_SHOT_ANIMATIONS.has(animation),
        })
      }

      // The resting pose. Skipped entirely if the pipeline ever emits a real
      // `idle` for this unit — the loop above will already have registered it,
      // and authored art beats a derivation.
      if (!this.clips.has(`${unit}|${IDLE_CLIP}`)) {
        const source = definition.animations[IDLE_SOURCE]
        if (source) {
          for (const direction of Object.keys(source.directions)) {
            const first = this.frames.get(key(unit, IDLE_SOURCE, direction, 0))
            if (first) this.frames.set(key(unit, IDLE_CLIP, direction, 0), first)
          }
          this.clips.set(`${unit}|${IDLE_CLIP}`, IDLE_ANIMATION)
        }
      }
    }

    for (const [prop, definition] of Object.entries(manifest.props)) {
      const perPixel = worldPerPixel(prop, definition.cell.height)
      this.frames.set(
        key(prop, STATIC_CLIP, STATIC_CLIP, 0),
        resolve(definition, perPixel, atlasW, atlasH),
      )
      this.clips.set(`${prop}|${STATIC_CLIP}`, STATIC_ANIMATION)
    }
  }

  clip(unit: string, animation: string): AnimationClip {
    return this.clips.get(`${unit}|${animation}`) ?? STATIC_ANIMATION
  }

  frame(unit: string, animation: string, direction: Facing, frame: number): SpriteFrame | null {
    // Three fallbacks, narrowest first:
    //   1. the exact frame asked for;
    //   2. frame 0 of the same clip — a HELD clip has only one, and a caller
    //      that computes its index from a stale `frameCount` would otherwise
    //      get a blank soldier, which is worse than a repeated one;
    //   3. the unit's static frame. Props are direction- and animation-
    //      agnostic; asking for `soldier`'s walk on a tree should still draw the
    //      tree rather than nothing at all.
    return (
      this.frames.get(key(unit, animation, direction, frame)) ??
      this.frames.get(key(unit, animation, direction, 0)) ??
      this.frames.get(key(unit, STATIC_CLIP, STATIC_CLIP, 0)) ??
      null
    )
  }

  dispose(): void {
    this.texture.dispose()
  }
}

function key(unit: string, animation: string, direction: string, frame: number): string {
  return `${unit}|${animation}|${direction}|${String(frame)}`
}

function worldPerPixel(source: string, cellHeightPx: number): number {
  const height = CELL_WORLD_HEIGHT[source] ?? DEFAULT_CELL_WORLD_HEIGHT
  return cellHeightPx > 0 ? height / cellHeightPx : 0
}

/**
 * Turn one manifest frame into a quad and a UV rect.
 *
 * The cell size is not needed here — it was already consumed by `perPixel`, and
 * `anchor` is expressed in cell pixels, so both offsets below come out relative
 * to the ground point directly.
 */
function resolve(
  frame: ManifestFrame,
  perPixel: number,
  atlasW: number,
  atlasH: number,
): SpriteFrame {
  const { rect, offset, anchor } = frame

  // Centre of the trimmed rect within the cell, relative to the anchor, y-down...
  const centreXPx = offset.x - anchor.x + rect.width / 2
  // ...and flipped to y-up for world space.
  const centreYPx = anchor.y - offset.y - rect.height / 2

  return {
    u0: rect.x / atlasW,
    // The flip. See the file header — this line is the whole of criterion
    // "the manifest's origin: top-left is honoured".
    v0: 1 - (rect.y + rect.height) / atlasH,
    du: rect.width / atlasW,
    dv: rect.height / atlasH,
    width: rect.width * perPixel,
    height: rect.height * perPixel,
    centreX: centreXPx * perPixel,
    centreY: centreYPx * perPixel,
  }
}

/* --------------------------------------------------------------- the loader */

/**
 * Resolve a filename declared in the manifest against the manifest's own URL.
 *
 * Shared with the ground-texture loader: that `atlas.file` and every
 * `ground.*.file` stay bare filenames is the manifest's business, not any
 * caller's.
 */
export function resolveAssetUrl(file: string, manifestUrl: string): string {
  return new URL(file, new URL(manifestUrl, window.location.href)).href
}

/**
 * Fetch and validate the sprite manifest.
 *
 * Split out from `loadSpriteAtlas` for ticket 009c: the manifest now describes
 * independent GPU resources — the packed atlas and the tileable ground
 * textures — and fetching it once per resource would put redundant round trips
 * in front of the first frame.
 *
 * `manifestUrl` is relative on purpose, like the level URL: `vite.config.ts`
 * sets `base: './'`, so the built page may be served from any path.
 */
export async function fetchSpriteManifest(manifestUrl: string): Promise<SpriteManifest> {
  let response: Response
  try {
    response = await fetch(manifestUrl)
  } catch (cause) {
    throw new SpriteAtlasError(
      `The browser failed to fetch ${manifestUrl}. If you opened the built files directly, serve them over HTTP instead.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }
  if (!response.ok) {
    throw new SpriteAtlasError(
      `The server answered ${String(response.status)} ${response.statusText} for ${manifestUrl}.`,
      'Expected public/generated/sprites/ to be published with the build — run `npm run build:models`.',
    )
  }

  let manifest: SpriteManifest
  try {
    manifest = (await response.json()) as SpriteManifest
  } catch (cause) {
    throw new SpriteAtlasError(
      `${manifestUrl} was served, but is not valid JSON.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  if (manifest.origin !== 'top-left') {
    // Not a crash: a manifest that changed its origin convention would render
    // every sprite mirrored, and a mirrored soldier is exactly the failure that
    // does not announce itself. Refuse it instead.
    throw new SpriteAtlasError(
      'The sprite manifest uses a coordinate origin this build does not understand.',
      `origin was ${String(manifest.origin)}, expected "top-left".`,
    )
  }

  return manifest
}

/** Load the packed atlas image named by an already-fetched manifest and build the visual. */
export async function buildSpriteAtlas(
  manifest: SpriteManifest,
  manifestUrl: string,
): Promise<UnitVisual> {
  const atlasUrl = resolveAssetUrl(manifest.atlas.file, manifestUrl)
  let texture: THREE.Texture
  try {
    texture = await new THREE.TextureLoader().loadAsync(atlasUrl)
  } catch (cause) {
    throw new SpriteAtlasError(
      `The sprite atlas image ${manifest.atlas.file} could not be loaded.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  configureAtlasTexture(texture)
  return createUnitVisual(manifest, texture)
}

/**
 * A `UnitVisual` over an already-loaded manifest and texture.
 *
 * Split out from `buildSpriteAtlas` so the clip and frame resolution can be
 * tested without a network fetch or a WebGL context — it is pure lookup over
 * the manifest, and it went untested for exactly as long as it was welded to
 * the two things that need a browser.
 */
export function createUnitVisual(manifest: SpriteManifest, texture: THREE.Texture): UnitVisual {
  return new AtlasUnitVisual(manifest, texture)
}

/**
 * Texture settings, each of which is a decision rather than a default.
 *
 * - `SRGBColorSpace`: the atlas is authored artwork, not data. Left as the
 *   default linear space every sprite renders washed out against the terrain,
 *   which is lit and therefore correct.
 * - `LinearFilter` for magnification: the source is painted art downscaled by
 *   `scale: 0.75`, not pixel art, and it is drawn at a non-integer on-screen
 *   size that changes with every zoom step. `NearestFilter` would crawl and
 *   stairstep along every edge. (Pixel-art sources would want the opposite.)
 * - `generateMipmaps` + `LinearMipmapLinearFilter` for minification. THE ATLAS
 *   IS BADLY UNDERSAMPLED AT MAXIMUM ZOOM-OUT and needs them. Measured against
 *   `maxSkyFreeViewHeight` on level 1 at 55 degrees — a soldier's 163-texel
 *   walk frame and a tree's 726-texel frame against their on-screen pixel
 *   heights:
 *
 *       viewport          soldier   minification    tree   minification
 *       1920x1080 @2x      105px        1.6x       285px       2.6x
 *       1920x1080 @1x       53px        3.1x       142px       5.1x
 *       1440x900  @1x       39px        4.1x       107px       6.8x
 *       1280x800  @1x       35px        4.6x        95px       7.7x
 *       1024x768  @1x       33px        5.0x        89px       8.2x
 *       800x600   @1x       26px        6.4x        69px      10.5x
 *
 *   A 2x2 bilinear kernel sampling a 5-10x reduction takes 4 texels out of 25
 *   to 100 and throws the rest away, which is not softness — it is aliasing,
 *   and aliasing that MOVES with the camera. Panning is this build's headline
 *   interaction, so the sprites would crawl and shimmer for the whole demo on
 *   any non-retina display. The trilinear chain samples the level whose texel
 *   density matches the screen, and blends across the boundary so a zoom step
 *   does not pop.
 *
 *   The bleed this replaces was a real objection, and it is answered in the
 *   packer rather than by giving up minification: `tools/spritegen` now leaves
 *   a 16px gap between rects with 8px of each sprite's own edge extruded into
 *   it, and rounds the atlas height to a multiple of 32 so the chain is an
 *   exact box halving. A mip level `L` averages aligned `2^L` blocks, so a
 *   boundary texel reaches `2^L - 1` past the rect: levels 0-3 stay inside that
 *   sprite's own extrusion, level 4 reaches only the NEIGHBOUR'S extruded edge
 *   (never its interior), and level 5 — the first that could mix in another
 *   sprite's pixels — needs 32x minification, three times the worst case in the
 *   table. The cost is 21.5 MB of atlas rather than 18.5 MB, plus a third again
 *   for the chain, and 5 KB of PNG payload (the gutter is transparent, so it
 *   deflates to nothing).
 *
 *   Known and accepted: mipping thins alpha, so a rifle barrel one texel wide
 *   fades toward `ALPHA_TEST` as it shrinks below a screen pixel. It fading is
 *   the correct answer at that size; the alternative is it flickering in and
 *   out as the camera moves.
 * - `ClampToEdgeWrapping`: nothing here tiles, and clamping means a UV that
 *   drifts a subpixel off a rect samples the padding rather than wrapping to
 *   the far side of the atlas.
 */
export function configureAtlasTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
}
