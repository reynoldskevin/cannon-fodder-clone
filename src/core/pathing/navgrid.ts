/**
 * The navigation grid (ticket 006) — `LevelData.walkable` baked into the form
 * pathing actually queries.
 *
 * Why a bake rather than reading `level.walkable` directly:
 *
 *   - PASSABILITY IS PER TRAVERSAL CLASS, not per tile. `ARCHITECTURE.md`'s
 *     vehicles extension point promises that "`PathingSystem` takes a per-unit
 *     traversal mask, so vehicle-only terrain rules need no grid change". A
 *     `boolean[][]` cannot express "infantry may cross this ditch, a half-track
 *     may not"; a bitmask per cell can, and costs the same byte either way.
 *   - PASSABILITY MUTATES. Destructible terrain flips cells mid-mission, and
 *     `LevelData` is the loader's immutable, defensively-copied record of the
 *     document on disk. Writing through to it would make the level file's
 *     in-memory representation disagree with the file.
 *   - CACHED FIELDS NEED A CHANGE SIGNAL. Every flow field is only valid for one
 *     shape of the world, so the grid carries a `version` that bumps on a real
 *     passability change and on nothing else. Without it a blown bridge leaves
 *     every unit following a field computed for a world that no longer exists;
 *     with a version that bumped on every *write*, a system that rewrote the
 *     same value each tick would throw the entire cache away 60 times a second.
 *
 * The grid is a snapshot: it copies the level's flags and never holds a
 * reference to them, so an edit upstream cannot change passability behind the
 * version key's back.
 */

import type { LevelData } from '../level/types'

/**
 * A set of traversal classes, one bit each.
 *
 * A cell stores the classes that may enter it; a query supplies the classes the
 * unit belongs to; the cell is passable when the two intersect. That makes the
 * empty mask (`0`) mean "nothing may pass", which is what an obstacle is — so a
 * blocked cell and a unit with no traversal class fall out of the same test
 * rather than needing a special case.
 */
export type TraversalMask = number

/** Foot units. The only class the game spawns today. */
export const INFANTRY: TraversalMask = 1 << 0

/**
 * Wheeled/tracked units. Nothing spawns one yet; the bit exists so the terrain
 * rules for them are a data change later rather than a grid rewrite.
 */
export const VEHICLE: TraversalMask = 1 << 1

/** Every class this build knows about — what a plainly walkable tile bakes to. */
export const ALL_TRAVERSAL: TraversalMask = INFANTRY | VEHICLE

/**
 * Cell storage is `Uint8Array`, so eight traversal classes fit before the
 * storage type has to change. Kept as a named constant because a mask that
 * silently truncated on write would produce a cell that is passable to a class
 * nobody can see, which is the hardest kind of pathing bug to look at.
 */
const MASK_BITS = 0xff

/**
 * A baked, mutable passability grid.
 *
 * Normally built by `bakeNavGrid`. The constructor is public only because a test
 * harness or a later procedural map wants to hand in cells directly; it takes
 * ownership of the array it is given rather than copying, so callers must not
 * keep writing to it.
 */
export class NavGrid {
  /** Width in tiles. */
  readonly w: number
  /** Height in tiles. */
  readonly h: number

  /**
   * Row-major traversal bits, one byte per cell. A flat typed array rather than
   * rows of arrays: a whole-map Dijkstra sweep touches every cell, and one
   * contiguous buffer means one bounds check and no per-row indirection.
   */
  private readonly cells: Uint8Array

  private revision = 0

  constructor(w: number, h: number, cells: Uint8Array) {
    this.w = w
    this.h = h
    this.cells = cells
  }

  /**
   * The change key cached flow fields are validated against.
   *
   * A monotonically increasing counter starting at 0, so a fresh bake of the
   * same level always reports the same version and two grids that have taken
   * the same edits compare equal. It identifies a *shape of the world*, not a
   * moment in time — hence a counter and not a clock, which `src/core` is
   * forbidden from reading anyway.
   */
  get version(): number {
    return this.revision
  }

  /**
   * Flat index of the tile CONTAINING (x, y), or -1 if that tile is off the map.
   *
   * ROUNDING CONTRACT (shared with `FlowField`): callers hold continuous
   * positions, so coordinates are floored to the tile they fall inside rather
   * than required to be integers. `Math.floor` and not `Math.trunc`, because
   * `Math.trunc(-0.5)` is `-0` and would read tile 0 for a unit half a tile off
   * the west edge. The comparisons are negated so NaN reports off-map rather
   * than indexing the cell array with NaN.
   */
  private index(x: number, y: number): number {
    const tx = Math.floor(x)
    const ty = Math.floor(y)
    if (!(tx >= 0) || !(ty >= 0) || tx >= this.w || ty >= this.h) return -1
    return ty * this.w + tx
  }

  /** True when any class in `mask` may enter (x, y). Out of bounds is never passable. */
  passable(x: number, y: number, mask: TraversalMask): boolean {
    const i = this.index(x, y)
    if (i < 0) return false
    // Non-null: `index` returned an in-range index; `noUncheckedIndexedAccess`
    // widens every typed-array read to `number | undefined` regardless.
    return (this.cells[i]! & mask) !== 0
  }

  /**
   * Replace the traversal classes allowed into (x, y), bumping `version` only if
   * that actually changed something.
   *
   * Out-of-bounds writes are ignored rather than throwing: callers reach here
   * from explosion radii and area effects clipped against the map edge, and a
   * throw there would turn a grenade at the border into a crash.
   */
  setPassable(x: number, y: number, mask: TraversalMask): void {
    const i = this.index(x, y)
    if (i < 0) return
    const next = mask & MASK_BITS
    if (this.cells[i] === next) return
    this.cells[i] = next
    this.revision += 1
  }

  /** How many cells any class in `mask` may enter. `O(w*h)`; not a tick-loop call. */
  passableCount(mask: TraversalMask): number {
    let count = 0
    for (let i = 0; i < this.cells.length; i += 1) {
      if ((this.cells[i]! & mask) !== 0) count += 1
    }
    return count
  }
}

/**
 * Bake a navigation grid from a loaded level.
 *
 * Every walkable tile is opened to ALL traversal classes. Level 1's walkable set
 * is the importer's brightness heuristic (`walkableSource: 'heuristic'`) rather
 * than authored data, so it carries no opinion about *who* can walk there —
 * inventing one here would be a fabricated restriction dressed up as level
 * design. Class-specific rules belong to whatever later writes them in.
 */
export function bakeNavGrid(level: LevelData): NavGrid {
  const { w, h } = level.size
  const cells = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    const row = level.walkable[y]
    if (row === undefined) continue
    for (let x = 0; x < w; x += 1) {
      // Copied cell by cell, never aliased: the grid is a snapshot of the level,
      // so a later mutation of `level.walkable` must not change passability
      // without going through `setPassable` and bumping the version.
      if (row[x] === true) cells[y * w + x] = ALL_TRAVERSAL
    }
  }
  return new NavGrid(w, h, cells)
}
