/**
 * Marker detection: annotated pixels -> categorised crosshair glyphs.
 *
 * Two passes over the image:
 *   1. one mask per legend colour, giving the *known* markers;
 *   2. one mask of "saturated colour that no legend entry claims", giving the
 *      *unknown* markers — reported by coordinate rather than silently dropped,
 *      because a marker the legend forgot is an authoring mistake worth seeing.
 */

import type { Cluster } from './clusters'
import { findClusters, isGlyph, isGlyphCandidate, suspiciousReason } from './clusters'
import type { Image, RGB } from './image'
import { colourMatches, formatColour } from './image'
import type { Legend, SpawnCategory } from './legend'

export interface DetectedMarker {
  readonly category: SpawnCategory
  readonly cx: number
  readonly cy: number
  readonly colour: RGB
}

/**
 * A glyph that was accepted but does not look like a *single* glyph — most
 * likely two markers that overlapped and merged into one component. Reported so
 * a silently-halved spawn count is impossible.
 */
export interface SuspiciousCluster {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pixels: number
  readonly colour: string
  readonly category: SpawnCategory
  readonly reason: string
}

/** How many glyphs each declared legend colour actually yielded. */
export interface MarkerColourCount {
  readonly colour: string
  readonly category: SpawnCategory
  readonly glyphs: number
  /** Clusters of this colour that failed the shape gate. */
  readonly discarded: number
}

export interface DiscardedCluster {
  /** True when this cluster carried enough ink to have been a lost marker. */
  readonly glyphCandidate: boolean
  /** Centroid of the discarded cluster, in pixels (rounded). */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pixels: number
  readonly colour: string
  /** The legend category the colour belongs to, or `'unknown'`. */
  readonly category: SpawnCategory | 'unknown'
  readonly reason: string
}

export interface UnknownMarker {
  readonly x: number
  readonly y: number
  readonly colour: string
}

export interface Detection {
  readonly markers: readonly DetectedMarker[]
  readonly discardedClusters: readonly DiscardedCluster[]
  readonly unknownMarkers: readonly UnknownMarker[]
  readonly suspiciousClusters: readonly SuspiciousCluster[]
  readonly colourCounts: readonly MarkerColourCount[]
  /**
   * `width * height` bytes, 1 wherever a pixel belongs to annotation ink.
   * Terrain and walkability exclude these, so the ink an artist drew *on top of*
   * the map cannot change the map underneath it.
   *
   * DELIBERATELY CONSERVATIVE — a pixel only enters this mask when the image
   * says so rather than when a heuristic suspects so:
   *   - every cluster in a DECLARED marker colour, glyph or text label or stray
   *     speck, because the legend states outright that this colour is paint;
   *   - a cluster in an *undeclared* colour only if it is glyph-shaped, i.e. a
   *     marker whose colour the legend forgot.
   * Undeclared, non-glyph clusters are NOT masked. The brightness/chroma gate
   * that finds them is a palette-tuned guess, and on the real asset it collects
   * far more jungle foliage than annotation (1751 terrain pixels against 1039 of
   * genuine ink). Masking those out deletes the brightest pixels of a tile, which
   * darkens its average and flips walkable tiles to blocked — editing the map in
   * the name of ignoring the annotation. They still produce warnings.
   */
  readonly inkMask: Uint8Array
}

/**
 * What counts as "an annotation colour someone forgot to declare": annotation
 * ink is drawn in saturated, bright colours precisely so it cannot be confused
 * with terrain. Jungle foliage — including the dark red flowers around
 * `178,64,0` that a sloppy detector mistakes for enemy markers — never reaches
 * this brightness *and* this chroma at once.
 *
 * ADVISORY ONLY, and palette-tuned. These thresholds decide what gets *reported*
 * as a possible undeclared annotation; they never decide what the terrain grid
 * says, because on the real asset they are wrong at scale (bright yellow-green
 * foliage highlight around `190,202,80` clears both gates). Only the clusters
 * that go on to pass the glyph shape gate reach the ink mask.
 */
const UNKNOWN_MIN_BRIGHTNESS = 200
const UNKNOWN_MIN_CHROMA = 120

/**
 * A pixel this close to a declared marker colour is treated as part of that
 * marker's anti-aliased fringe, not as an undeclared colour of its own —
 * otherwise every glyph would grow a halo of phantom "unknown markers".
 *
 * Kept deliberately narrow. A fringe pixel is the declared colour blended
 * towards the terrain behind it, so it is always *darker and less saturated*
 * than the pure ink and the brightness/chroma gates above already reject most
 * of it; this only has to absorb the near-pure outermost fringe. A wide halo is
 * actively harmful: at 120 an undeclared orange (255,165,0) crosshair sits
 * within 55 of the declared prop yellow and a cyan (0,255,255) within 95 of the
 * declared avatar blue, so both would be swallowed as "fringe" and never
 * reported — the exact silent drop this pass exists to prevent.
 *
 * Advisory, like the two thresholds above: it only widens or narrows what is
 * reported as undeclared.
 */
