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
} from './image'
import { packRects, type PackInput } from './pack'
import { cellAnchor, DIRECTIONS, sliceGrid, trimFrame, type Direction } from './slice'

export { DIRECTIONS, type Direction } from './slice'
export { SpritegenError } from './errors'
export { PackError } from './pack'

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
 * Default downscale factor for source art.
 *
 * The soldier stands ~1.5 world units tall. At the closest zoom the camera
 * reaches (viewHeight 10 over a ~1000px viewport) that is ~150 screen pixels,
 * against 217px of authored content — so full resolution is more texture than
 * the camera can ever show, at every zoom level. 0.75 lands the soldier at
 * ~163 texels: still above the worst-case screen size, so nothing is ever
 * magnified, while cutting atlas area to 56%. It is also a clean fraction of
 * the 480x240 cell (360x180), which keeps the anchor on an exact pixel.
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

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Vec2 {
  x: number
  y: number
}

export interface FrameEntry {
  /** Where the trimmed pixels live in the atlas. */
  rect: Rect
  /** Where those pixels sat inside the source cell — the un-trim. */
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

export interface SpriteManifest {
  version: number
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
}

export interface BuildResult {
  manifest: SpriteManifest
  atlasPath: string
  manifestPath: string
  floorPath: string
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
): { cell: { width: number; height: number }; frames: PendingImage[] } {
  const sheet = decodePngFile(path, `soldier ${anim} sheet`)
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
  return { cell: { width: cellW, height: cellH }, frames }
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

  // --- soldier animations -------------------------------------------------
  const animations = {} as Record<AnimationName, AnimationEntry>
  let unitCell = { width: 0, height: 0 }
  for (const anim of ANIMATIONS) {
    const path = join(sourceDir, 'soldier', `soldier-${anim}-sheet.png`)
    if (!existsSync(path)) {
      throw new SpritegenError(`soldier ${anim} sheet is missing: ${path}`)
    }
    const { cell, frames } = sliceSheet(path, anim, scale)
    unitCell = cell
    const directions = {} as Record<Direction, DirectionEntry>
    for (const d of DIRECTIONS) directions[d] = { frames: [] }
    animations[anim] = { fps: FPS[anim], directions }
    pending.push(...frames)
  }

  // --- props --------------------------------------------------------------
  for (const prop of PROPS) {
    const path = join(sourceDir, `${prop}.png`)
    if (!existsSync(path)) throw new SpritegenError(`prop is missing: ${path}`)
    const image = decodePngFile(path, `prop ${prop}`)
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

  for (const anim of ANIMATIONS) {
    for (const direction of DIRECTIONS) {
      const frames: FrameEntry[] = []
      for (let col = 0; col < SHEET_GRID.cols; col++) {
        const id = `soldier/${anim}/${direction}/${String(col)}`
        const src = byId.get(id)
        if (!src) throw new SpritegenError(`missing frame ${id}`)
        frames.push({ rect: take(id), offset: src.offset, anchor: src.anchor })
      }
      animations[anim].directions[direction] = { frames }
    }
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
    scale,
    atlas: { file: 'atlas.png', width: packed.width, height: packed.height, padding: PADDING },
    units: { soldier: { cell: unitCell, animations } },
    props,
    floor: { file: 'floor.png', width: floor.width, height: floor.height, tileable: true },
  }

  writeFileSync(atlasPath, encodePng(atlas))
  writeFileSync(floorPath, encodePng(floor))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return { manifest, atlasPath, manifestPath, floorPath }
}
