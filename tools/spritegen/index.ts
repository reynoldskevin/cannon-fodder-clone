/**
 * tools/spritegen — sprite sheets and prop art in, one packed atlas plus a
 * manifest out.
 *
 * Why an atlas and not voxels: the supplied sprites are drawn at the same 55°
 * angle as the camera, and the camera is locked (yaw 0, no rotation), so a
 * camera-aligned quad showing the sprite is pixel-exact from the only viewpoint
 * that exists. Rebuilding volume the artwork already depicts would look worse
 * and cost far more. The `UnitVisual` seam in ARCHITECTURE.md is what makes
 * that swap cheap.
 *
 * The game loads only `atlas.png`, `floor.png` and `sprites.manifest.json`; it
 * never slices a sheet at runtime.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpritegenError } from './errors'
import {
  blankImage,
  blit,
  cropImage,
  decodePngFile,
  encodePng,
  extrudeEdges,
  resampleRegion,
  stripLightMatte,
  type MatteDecision,
} from './image'
import { packRects, type PackInput } from './pack'
import { cellAnchor, DIRECTIONS, sliceGrid, trimFrame, type Direction } from './slice'

export { DIRECTIONS, type Direction } from './slice'
export { SpritegenError } from './errors'
export { PackError } from './pack'
export { type MatteDecision } from './image'

/** The three authored soldier animations, in a fixed order. */
export const ANIMATIONS = ['walk', 'fire', 'die'] as const
export type AnimationName = (typeof ANIMATIONS)[number]

/** The four props, in a fixed order. */
export const PROPS = ['tree1', 'tree2', 'tree3', 'bush'] as const
export type PropName = (typeof PROPS)[number]

/**
 * Playback rate per animation. Four frames each, so these are the whole timing
 * story: a walk cycle at 12fps is a third of a second per stride, `fire` reads
 * as a single snappy recoil, and `die` is deliberately slower so the fall
 * settles rather than snapping to the ground.
 */
const FPS: Record<AnimationName, number> = { walk: 12, fire: 12, die: 8 }

/** The authored sheet layout: 4 animation frames across, 8 facings down. */
const SHEET_GRID = { cols: 4, rows: 8 } as const

/**
 * Default downscale factor for source art — a deliberate quality/payload trade,
 * not a free lunch.
 *
 * The honest numbers. The soldier stands ~1.5 world units tall. The closest
 * zoom is `MIN_VIEW_HEIGHT = 10` world units (src/render/camera-rig.ts), so the
 * soldier occupies 15% of the viewport height. On a 1000 CSS-px-tall viewport
 * that is ~150 CSS px — but src/app/main.ts calls
 * `setPixelRatio(Math.min(devicePixelRatio, 2))`, so on any HiDPI display the
 * framebuffer is 2000 device px tall and the soldier is ~300 DEVICE pixels.
 * Against the 217px of authored content in a 480x240 cell, even scale 1.0 is
 * already ~1.38x magnified at closest zoom; at 0.75 the soldier is ~163 texels
 * and the magnification is ~1.85x.
 *
 * So this is not "nothing is ever magnified" — it is a decision to accept mild
 * softness at the extreme of the zoom range in exchange for atlas area at 56%
 * (4.27 MB shipped rather than ~7.6 MB). True 1:1 at max zoom on a 2x display
 * would need scale ~1.38, i.e. UPSCALING the source art, which buys no real
 * detail; the source itself is the ceiling. Anything above ~0.75 spends payload
 * on resampling artefacts rather than information.
 *
 * 0.75 is also a clean fraction of the 480x240 cell (360x180), which keeps the
 * anchor on an exact pixel.
 */
export const DEFAULT_SCALE = 0.75

/** Gap left between packed rects, and edge pixels repeated into that gap. */
const PADDING = 2
const EXTRUDE = 1

/**
 * The floor tile is halved to 512². It is tiled across the whole ground plane,
 * so its on-screen texel density is set by the tile size in world units rather
 * than by the sprite scale, and 512 is well past what the camera resolves at
 * any zoom. Must stay an integer divisor — see where it is used.
 */
const FLOOR_DIVISOR = 2

/** Hard atlas ceiling — the dimension every target GPU is guaranteed to allow. */
const MAX_ATLAS = 4096