const KNOWN_COLOUR_HALO = 48

function chroma(colour: RGB): number {
  return Math.max(...colour) - Math.min(...colour)
}

function discard(
  cluster: Cluster,
  category: SpawnCategory | 'unknown',
  reason: string,
  glyphCandidate: boolean,
): DiscardedCluster {
  return {
    glyphCandidate,
    x: Math.round(cluster.cx),
    y: Math.round(cluster.cy),
    w: cluster.width,
    h: cluster.height,
    pixels: cluster.pixels,
    colour: formatColour(cluster.colour),
    category,
    reason,
  }
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
}

/**
 * Below this many detected glyphs the modal glyph size is not a meaningful
 * reference — with two clusters, one of them being a merged pair drags the
 * median halfway to the merged size and hides itself. The nominal size from the
 * legend still applies at any count.
 */
const MIN_GLYPHS_FOR_MODAL_SIZE = 3

export function detectMarkers(image: Image, legend: Legend): Detection {
  const markers: DetectedMarker[] = []
  const discardedClusters: DiscardedCluster[] = []
  const unknownMarkers: UnknownMarker[] = []
  const suspiciousClusters: SuspiciousCluster[] = []
  const colourCounts: MarkerColourCount[] = []
  const tolerance = legend.colourTolerance
  const shape = legend.glyph
  const inkMask = new Uint8Array(image.width * image.height)

  /** Accepted glyphs, kept alongside their cluster for the merge check below. */
  const accepted: { cluster: Cluster; category: SpawnCategory }[] = []

  /** Mark a component's pixels as annotation ink, hiding them from terrain. */
  const markInk = (cluster: Cluster): void => {
    for (const index of cluster.indices) inkMask[index] = 1
  }

  for (const { colour, category } of legend.markerColours) {
    const clusters = findClusters(image, (c) => colourMatches(c, colour, tolerance), tolerance)
    let glyphs = 0
    let discarded = 0
    for (const cluster of clusters) {
      // Declared colour: the legend says this colour is paint, so all of it is
      // ink whatever shape it took.
      markInk(cluster)
      if (isGlyph(cluster, shape)) {
        glyphs += 1
        accepted.push({ cluster, category })
        markers.push({ category, cx: cluster.cx, cy: cluster.cy, colour: cluster.colour })
      } else {
        discarded += 1
        discardedClusters.push(
          discard(
            cluster,
            category,
            'not crosshair-shaped (text label or stray ink)',
            isGlyphCandidate(cluster, shape),
          ),
        )
      }
    }
    colourCounts.push({ colour: formatColour(colour), category, glyphs, discarded })
  }

  // A glyph that carries two glyphs' worth of ink is two markers that touched,
  // and emitting one spawn for it would silently delete the other.
  const medianPixels =
    accepted.length >= MIN_GLYPHS_FOR_MODAL_SIZE
      ? median(accepted.map((a) => a.cluster.pixels))
      : undefined
  for (const { cluster, category } of accepted) {
    const reason = suspiciousReason(cluster, shape, medianPixels)
    if (reason === undefined) continue
    suspiciousClusters.push({
      x: Math.round(cluster.cx),
      y: Math.round(cluster.cy),
      w: cluster.width,
      h: cluster.height,
      pixels: cluster.pixels,
      colour: formatColour(cluster.colour),
      category,
      reason,
    })
  }

  const declared = legend.markerColours.map((m) => m.colour)
  const isUndeclaredAnnotation = (c: RGB): boolean => {
    if (Math.max(...c) < UNKNOWN_MIN_BRIGHTNESS) return false
    if (chroma(c) < UNKNOWN_MIN_CHROMA) return false
    return !declared.some((known) => colourMatches(c, known, Math.max(tolerance, KNOWN_COLOUR_HALO)))
  }

  for (const cluster of findClusters(image, isUndeclaredAnnotation, tolerance)) {
    if (isGlyph(cluster, shape)) {
      // A marker whose colour the legend forgot is still a marker drawn on top
      // of the map, so its ink comes out of the terrain average. Nothing else
      // from this pass does — see the note on `Detection.inkMask`.
      markInk(cluster)
      unknownMarkers.push({
        x: Math.round(cluster.cx),
        y: Math.round(cluster.cy),
        colour: formatColour(cluster.colour),
      })
    } else {
      discardedClusters.push(
        discard(
          cluster,
          'unknown',
          'undeclared colour, not crosshair-shaped',
          isGlyphCandidate(cluster, shape),
        ),
      )
    }
  }

  // Stable order: markers by position, so the generated JSON never depends on
  // which colour mask happened to be scanned first.
  markers.sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.category.localeCompare(b.category))
  discardedClusters.sort((a, b) => a.y - b.y || a.x - b.x || a.colour.localeCompare(b.colour))
  suspiciousClusters.sort((a, b) => a.y - b.y || a.x - b.x || a.colour.localeCompare(b.colour))

  return { markers, discardedClusters, unknownMarkers, suspiciousClusters, colourCounts, inkMask }
}
