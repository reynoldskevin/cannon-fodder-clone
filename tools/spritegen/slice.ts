/**
 * Slicing a sprite sheet into frames.
 *
 * The load-bearing rule: a frame is trimmed to its content box to save atlas
 * space, but it is NEVER re-centred on that content. The `die` animation's
 * content shrinks from 199px to 110px tall as the soldier falls; re-centring
 * each frame would slide the body back up the screen as it died. Instead the
 * anchor is the bottom-centre of the SOURCE CELL — identical for every frame of
 * every animation — and the trim offset records where the content sat inside
 * that cell, so playback reconstructs the original position exactly.
 */

import { SpritegenError } from './errors'

/** An 8-bit RGBA image, row-major, `width * height * 4` bytes. */
export interface RgbaImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** The eight facing directions, clockwise from north — one per sheet row. */
export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

export type Direction = (typeof DIRECTIONS)[number]

export interface GridSpec {
  /** Animation frames across the sheet. */
  readonly cols: number
  /** Facing directions down the sheet. */
  readonly rows: number
}

/** One cell of the grid, located in sheet pixels. */
export interface Cell {
  readonly row: number
  readonly col: number
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/** The content box of a cell, expressed as an offset within that cell. */
export interface TrimmedFrame {
  readonly offsetX: number
  readonly offsetY: number
  readonly width: number
  readonly height: number
  /** True when the cell held no pixel with alpha > 0 at all. */
  readonly empty: boolean
}

/**
 * Split a sheet into `rows * cols` cells, indexed row-major (row 0 first, and
 * within a row, column 0 first) so `cells[row * cols + col]` holds.
 *
 * A grid that does not divide the sheet evenly is a mis-specified asset, not a
 * rounding problem: fail rather than emit silently clipped frames.
 */
export function sliceGrid(image: RgbaImage, grid: GridSpec): Cell[] {
  const { cols, rows } = grid
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new SpritegenError(
      `grid must be positive whole numbers of cells, got ${String(cols)}x${String(rows)}`,
    )
  }
  if (image.width % cols !== 0 || image.height % rows !== 0) {
    throw new SpritegenError(
      `sheet ${String(image.width)}x${String(image.height)} does not divide evenly into a ` +
        `${String(cols)}x${String(rows)} grid`,
    )
  }

  const cellWidth = image.width / cols
  const cellHeight = image.height / rows
  const cells: Cell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        row,
        col,
        originX: col * cellWidth,
        originY: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      })
    }
  }
  return cells
}

/** The rectangle of a cell within its sheet. */
export interface CellRect {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/**
 * Find the content box of a cell.
 *
 * Any pixel with alpha > 0 is content. 8–14% of the supplied sprites' content
 * pixels are semi-transparent antialiased edges; thresholding those away would
 * clip the outline by a pixel all round and leave the silhouette looking
 * chewed.
 */
export function trimFrame(image: RgbaImage, cell: CellRect): TrimmedFrame {
  let minX = cell.width
  let minY = cell.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < cell.height; y++) {
    const rowStart = ((cell.originY + y) * image.width + cell.originX) * 4
    for (let x = 0; x < cell.width; x++) {
      if ((image.data[rowStart + x * 4 + 3] ?? 0) === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) {
    return { offsetX: 0, offsetY: 0, width: 0, height: 0, empty: true }
  }
  return {
    offsetX: minX,
    offsetY: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    empty: false,
  }
}

/**
 * The anchor of a cell: bottom-centre of the CELL, not of the content.
 *
 * Constant for every frame of an animation, which is precisely why a walking or
 * dying soldier neither slides nor jitters.
 */
export function cellAnchor(cell: { readonly width: number; readonly height: number }): {
  x: number
  y: number
} {
  return { x: cell.width / 2, y: cell.height }
}
