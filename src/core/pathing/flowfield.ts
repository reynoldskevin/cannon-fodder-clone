/**
 * Flow fields (ticket 006) — one Dijkstra sweep outward from a destination,
 * shared by every unit heading there.
 *
 * `ARCHITECTURE.md` (Hard problem 3) chose this over per-unit A* for two
 * reasons, and both shape the code below. The first is cost: a squad of twelve
 * ordered to one place is twelve searches with A* and one sweep here, and every
 * unit then reads its direction in O(1) for the rest of the mission. The second
 * is testability: a field is a picture that can be asserted whole — "every
 * reachable cell strictly descends to the target" is one loop over the map,
 * where the equivalent claim about a path is a claim about one path.
 *
 * WHY DIJKSTRA AND NOT BFS. Diagonal movement is worth `SQRT2`, not 1. A
 * breadth-first sweep that treated it as 1 would make the gradient prefer
 * diagonals everywhere, and units would walk visible staircases across open
 * ground instead of straight lines.
 *
 * WHY THE SWEEP RUNS FROM THE TARGET. The gradient a unit follows is "cost to
 * reach the target from here", so relaxing outward from the destination fills
 * exactly that, once, for the whole map. Searching from each unit would produce
 * the same numbers per unit and share none of them.
 *
 * THE INVARIANT EVERYTHING RESTS ON: a cell's direction points at the neighbour
 * it was relaxed from, and relaxation only ever assigns
 * `cost[here] = cost[neighbour] + step` with `step > 0`. So following the
 * direction always lands on a passable cell and always *strictly* reduces cost,
 * which — over a finite map — means arrival. Not a heuristic that usually works:
 * a consequence of how the numbers were written.
 */

import type { NavGrid, TraversalMask } from './navgrid'

/**
 * The cost of a cell no path to the target exists from — blocked, walled into a
 * pocket, or off the map.
 *
 * Infinity rather than a sentinel like `-1` because it is the arithmetically
 * correct value: every `cost < best` comparison in the relaxation loop then
 * treats "not yet reached" correctly with no special case, and any caller that
 * compares two costs gets the right answer without knowing the sentinel.
 */
export const UNREACHABLE = Number.POSITIVE_INFINITY

/** The cost of a diagonal step, against 1 for an orthogonal one. */
export const SQRT2 = Math.SQRT2

/**
 * Neighbour offsets, orthogonals first.
 *
 * Order matters only for reproducibility, not correctness — relaxation is
 * strict (`<`, never `<=`), so the first neighbour to offer a given cost keeps
 * the cell and a later tie cannot flip it. Fixing the order therefore fixes the
 * field, which is what makes two runs over the same grid byte-identical.
 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/**
 * A binary min-heap of cell indices keyed by tentative cost.
 *
 * The alternative — scanning every cell for the cheapest unsettled one — is
 * O(n^2): on level 1's 2565 cells that is ~6.5 million comparisons per field
 * where this is ~2565 * log2(2565) ≈ 29 thousand. The whole reason flow fields
 * beat per-unit A* is that one sweep is cheap; a quadratic sweep would give that
 * argument away.
 *
 * Entries are never decreased in place. A cell is simply pushed again at its new
 * lower cost and the stale entry is skipped when popped (the `settled` flag in
 * `computeFlowField`), which trades a little memory for not having to maintain a
 * cell -> heap-position index.
 */
class CellHeap {
  private cells: Int32Array
  private keys: Float64Array
  private count = 0

  constructor(capacity: number) {
    // Never zero: a heap over a 1x1 map still has to hold its single seed, and
    // the growth below doubles, which would double 0 forever.
    const initial = capacity > 0 ? capacity : 1
    this.cells = new Int32Array(initial)
    this.keys = new Float64Array(initial)
  }

  get size(): number {
    return this.count
  }

