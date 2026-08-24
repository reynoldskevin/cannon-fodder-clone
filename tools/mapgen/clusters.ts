/**
 * Connected-component analysis over an annotation mask, and the geometric rule
 * that separates a crosshair *glyph* from the text *label* drawn beside it.
 *
 * The annotation convention (see `.claude/tickets/003-mapgen.md`) draws each
 * marker as a ~25x25 crosshair with a word of text to its right, in the same
 * colour. Telling them apart is purely geometric — a crosshair is a near-square
 * cluster about a tile and a half across; a text label is wide and only ~7-8
 * pixels tall, and its individual letters are far too small. Deliberately NO
 * OCR: the label text is anti-aliased over noisy terrain and is not reliably
 * readable, so a marker's identity comes from `legend.json`, never the pixels.
 */

import type { Image, RGB } from './image'
import { colourMatches, pixelAt } from './image'
import type { GlyphShape } from './legend'

export interface Cluster {
  /** Number of pixels in the component. */
  readonly pixels: number
  /** Centroid, in pixels. */
  readonly cx: number
  readonly cy: number
  readonly width: number
  readonly height: number
  /** Mean colour of the component, rounded per channel. */
  readonly colour: RGB
  /**
   * Flat `y * width + x` index of every pixel in the component.
   *
   * Carried on the cluster rather than accumulated into a mask inside
   * `findClusters`, because whether a component's pixels count as annotation ink
   * is a question only the caller can answer: ink from a declared marker colour
   * always does, while a component in some *undeclared* colour is only ink if it
   * is glyph-shaped — otherwise it is terrain that happens to be bright, and
   * masking it out would edit the map instead of the annotation.
   */
  readonly indices: readonly number[]
}

/**
 * How much larger than the legend's nominal glyph a cluster may be before it is
 * *suspicious* — big enough to be two overlapping glyphs that merged into one
 * component rather than a single annotation.
 *
 * Measured on the real asset every crosshair is exactly 25x25 (77-85 px), so
 * 1.2x is far outside the observed spread of a single glyph.
 *
 * MEASURED DETECTION BOUNDS for two merged 25x25 crosshairs, horizontally or
 * vertically offset:
 *   - separation >= 6px: caught by this side ratio (the merged bounding box is
 *     31px+ against a 30px trigger);
 *   - separation 1-5px: NOT detected, with 2 glyphs or with 5. Two crosshairs a
 *     few pixels apart share almost all of their ink, so the merged component is
 *     barely larger and barely heavier than one glyph and the 1.6x modal-ink rule
 *     does not rescue it either. This is a known limit, and a bounded one: at
 *     `tileSize` 16 two markers within 5px of each other land in the same tile,
 *     so the lost spawn would have been a duplicate of the survivor's position.
 *   - separation >= 16px: the merged box exceeds `maxSide`, so the cluster never
 *     becomes a glyph at all and is reported through the discarded-cluster path.
 */
const SUSPICIOUS_SIDE_RATIO = 1.2
/** Same idea by area: a merged pair carries about twice a glyph's ink. */
const SUSPICIOUS_PIXEL_RATIO = 1.6

/**
 * Find 8-connected components of pixels that both satisfy `inMask` and stay
 * within `tolerance` of the colour of the pixel the component started from.
 *
 * Seeding the colour per component (rather than only using a global mask) means
 * two differently-coloured annotations that happen to touch stay separate
 * clusters, and an anti-aliased fringe still joins the glyph it belongs to.
 *
 * Components are discovered in raster order, which is what makes every downstream
 * report and the generated JSON deterministic.
 */
