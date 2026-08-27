import { describe, it, expect } from 'vitest'
import { GROUND_SURFACES, groundSurfaceFor } from '../ground-surface'
import { TERRAIN } from '../../level/terrain'

/**
 * Ticket 034 — which ground texture a tile's top face samples.
 *
 * WHY THIS IS IN `core/view` AND NOT IN THE RENDERER. `src/render` has no tests
 * and cannot have any: Vitest runs in `environment: 'node'`, so there is no
 * WebGL context and no DOM. A lookup written there is a lookup nothing checks.
 * The renderer's job is to turn this answer into a geometry group; the answer
 * itself is a decision, and decisions live where they can be asserted — the same
 * argument `terrain-style` makes about colour and height.
 */

describe('groundSurfaceFor', () => {
  it('gives water and the bridge their own art', () => {
    // The whole ticket, in two lines. Before this the river was the jungle floor
    // tinted blue and the deck was the jungle floor tinted brown.
    expect(groundSurfaceFor(TERRAIN.WATER)).toBe('water')
    expect(groundSurfaceFor(TERRAIN.BRIDGE)).toBe('bridge')
  })

  it('leaves every other named terrain on the jungle floor', () => {
    // Grass, canopy and rock are separated by TINT alone and always have been —
    // one texture, three tints. This ticket does not change that and must not:
    // three more ground textures would put a hard, axis-aligned seam at every
    // boundary between them, which is the artefact `CANOPY_COLOUR` documents at
    // length and exists to avoid.
    for (const id of [TERRAIN.UNKNOWN, TERRAIN.GRASS, TERRAIN.CANOPY, TERRAIN.ROCK]) {
      expect({ id, surface: groundSurfaceFor(id) }).toEqual({ id, surface: 'jungle' })
    }
  })

  it('falls back to the jungle for an id it has never seen', () => {
    /**
     * `TileId` is an open enum — `types.ts` states that adding one must never be
     * a schema break — so this has to answer for an id from a newer importer.
     * The jungle is the answer that covers the map. Throwing, or returning
     * something with no texture behind it, would put an untextured hole in a
     * level that a merely-out-of-date build could otherwise draw fine.
     *
     * The same argument `traversalForTerrain` makes about passability, and for
     * the same reason: degrade to the harmless answer, never to the one that
     * breaks the level.
     */
    for (const id of [6, 42, 255, -1, 0.5, Number.NaN]) {
      expect({ id, surface: groundSurfaceFor(id) }).toEqual({ id, surface: 'jungle' })
    }
  })

  it('only ever returns a surface the manifest can supply', () => {
    // A surface with no texture behind it is a boot failure, so the two lists
    // have to be the same list.
    const all = [TERRAIN.UNKNOWN, TERRAIN.GRASS, TERRAIN.CANOPY, TERRAIN.ROCK, TERRAIN.WATER, TERRAIN.BRIDGE, 99]
    for (const id of all) {
      expect({ id, known: GROUND_SURFACES.includes(groundSurfaceFor(id)) }).toEqual({
        id,
        known: true,
      })
    }
  })

  it('names each surface exactly once', () => {
    expect([...GROUND_SURFACES].sort()).toEqual(['bridge', 'jungle', 'water'])
  })
})