  push(cell: number, key: number): void {
    if (this.count === this.cells.length) this.grow()
    let i = this.count
    this.count += 1
    // Sift up, moving the hole rather than swapping: one write per level
    // instead of three.
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent]! <= key) break
      this.cells[i] = this.cells[parent]!
      this.keys[i] = this.keys[parent]!
      i = parent
    }
    this.cells[i] = cell
    this.keys[i] = key
  }

  /** The cell with the lowest key. Caller must check `size` first. */
  pop(): number {
    const top = this.cells[0]!
    this.count -= 1
    if (this.count > 0) {
      const cell = this.cells[this.count]!
      const key = this.keys[this.count]!
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        if (left >= this.count) break
        const right = left + 1
        const child = right < this.count && this.keys[right]! < this.keys[left]! ? right : left
        if (this.keys[child]! >= key) break
        this.cells[i] = this.cells[child]!
        this.keys[i] = this.keys[child]!
        i = child
      }
      this.cells[i] = cell
      this.keys[i] = key
    }
    return top
  }

  private grow(): void {
    const cells = new Int32Array(this.cells.length * 2)
    const keys = new Float64Array(this.keys.length * 2)
    cells.set(this.cells)
    keys.set(this.keys)
    this.cells = cells
    this.keys = keys
  }
}

/** A destination in tile coordinates. */
export interface GridPoint {
  readonly x: number
  readonly y: number
}

/**
 * A computed field: cost-to-target and a unit step toward it, per cell.
 *
 * Immutable from outside. Everything is stored in parallel typed arrays rather
 * than a cell object per tile — level 1 is 2565 cells and a field is recomputed
 * whenever the map changes, so 2565 short-lived objects per recompute is
 * garbage the fixed-timestep loop would rather not collect mid-mission.
 */
export class FlowField {
  /**
   * The destination this field descends to, as the integer TILE it descends to.
   *
   * A copy, so it cannot drift — and already floored by `computeFlowField`, so
   * a caller that hands in a fractional position reads back the tile the field
   * was actually solved for rather than the float it asked with. Those two
   * disagreeing is precisely how a field ends up perfectly monotonic toward
   * somewhere nobody asked to go.
   */
  readonly target: GridPoint
  /** The traversal classes this field was solved for. */
  readonly mask: TraversalMask
  /** The `NavGrid.version` this was computed against — see `cache.ts`. */
  readonly gridVersion: number

  private readonly w: number
  private readonly h: number
  private readonly costs: Float64Array
  private readonly stepX: Int8Array
  private readonly stepY: Int8Array

  constructor(
    w: number,
    h: number,
    target: GridPoint,
    mask: TraversalMask,
    gridVersion: number,
    costs: Float64Array,
    stepX: Int8Array,
    stepY: Int8Array,
  ) {
    this.w = w
    this.h = h
    this.target = target
    this.mask = mask
    this.gridVersion = gridVersion
    this.costs = costs
    this.stepX = stepX
    this.stepY = stepY
  }

  /**
   * Flat index of the tile CONTAINING (x, y), or -1 if that tile is off the map.
   *
   * ROUNDING CONTRACT: callers hold continuous positions — ticket 007's movement
   * system stores floats — so every accessor floors its arguments to the tile
   * they fall inside rather than requiring integers. Flooring, not truncation:
   * `Math.trunc(-0.5)` is `-0`, which would read tile 0 for a unit half a tile
   * off the west edge; `Math.floor` gives -1 and the query correctly reports
   * off-map.
   *
   * Without this, an in-bounds fractional coordinate would index the typed array
   * with a non-integer key, yield `undefined` at runtime despite the declared
   * `number` return type, and put a silent `undefined` into a velocity — one
   * un-rounded call away from a NaN position that never comes back. The
   * comparisons are written negated so a NaN coordinate reports off-map too,
   * rather than indexing with NaN.
   */
  private index(x: number, y: number): number {
    const tx = Math.floor(x)
    const ty = Math.floor(y)
    if (!(tx >= 0) || !(ty >= 0) || tx >= this.w || ty >= this.h) return -1
    return ty * this.w + tx
  }

  /**
   * Cost of travelling from (x, y) to the target, or `UNREACHABLE`.
   *
   * Out of bounds answers `UNREACHABLE` rather than throwing: steering drifts a
   * unit past the map edge for a frame, and a crash there would be a crash
   * caused by a rounding error.
   */
  cost(x: number, y: number): number {
    const i = this.index(x, y)
    // Non-null: `index` returned an in-range index; `noUncheckedIndexedAccess`
    // widens every typed-array read to `number | undefined` regardless.
    return i < 0 ? UNREACHABLE : this.costs[i]!
  }

  /** The x component of the step toward the target: -1, 0 or 1. */
  dirX(x: number, y: number): number {
    const i = this.index(x, y)
    return i < 0 ? 0 : this.stepX[i]!
  }

  /** The y component of the step toward the target: -1, 0 or 1. */
  dirY(x: number, y: number): number {
    const i = this.index(x, y)
    return i < 0 ? 0 : this.stepY[i]!
  }