export function findClusters(
  image: Image,
  inMask: (colour: RGB, x: number, y: number) => boolean,
  tolerance: number,
): Cluster[] {
  const { width, height } = image
  const visited = new Uint8Array(width * height)
  const clusters: Cluster[] = []
  const stack: number[] = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seedIndex = y * width + x
      if (visited[seedIndex] === 1) continue
      const seedColour = pixelAt(image, x, y)
      if (!inMask(seedColour, x, y)) continue

      visited[seedIndex] = 1
      stack.push(seedIndex)

      const indices: number[] = []
      let pixels = 0
      let sumX = 0
      let sumY = 0
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y

      while (stack.length > 0) {
        const index = stack.pop() as number
        const px = index % width
        const py = (index - px) / width
        const colour = pixelAt(image, px, py)
        indices.push(index)

        pixels += 1
        sumX += px
        sumY += py
        sumR += colour[0]
        sumG += colour[1]
        sumB += colour[2]
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const nx = px + dx
            const ny = py + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            const nIndex = ny * width + nx
            if (visited[nIndex] === 1) continue
            const nColour = pixelAt(image, nx, ny)
            if (!inMask(nColour, nx, ny)) continue
            if (!colourMatches(nColour, seedColour, tolerance)) continue
            visited[nIndex] = 1
            stack.push(nIndex)
          }
        }
      }

      clusters.push({
        pixels,
        cx: sumX / pixels,
        cy: sumY / pixels,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        colour: [
          Math.round(sumR / pixels),
          Math.round(sumG / pixels),
          Math.round(sumB / pixels),
        ],
        indices,
      })
    }
  }
  return clusters
}

/** True for a cluster shaped like a crosshair glyph rather than a text label. */
export function isGlyph(cluster: Cluster, shape: GlyphShape): boolean {
  const { width, height, pixels } = cluster
  if (width < shape.minSide || height < shape.minSide) return false
  if (width > shape.maxSide || height > shape.maxSide) return false
  if (Math.min(width, height) / Math.max(width, height) < shape.minSquareness) return false
  return pixels >= shape.minPixels && pixels <= shape.maxPixels
}

/**
 * Could this discarded cluster plausibly have been a *marker* someone lost, as
 * opposed to the text ink drawn beside one?
 *
 * A glyph's worth of ink that failed the shape gate is a spawn that vanished —
 * a merged glyph-plus-label, an oversized crosshair — and must be reported
 * individually. The dozens of 1x8 letter strokes around every label are not, and
 * drowning the real signal in them would make the report useless; they are still
 * counted and still carried in `report.discardedClusters`.
 */
export function isGlyphCandidate(cluster: Cluster, shape: GlyphShape): boolean {
  return (
    cluster.pixels >= shape.minPixels ||
    (cluster.width >= shape.minSide && cluster.height >= shape.minSide)
  )
}

/**
 * Why an accepted glyph looks like more than one glyph, or `undefined` if it
 * looks normal.
 *
 * Two same-colour crosshairs drawn close enough to touch become ONE 8-connected
 * component whose bounding box and ink are both roughly doubled, and whose
 * centroid is between the two — it still passes the squareness and max-side
 * gates, so without this check one of the two spawns disappears and the survivor
 * lands at a position that matches neither.
 *
 * `medianPixels` is the modal ink of the glyphs detected in this image, when
 * there are enough of them to be meaningful; `shape.side` is the nominal glyph
 * size from the legend and works even when the merged cluster is the only one.
 */
export function suspiciousReason(
  cluster: Cluster,
  shape: GlyphShape,
  medianPixels: number | undefined,
): string | undefined {
  const maxSide = Math.max(cluster.width, cluster.height)
  if (maxSide > shape.side * SUSPICIOUS_SIDE_RATIO) {
    return `bounding box ${String(cluster.width)}x${String(cluster.height)} is much larger than the ${String(
      shape.side,
    )}px nominal glyph`
  }
  if (medianPixels !== undefined && cluster.pixels >= medianPixels * SUSPICIOUS_PIXEL_RATIO) {
    return `${String(cluster.pixels)} ink pixels is a near-multiple of the ${String(
      medianPixels,
    )}px typical glyph`
  }
  return undefined
}