/**
 * A rectangle in ATLAS PIXELS, origin TOP-LEFT, y increasing DOWNWARD — the
 * convention PNG itself uses, and the one `manifest.origin` states explicitly.
 *
 * This matters because Three.js texture UVs are bottom-left origin with v
 * increasing upward, so a consumer MUST flip:
 *
 *   u0 = rect.x / atlas.width
 *   u1 = (rect.x + rect.width) / atlas.width
 *   v0 = 1 - (rect.y + rect.height) / atlas.height   // bottom edge
 *   v1 = 1 - rect.y / atlas.height                   // top edge
 *
 * Forgetting the flip does not crash and does not look obviously broken — every
 * sprite simply comes out vertically mirrored — which is why it is written down
 * here and in the manifest rather than left to be inferred.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A 2D point, in the same top-left-origin, y-down pixel space as `Rect`. */
export interface Vec2 {
  x: number
  y: number
}

/**
 * One animation frame.
 *
 * To place it in world space, the consumer needs all four of `rect`, `offset`,
 * `anchor` and `UnitEntry.cell` (plus its own world-units-per-cell scale):
 *
 *   1. Size the quad `rect.width x rect.height` atlas pixels.
 *   2. Its top-left sits at `offset` within the cell — do NOT centre it on its
 *      own content, or the dying soldier slides back up the screen.
 *   3. `anchor` is the point of the CELL that meets the ground: bottom-centre,
 *      i.e. `(cell.width / 2, cell.height)`. The quad's offset from the unit's
 *      world position is therefore `(offset.x - anchor.x, offset.y - anchor.y)`
 *      in pixels, y-down.
 *   4. Multiply by world units per pixel — `unitHeightInWorldUnits /
 *      cell.height` — and negate y to go from y-down pixels to y-up world.
 *
 * `cell` is post-downscale, so the same number works for every animation of the
 * unit and no consumer needs to know `manifest.scale` to lay a sprite out.
 */
export interface FrameEntry {
  /** Where the trimmed pixels live in the atlas. Top-left origin, y-down. */
  rect: Rect
  /** Where those pixels sat inside the source cell — the un-trim. y-down. */
  offset: Vec2
  /** Bottom-centre of the source CELL. Constant across the animation. */
  anchor: Vec2
}

export interface DirectionEntry {
  frames: FrameEntry[]
}

export interface AnimationEntry {
  fps: number
  directions: Record<Direction, DirectionEntry>
}

export interface UnitEntry {
  /** Source cell size in atlas (post-downscale) pixels. */
  cell: { width: number; height: number }
  animations: Record<AnimationName, AnimationEntry>
}

export interface PropEntry {
  rect: Rect
  offset: Vec2
  anchor: Vec2
  cell: { width: number; height: number }
}

export interface FloorEntry {
  /** Emitted as its own texture — see `buildSprites`. */
  file: string
  width: number
  height: number
  tileable: true
}

/**
 * The coordinate origin every `Rect` and `Vec2` in the manifest is expressed
 * in. Stated as data, not just prose, so a consumer can assert on it and a
 * future change of convention cannot pass silently. See `Rect` for the UV flip
 * a bottom-left-origin renderer (i.e. Three.js) has to apply.
 */
export const MANIFEST_ORIGIN = 'top-left' as const

export interface SpriteManifest {
  version: number
  /**
   * Coordinate origin of every rect, offset and anchor below: pixels, top-left
   * origin, y increasing downward. Three.js UVs are bottom-left origin, so
   * `v = 1 - (y + height) / atlas.height`. See `Rect`.
   */
  origin: typeof MANIFEST_ORIGIN
  /** The downscale factor applied to all source art in the atlas. */
  scale: number
  atlas: { file: string; width: number; height: number; padding: number }
  units: { soldier: UnitEntry }
  props: Record<string, PropEntry>
  floor: FloorEntry
}

export interface BuildOptions {
  sourceDir: string
  outDir: string
  /** Downscale factor for atlas art; defaults to `DEFAULT_SCALE`. */
  scale?: number
  /**
   * Per-asset override of the light-matte heuristic, keyed by asset id
   * (`soldier/walk`, `soldier/fire`, `soldier/die`, `prop/tree1`, ...). `true`
   * forces the de-matte bleed, `false` forbids it; absent means let
   * `stripLightMatte` decide from the score.
   *
   * This exists so the heuristic's two known blind spots — a genuinely white
   * soft-edged sprite that would be flattened, an off-white matte that scores
   * below the threshold — are settled by a one-line entry here rather than by
   * retuning a detector that is currently correct on every supplied asset.
   */
  matte?: Partial<Record<string, boolean>>
}

