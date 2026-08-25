/**
 * The flow-field cache (ticket 006).
 *
 * `ARCHITECTURE.md` picked flow fields on the argument that one sweep serves a
 * whole squad — "mitigated by caching a small number of concurrent fields". This
 * is that mitigation, so it is not an optimisation bolted on afterwards: without
 * it the design's cost argument is simply false, because a field per unit per
 * tick is more work than the per-unit A* it replaced.
 *
 * Two correctness hazards, both worse than a slow game:
 *
 *   - A FIELD THAT OUTLIVES ITS MAP routes units through a bridge that has since
 *     been blown. Fields are therefore validated against `NavGrid.version` and
 *     dropped wholesale the moment it moves. Wholesale, not per entry: a
 *     passability change anywhere can invalidate any field (a single opened door
 *     re-routes the whole map), so there is no such thing as a field that
 *     survives a bump.
 *   - AN UNBOUNDED CACHE grows one field per distinct destination ever ordered.
 *     A player clicking around for five minutes would accumulate thousands of
 *     full-map sweeps' worth of typed arrays and never release one.
 *
 * LRU rather than FIFO because destinations are re-ordered, not streamed: a
 * squad told to hold a position asks for that same field every tick, and an
 * age-based policy would evict the field in active use in favour of one asked
 * for once.
 */

import type { NavGrid, TraversalMask } from './navgrid'
import { computeFlowField } from './flowfield'
import type { FlowField, GridPoint } from './flowfield'

/**
 * How many fields may live at once.
 *
 * Sized against what a mission actually asks for rather than against memory: a
 * player squad and the enemy groups on screen have on the order of a handful of
 * distinct destinations at a time, and 16 leaves room for the churn of a player
 * re-ordering mid-move without ever evicting a field still being followed.
 */
export const DEFAULT_FIELD_CAPACITY = 16

/** Hit/miss/eviction counters. A snapshot: reading `stats` twice yields two objects. */
export interface FlowFieldCacheStats {
  readonly hits: number
  readonly misses: number
  readonly evictions: number
}

/** A bounded, version-validated store of flow fields. */
export interface FlowFieldCache {
  /** The field for this destination and traversal mask, computing it if needed. */
  get(grid: NavGrid, target: GridPoint, mask: TraversalMask): FlowField
  /** How many fields are resident. */
  readonly size: number
  /** The most fields that may be resident at once. */
  readonly capacity: number
  /** Cumulative counters, never reset by `clear`. */
  readonly stats: FlowFieldCacheStats
  /** Drop every field. Cheaper than waiting for eviction when a mission ends. */
  clear(): void
}

/** Mutable twin of `FlowFieldCacheStats`, kept private to this module. */
interface MutableStats {
  hits: number
  misses: number
  evictions: number
}

/**
 * Create a cache.
 *
 * A non-positive or non-finite capacity falls back to the default rather than
 * being honoured: a capacity of 0 is a cache that misses forever while still
 * paying for the bookkeeping, which is a performance cliff nobody would look for
 * and every caller would rather have loudly ignored.
 */
export function createFlowFieldCache(capacity: number = DEFAULT_FIELD_CAPACITY): FlowFieldCache {
  const limit = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : DEFAULT_FIELD_CAPACITY

  // A `Map` is the LRU list: insertion order is specified, so re-inserting on a
  // hit moves an entry to the back and the oldest key is simply the first one
  // iteration yields. That is a doubly-linked list plus a hash map, already
  // written and already correct.
  const entries = new Map<string, FlowField>()
  const stats: MutableStats = { hits: 0, misses: 0, evictions: 0 }

  // The world shape every resident field was solved against. `null` until the
  // first request, which no real version can equal, so the first `get` simply
  // adopts whatever grid it is handed.
  let grid: NavGrid | null = null
  let gridVersion = -1

  /**
   * Destination plus traversal mask — the two things that make a field
   * different. A string key rather than nested maps: one hash per lookup, and
   * the coordinates stay readable in a debugger.
   *
   * FLOORED, matching `computeFlowField`. A field is solved for a tile, so two
   * requests inside the same tile are one field and must share a slot. Keyed on
   * the raw floats they would not: ticket 008 picks destinations by raycasting
   * the ground plane, so near-identical but never-equal numbers arrive
   * constantly, every one a miss and a fresh whole-map sweep. The cache would
   * still report a size and a capacity while doing nothing whatsoever.
   */
  const keyFor = (target: GridPoint, mask: TraversalMask): string =>
    `${String(Math.floor(target.x))},${String(Math.floor(target.y))},${String(mask)}`

  return {
    get capacity(): number {
      return limit
    },
    get size(): number {
      return entries.size
    },
    /**
     * A copy, not the live counters. `readonly` on the interface is a
     * compile-time claim only, so handing out the mutable object lets any
     * caller — or any plain JS consumer, where the claim does not exist at
     * all — write to the numbers that are supposed to be measuring it.
     */
    get stats(): FlowFieldCacheStats {
      return { hits: stats.hits, misses: stats.misses, evictions: stats.evictions }
    },
    get(next: NavGrid, target: GridPoint, mask: TraversalMask): FlowField {
      // Identity as well as version: two grids can legitimately share a version
      // (both freshly baked, both at 0), and serving one grid's field for the
      // other's destination is precisely the "field outlived its map" failure.
      if (next !== grid || next.version !== gridVersion) {
        entries.clear()
        grid = next
        gridVersion = next.version
      }

      const key = keyFor(target, mask)
      const cached = entries.get(key)
      if (cached !== undefined) {
        stats.hits += 1
        // Re-insert to mark it most-recently-used.
        entries.delete(key)
        entries.set(key, cached)
        return cached
      }

      stats.misses += 1
      const field = computeFlowField(next, target, mask)
      entries.set(key, field)

      // A loop, not an `if`: a capacity lowered between calls (or several
      // entries added by a future batch API) must still leave the cache within
      // bounds rather than one over it.
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
        stats.evictions += 1
      }
      return field
    },
    clear(): void {
      // Counters survive: they measure the cache's behaviour across the mission,
      // and a mid-mission clear resetting them would hide the churn that made it
      // necessary. Evictions are not incremented either — a deliberate drop is
      // not cache pressure, and conflating the two would misreport the one
      // number that says whether `capacity` is too small.
      entries.clear()
      // Release the grid too. Fields hold no reference to it, so this is the
      // cache's only one — left set, a cache that outlives a mission pins that
      // mission's whole `NavGrid` in memory. Resetting the version alongside it
      // keeps the pair consistent: -1 is a value no real version takes, so the
      // next `get` simply adopts whatever grid it is handed.
      grid = null
      gridVersion = -1
    },
  }
}
