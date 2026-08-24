/**
 * PNG decoding for the importer.
 *
 * Decoding is delegated to `pngjs` (a devDependency — nothing here ships to the
 * browser): the game never parses an image at runtime, so a robust offline
 * decoder is strictly better than a hand-rolled one that only understands the
 * one filter mode our current assets happen to use.
 */

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { MapgenError } from './errors'

/** An 8-bit RGB image. Alpha, if the source had any, is discarded. */
export interface Image {
  readonly width: number
  readonly height: number
  /** `width * height * 3` bytes, row-major. */
  readonly rgb: Uint8Array
}

export type RGB = readonly [number, number, number]

/** Chebyshev (max per-channel) distance — see `colourMatches`. */
export function colourDistance(a: RGB, b: RGB): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  )
}

/**
 * Colour comparison is per-channel (Chebyshev), not Euclidean, and that choice
 * matters: the jungle terrain contains dark red foliage around `178,64,0`, which
 * is only ~77 away from the `255,60,60` enemy marker in its red channel but much
 * closer in Euclidean terms once the other channels are averaged in. Requiring
 * *every* channel to be within tolerance keeps terrain out of the marker mask
 * while still absorbing the anti-aliased fringe of a real annotation.
 */
export function colourMatches(a: RGB, b: RGB, tolerance: number): boolean {
  return colourDistance(a, b) <= tolerance
}

export function pixelAt(image: Image, x: number, y: number): RGB {
  const i = (y * image.width + x) * 3
  return [image.rgb[i] ?? 0, image.rgb[i + 1] ?? 0, image.rgb[i + 2] ?? 0]
}

/** Rec. 601 luma — the brightness used by the walkability heuristic. */
export function luminance(colour: RGB): number {
  return 0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2]
}

/** `"r,g,b"` — the canonical textual form used in legends and reports. */
export function formatColour(colour: RGB): string {
  return `${String(colour[0])},${String(colour[1])},${String(colour[2])}`
}

export function decodePngFile(path: string, what: string): Image {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (cause) {
    throw new MapgenError(`${what} could not be read: ${path}`, { cause })
  }

  let png: PNG
  try {
    png = PNG.sync.read(raw)
  } catch (cause) {
    throw new MapgenError(`${what} is not a readable PNG: ${path}`, { cause })
  }

  const { width, height, data } = png
  if (width <= 0 || height <= 0) {
    throw new MapgenError(`${what} has zero extent (${String(width)}x${String(height)}): ${path}`)
  }

  // pngjs always normalises to 8-bit RGBA; drop alpha.
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
    rgb[o] = data[i] ?? 0
    rgb[o + 1] = data[i + 1] ?? 0
    rgb[o + 2] = data[i + 2] ?? 0
  }
  return { width, height, rgb }
}
