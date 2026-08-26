/**
 * Traversal classes, as bits.
 *
 * WHY THIS IS ITS OWN FILE, AND IT IS NOT A TIDY-UP. These constants were
 * declared in `navgrid.ts` and are still the pathing layer's own vocabulary —
 * `navgrid.ts` re-exports every one of them, so `core/pathing`'s public surface
 * is unchanged and `import { INFANTRY } from './navgrid'` still reads the same.
 *
 * They were split out because ticket 003a made the dependency run BOTH ways.
 * `bakeNavGrid` now asks `core/level`'s `traversalForTerrain` which classes a
 * tile admits, and that table has to name the masks it returns. So:
 *
 *     level/terrain.ts  ->  pathing/navgrid.ts  ->  level/terrain.ts
 *
 * — a real runtime cycle (not the type-only `import type { LevelData }` edge,
 * which `verbatimModuleSyntax` erases). Under a cycle the module evaluated
 * second sees the first's `const` bindings uninitialised, so `ALL_TRAVERSAL`
 * could read `undefined` at module scope and a table row would bake to `NaN`
 * traversal bits — a cell passable to nobody, on a level that looked fine when
 * the loader happened to pull the modules in the other order.
 *
 * Hoisting the masks into a module that imports NOTHING makes both sides depend
 * downward on a leaf, and the cycle is gone rather than merely tolerated.
 */

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