  /**
   * True when a path from (x, y) to the target exists.
   *
   * The direction of an unreachable cell is (0, 0) — stand still. That is the
   * whole point of reporting it: handed a direction instead, a unit stranded in
   * one of level 1's 63 enclosed pockets would walk into the wall, and because
   * the field never changes it would keep doing so for the rest of the mission.
   */
  reachable(x: number, y: number): boolean {
    return this.cost(x, y) !== UNREACHABLE
  }
}

/**
 * Solve the field for one destination.
 *
 * A target that is blocked or off the map yields an all-unreachable field rather
 * than an error: "go to that rock" is an ordinary misclick, and every unit
 * reading the field is then correctly told to stand still.
 */
export function computeFlowField(grid: NavGrid, target: GridPoint, mask: TraversalMask): FlowField {
  const { w, h } = grid
  const cells = w * h
  const costs = new Float64Array(cells)
  costs.fill(UNREACHABLE)
  const stepX = new Int8Array(cells)
  const stepY = new Int8Array(cells)

  // FLOOR THE DESTINATION ONCE, HERE, and use this pair for everything that
  // follows: the passability guard, the source index and the tile recorded on
  // the field. Ticket 007 stores float positions and 008 picks destinations by
  // raycasting the ground plane, so a fractional target is the normal case.
  //
  // Once, and up front, because the danger is not the rounding — it is two
  // places rounding differently. `grid.passable` floors internally, so a guard
  // reading `target.x` raw and an index computed from `target.x` raw silently
  // disagree about which tile the destination is: `2.5 * 5 + 2.5` is a
  // perfectly valid index 15, and the sweep then solves a perfectly monotonic
  // field for tile (0,3) while the caller is told the target is (2.5,2.5).
  // Nothing looks broken and every unit walks confidently to the wrong place.
  const tx = Math.floor(target.x)
  const ty = Math.floor(target.y)

  const field = new FlowField(w, h, { x: tx, y: ty }, mask, grid.version, costs, stepX, stepY)

  if (!grid.passable(tx, ty, mask)) return field

  // One byte per cell rather than comparing the popped key against the stored
  // cost: a settled cell is final under Dijkstra, so this also lets neighbours
  // be skipped before any arithmetic is done on them.
  const settled = new Uint8Array(cells)
  const heap = new CellHeap(cells)

  // Safe to index with: the guard above proved (tx, ty) is a real in-bounds
  // tile, so this is an integer in [0, cells).
  const source = ty * w + tx
  costs[source] = 0
  heap.push(source, 0)

  while (heap.size > 0) {
    const u = heap.pop()
    if (settled[u] === 1) continue
    settled[u] = 1
    const ux = u % w
    const uy = (u - ux) / w
    const base = costs[u]!

    for (const [dx, dy] of NEIGHBOURS) {
      const vx = ux + dx
      const vy = uy + dy
      // Covers both "off the map" and "no class in `mask` may enter".
      if (!grid.passable(vx, vy, mask)) continue

      const diagonal = dx !== 0 && dy !== 0
      if (diagonal) {
        // NO CORNER CUTTING — and the rule is exactly "BOTH shared orthogonals
        // blocked", not "either".
        //
        // Both blocked is two walls touching at a corner: the diagonal passes
        // through the point where they meet, which is solid terrain, and a unit
        // taking it reads as a collision bug. Level 1's canopy fringe has
        // hundreds of such corners, so this is not a corner case.
        //
        // Exactly one blocked is a legal squeeze past a single wall corner and
        // must be TAKEN. Refusing it does not change what is reachable — the
        // open orthogonal always gives a two-step L route — it just prices the
        // move at 2 instead of SQRT2, so the gradient tends toward Manhattan
        // distance and units walk visible staircases along every wall.
        if (!grid.passable(vx, uy, mask) && !grid.passable(ux, vy, mask)) continue
      }

      const v = vy * w + vx
      if (settled[v] === 1) continue
      const candidate = base + (diagonal ? SQRT2 : 1)
      if (candidate >= costs[v]!) continue

      costs[v] = candidate
      // The step points BACK at the cell this cost came from. That is what makes
      // the descent invariant hold by construction: the neighbour's cost is
      // `candidate - step`, strictly lower, and it is passable because we just
      // walked through it.
      stepX[v] = -dx
      stepY[v] = -dy
      heap.push(v, candidate)
    }
  }

  return field
}
