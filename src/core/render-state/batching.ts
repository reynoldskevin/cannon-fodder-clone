/**
 * Instanced batching (ticket 010) — grouping what is about to be drawn.
 *
 * ARCHITECTURE.md requires a full squad plus dozens of enemies in a handful of
 * draw calls, not one per entity. Everything sharing a
 * (unit, animation, direction, frame) samples the same atlas rect, so it can be
 * a single instanced draw whose only per-instance data is a transform.
 *
 * The cost model this buys: draw calls are bounded by the ATLAS (how many
 * distinct rects exist) rather than by the entity count. Thirty more enemies
 * add instances, not draws.
 */

/** One thing to draw this frame, reduced to what batching cares about. */
export interface DrawItem {
  /** Stable entity id — used only to keep items identifiable, never in the key. */
  readonly id: number
  /** Logical sprite source: `'soldier'`, `'tree1'`, ... */
  readonly unit: string
  /** Animation name within that source: `'walk'`, `'die'`, ... */
  readonly animation: string
  /** One of the eight compass facings. */
  readonly direction: string
  /** Frame index within the animation. */
  readonly frame: number
  readonly x: number
  readonly z: number
}

/** A group of items that share an atlas rect, and therefore one instanced draw. */
export interface Batch<T extends DrawItem = DrawItem> {
  readonly key: string
  readonly items: readonly T[]
}

/**
 * The identity of the atlas rect an item needs.
 *
 * Position and id are deliberately absent: they are per-instance data, and
 * including either would put every entity in its own batch — the exact failure
 * this module exists to prevent.
 */
export function batchKey(item: DrawItem): string {
  return `${item.unit}|${item.animation}|${item.direction}|${String(item.frame)}`
}

/**
 * Group items into one batch per distinct atlas rect.
 *
 * Generic in the item type so the renderer can carry richer per-instance data
 * (ground height, tint) through batching without this module knowing about it,
 * and without a cast on the way out.
 *
 * ORDERING IS DETERMINISTIC — batches come back sorted by key, not in
 * first-seen order. Insertion order depends on the entity list, which changes
 * as units spawn and die; sorting means the same set of entities produces the
 * same sequence of draws every frame, so the instanced-mesh pool is reused
 * rather than reshuffled, and blending order does not flicker frame to frame.
 *
 * SLOT RELEASE is the absence of a mechanism: batches describe exactly the
 * items passed in, so an entity that despawned simply is not there. Nothing
 * retains it, so nothing can leak it.
 */
export function groupIntoBatches<T extends DrawItem>(items: readonly T[]): Batch<T>[] {
  const byKey = new Map<string, T[]>()

  for (const item of items) {
    const key = batchKey(item)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(item)
    else byKey.set(key, [item])
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, bucketItems]) => ({ key, items: bucketItems }))
}