export interface BuildResult {
  manifest: SpriteManifest
  atlasPath: string
  manifestPath: string
  floorPath: string
  /**
   * What the light-matte heuristic decided for each source image, in build
   * order. `build:models` prints these so the decision is never invisible.
   */
  matteDecisions: MatteDecision[]
}

interface PendingImage {
  id: string
  image: { width: number; height: number; data: Uint8Array }
  offset: Vec2
  anchor: Vec2
  cell: { width: number; height: number }
}

function scaled(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale))
}

/**
 * Slice, trim and downscale one soldier sheet.
 *
 * Downscaling happens per CELL, before trimming, so the box filter can never
 * average a neighbouring cell's pixels across a cell boundary, and so the trim
 * offsets come out as exact integers in atlas space rather than a rounded
 * version of a source-space box.
 */
function sliceSheet(
  path: string,
  anim: AnimationName,
  scale: number,
  matteOverride: boolean | undefined,
): {
  cell: { width: number; height: number }
  frames: PendingImage[]
  matte: MatteDecision
  sourceCell: { width: number; height: number }
} {
  // Before the downscale, so the box filter averages corrected colours rather
  // than spreading the matte further into the sprite.
  const { image: sheet, decision: matte } = stripLightMatte(
    `soldier/${anim}`,
    decodePngFile(path, `soldier ${anim} sheet`),
    matteOverride,
  )
  const cells = sliceGrid(sheet, SHEET_GRID)
  const cellW = scaled(sheet.width / SHEET_GRID.cols, scale)
  const cellH = scaled(sheet.height / SHEET_GRID.rows, scale)
  const anchor = cellAnchor({ width: cellW, height: cellH })

  const frames: PendingImage[] = []
  for (const cell of cells) {
    const direction = DIRECTIONS[cell.row]
    if (direction === undefined) {
      throw new SpritegenError(
        `soldier ${anim} sheet has row ${String(cell.row)} but only ` +
          `${String(DIRECTIONS.length)} directions are defined: ${path}`,
      )
    }
    const small = resampleRegion(sheet, cell, cellW, cellH)
    const trimmed = trimFrame(small, { originX: 0, originY: 0, width: cellW, height: cellH })
    if (trimmed.empty) {
      throw new SpritegenError(
        `soldier ${anim} sheet cell row ${String(cell.row)} col ${String(cell.col)} ` +
          `(${direction}) is empty — the sheet is not the expected ` +
          `${String(SHEET_GRID.cols)}x${String(SHEET_GRID.rows)} grid: ${path}`,
      )
    }
    frames.push({
      id: `soldier/${anim}/${direction}/${String(cell.col)}`,
      image: cropImage(small, {
        originX: trimmed.offsetX,
        originY: trimmed.offsetY,
        width: trimmed.width,
        height: trimmed.height,
      }),
      offset: { x: trimmed.offsetX, y: trimmed.offsetY },
      anchor,
      cell: { width: cellW, height: cellH },
    })
  }
  return {
    cell: { width: cellW, height: cellH },
    frames,
    matte,
    sourceCell: { width: sheet.width / SHEET_GRID.cols, height: sheet.height / SHEET_GRID.rows },
  }
}

