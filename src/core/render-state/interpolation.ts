/**
 * Interpolating entity positions between sim ticks (ticket 010).
 *
 * The simulation advances at a fixed timestep while the display runs at
 * whatever rate the monitor runs at, so the renderer draws somewhere *between*
 * the previous and the current sim state — `alpha` being how far.
 *
 * It was written and tested before there was a sim to feed it, because it is
 * the seam. The sim has since landed: `core/session` steps `World` at the fixed
 * timestep and `main.ts` passes the loop's alpha straight through, so every
 * pixel of between-tick motion on screen is measured here.
 */

/** One entity's position at one sim tick. */
export interface EntitySnapshot {
  readonly id: number
  readonly x: number
  readonly z: number
}

/**
 * Blend two sim states into the positions to draw.
 *
 * Matched BY ID, not by array index: the sim is free to reorder its entity list
 * between ticks (a death compacts the array), and index matching would smear
 * every entity toward whichever one happened to take its slot.
 *
 * The membership rules are what stop the two visual failures at the edges:
 *   - An entity in `cur` but not `prev` **spawned this tick**, so it is drawn
 *     at its current position. Blending from a missing previous state would
 *     have it fly in from wherever the array's zero happens to be.
 *   - An entity in `prev` but not `cur` **is gone**, so it is dropped. Keeping
 *     it would leave a ghost that never clears.
 *
 * `alpha` is clamped, and a non-finite one is read as 1 (the current state).
 * A frame-time spike must not fling entities past their target, and a NaN alpha
 * must not produce a NaN position — an entity at NaN vanishes into a degenerate
 * transform with no error anywhere.
 */
export function interpolateEntities(
  prev: readonly EntitySnapshot[],
  cur: readonly EntitySnapshot[],
  alpha: number,
): EntitySnapshot[] {
  const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1

  const previous = new Map<number, EntitySnapshot>()
  for (const entity of prev) previous.set(entity.id, entity)

  return cur.map((entity) => {
    const before = previous.get(entity.id)
    if (!before) return { id: entity.id, x: entity.x, z: entity.z }
    return {
      id: entity.id,
      x: before.x + (entity.x - before.x) * t,
      z: before.z + (entity.z - before.z) * t,
    }
  })
}