/** Build the atlas + manifest. Every failure is a named `SpritegenError`. */
export function buildSprites(options: BuildOptions): BuildResult {
  const { sourceDir, outDir } = options
  const scale = options.scale ?? DEFAULT_SCALE
  if (!(scale > 0) || scale > 1) {
    throw new SpritegenError(`scale must be in (0, 1], got ${String(scale)}`)
  }
  if (!existsSync(sourceDir)) {
    throw new SpritegenError(`sprite source directory does not exist: ${sourceDir}`)
  }

  const pending: PendingImage[] = []
  const matteDecisions: MatteDecision[] = []

  // --- soldier animations -------------------------------------------------
  const fps = {} as Record<AnimationName, number>
  // The unit's cell size, established by the FIRST sheet and then required of
  // every other sheet.
  //
  // A single `cell` is published for the whole unit, and every consumer sizes
  // its quads and places its anchors from it — so a sheet that disagrees is not
  // a cosmetic mismatch, it silently mis-scales and mis-anchors an entire
  // animation. (A 1920x1440 `die` sheet still divides evenly by 4x8, so the
  // grid check below cannot catch it; it would simply overwrite `cell` with
  // 360x135 and shift every walk and fire anchor 45px off the ground.) Since
  // the frames themselves were trimmed against their own sheet's cell, there is
  // no correct single answer once they disagree — the only safe outcome is to
  // stop and name both sheets.
  let unitCell: { width: number; height: number } | null = null
  let unitCellFrom: { anim: AnimationName; source: { width: number; height: number } } | null = null
  for (const anim of ANIMATIONS) {
    const path = join(sourceDir, 'soldier', `soldier-${anim}-sheet.png`)
    if (!existsSync(path)) {
      throw new SpritegenError(`soldier ${anim} sheet is missing: ${path}`)
    }
    const { cell, frames, matte, sourceCell } = sliceSheet(path, anim, scale, options.matte?.[`soldier/${anim}`])
    if (unitCell === null || unitCellFrom === null) {
      unitCell = cell
      unitCellFrom = { anim, source: sourceCell }
    } else if (cell.width !== unitCell.width || cell.height !== unitCell.height) {
      const dim = (c: { width: number; height: number }) => `${String(c.width)}x${String(c.height)}`
      throw new SpritegenError(
        `soldier sheets disagree on cell size: the ${anim} sheet slices to ` +
          `${dim(sourceCell)} cells (${dim(cell)} at scale ${String(scale)}) but the ` +
          `${unitCellFrom.anim} sheet slices to ${dim(unitCellFrom.source)} ` +
          `(${dim(unitCell)}). Every animation of a unit shares one published cell, ` +
          `so mismatched sheets would silently mis-size and mis-anchor a whole ` +
          `animation. Re-export at a consistent sheet size: ${path}`,
      )
    }
    matteDecisions.push(matte)
    fps[anim] = FPS[anim]
    pending.push(...frames)
  }
  /* c8 ignore next 3 */
  if (unitCell === null) {
    throw new SpritegenError('no soldier animations are defined')
  }

  // --- props --------------------------------------------------------------
  for (const prop of PROPS) {
    const path = join(sourceDir, `${prop}.png`)
    if (!existsSync(path)) throw new SpritegenError(`prop is missing: ${path}`)
    const { image, decision } = stripLightMatte(
      `prop/${prop}`,
      decodePngFile(path, `prop ${prop}`),
      options.matte?.[`prop/${prop}`],
    )
    matteDecisions.push(decision)
    const dstW = scaled(image.width, scale)
    const dstH = scaled(image.height, scale)
    const small = resampleRegion(
      image,
      { originX: 0, originY: 0, width: image.width, height: image.height },
      dstW,
      dstH,
    )
    const trimmed = trimFrame(small, { originX: 0, originY: 0, width: dstW, height: dstH })
    if (trimmed.empty) throw new SpritegenError(`prop ${prop} has no opaque pixels: ${path}`)
    pending.push({
      id: `prop/${prop}`,
      image: cropImage(small, {
        originX: trimmed.offsetX,
        originY: trimmed.offsetY,
        width: trimmed.width,
        height: trimmed.height,
      }),
      offset: { x: trimmed.offsetX, y: trimmed.offsetY },
      anchor: cellAnchor({ width: dstW, height: dstH }),
      cell: { width: dstW, height: dstH },
    })
  }

  // --- pack ---------------------------------------------------------------
  const inputs: PackInput[] = pending.map((p) => ({
    id: p.id,
    width: p.image.width,
    height: p.image.height,
  }))
  const packed = packRects(inputs, { maxSize: MAX_ATLAS, padding: PADDING })
  if (packed.placements.length !== pending.length) {
    throw new SpritegenError(
      `packer placed ${String(packed.placements.length)} of ${String(pending.length)} frames`,
    )
  }

  const atlas = blankImage(packed.width, packed.height)
  const byId = new Map(pending.map((p) => [p.id, p]))
  // Sorted so the atlas bytes depend only on the placements, never on the order
  // the packer happened to return them in.
  const placements = [...packed.placements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rectById = new Map<string, Rect>()
  for (const p of placements) {
    const src = byId.get(p.id)
    if (!src) throw new SpritegenError(`packer invented a frame id: ${p.id}`)
    blit(atlas, src.image, p.x, p.y)
    extrudeEdges(atlas, p, EXTRUDE)
    rectById.set(p.id, { x: p.x, y: p.y, width: p.width, height: p.height })
  }

  // --- manifest -----------------------------------------------------------
  const take = (id: string): Rect => {
    const rect = rectById.get(id)
    if (!rect) throw new SpritegenError(`no atlas rect for ${id}`)
    return rect
  }

  // Every direction of every animation is built here, from the frames that were
  // actually packed. There is no pre-seeded empty entry to fall back on: a
  // direction that produced no frames is a bug in slicing, and it throws below
  // rather than reaching the manifest as an empty list a consumer would render
  // as an invisible soldier.
  const animations = {} as Record<AnimationName, AnimationEntry>
  for (const anim of ANIMATIONS) {
    const directions = {} as Record<Direction, DirectionEntry>
    for (const direction of DIRECTIONS) {
      const frames: FrameEntry[] = []
      for (let col = 0; col < SHEET_GRID.cols; col++) {
        const id = `soldier/${anim}/${direction}/${String(col)}`
        const src = byId.get(id)
        if (!src) throw new SpritegenError(`missing frame ${id}`)
        frames.push({ rect: take(id), offset: src.offset, anchor: src.anchor })
      }
      directions[direction] = { frames }
    }
    animations[anim] = { fps: fps[anim], directions }
  }

  const props: Record<string, PropEntry> = {}
  for (const prop of PROPS) {
    const src = byId.get(`prop/${prop}`)
    if (!src) throw new SpritegenError(`missing prop ${prop}`)
    props[prop] = {
      rect: take(`prop/${prop}`),
      offset: src.offset,
      anchor: src.anchor,
      cell: src.cell,
    }
  }

  // --- floor --------------------------------------------------------------
  // The floor tile stays OUT of the atlas and is emitted as its own texture.
  // It is the one texture that needs GPU wrapping, and wrapping is a property
  // of the whole texture, not of a sub-rect: packed into the atlas its edges
  // would sample the neighbouring sprite instead of its own opposite edge, and
  // the seams would be visible across the entire ground plane.
  const floorSource = join(sourceDir, 'floor-jungle.png')
  if (!existsSync(floorSource)) {
    throw new SpritegenError(`floor tile is missing: ${floorSource}`)
  }
  const floorFull = decodePngFile(floorSource, 'floor tile')
  // Its downscale is an INTEGER divisor, unlike the sprites': averaging exact
  // NxN blocks of a tileable image leaves it tileable, whereas a fractional box
  // straddles the wrap boundary and leaves a seam down every tile edge.
  if (floorFull.width % FLOOR_DIVISOR !== 0 || floorFull.height % FLOOR_DIVISOR !== 0) {
    throw new SpritegenError(
      `floor tile ${String(floorFull.width)}x${String(floorFull.height)} is not divisible by ` +
        `${String(FLOOR_DIVISOR)}, so downscaling it would break tiling: ${floorSource}`,
    )
  }
  const floor = resampleRegion(
    floorFull,
    { originX: 0, originY: 0, width: floorFull.width, height: floorFull.height },
    floorFull.width / FLOOR_DIVISOR,
    floorFull.height / FLOOR_DIVISOR,
  )

  // --- write --------------------------------------------------------------
  mkdirSync(outDir, { recursive: true })
  const atlasPath = join(outDir, 'atlas.png')
  const floorPath = join(outDir, 'floor.png')
  const manifestPath = join(outDir, 'sprites.manifest.json')

  const manifest: SpriteManifest = {
    version: 1,
    origin: MANIFEST_ORIGIN,
    scale,
    atlas: { file: 'atlas.png', width: packed.width, height: packed.height, padding: PADDING },
    units: { soldier: { cell: unitCell, animations } },
    props,
    floor: { file: 'floor.png', width: floor.width, height: floor.height, tileable: true },
  }

  writeFileSync(atlasPath, encodePng(atlas))
  writeFileSync(floorPath, encodePng(floor))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return { manifest, atlasPath, manifestPath, floorPath, matteDecisions }
}
