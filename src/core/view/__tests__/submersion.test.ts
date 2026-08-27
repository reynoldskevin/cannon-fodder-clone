import { describe, it, expect } from 'vitest'
import { submersionFor, SUBMERSION_FRACTION } from '../submersion'
import { TERRAIN } from '../../level/terrain'

/**
 * Ticket 041 — how deep in the river a man stands.
 *
 * He walked on top of it before this: `terrain-style.ts` puts the water surface
 * at `-0.12` and `renderEntities` places every unit at the ground height, so a
 * soldier crossing was 0.12 below grade and otherwise entirely dry.
 *
 * A FRACTION, NOT A DISTANCE, and that split is the point. How tall a soldier is
 * drawn is a SPRITE metric — `core` does not know it and must not, since it may
 * not import the renderer. Core says how much of him is under; the renderer
 * turns that into world units against a height only it has.
 */

describe('a man in the river', () => {
  it('is most of the way under it', () => {
    expect(submersionFor(TERRAIN.WATER)).toBe(SUBMERSION_FRACTION)
  })

  it('and that is chest-deep, not paddling and not drowned', () => {
    /**
     * Bounded on BOTH sides, because both failures are silent. At 0 nothing
     * changed and the ticket did nothing; at 1 the man is entirely behind the
     * water plane and simply vanishes mid-crossing, which reads as units being
     * deleted by the river rather than wading through it.
     */
    expect(SUBMERSION_FRACTION).toBeGreaterThan(0.4)
    expect(SUBMERSION_FRACTION).toBeLessThan(0.95)
  })
})

describe('and a man anywhere else is dry', () => {
  it('on grass, rock and canopy', () => {
    for (const tile of [TERRAIN.GRASS, TERRAIN.ROCK, TERRAIN.CANOPY]) {
      expect({ tile, wet: submersionFor(tile) }).toEqual({ tile, wet: 0 })
    }
  })

  it('and ON THE BRIDGE, which is the entire point of the bridge', () => {
    /**
     * Every deck tile of level 2's crossing is surrounded by water and the deck
     * itself spans it. A submersion rule that keyed off "near water" rather than
     * off the tile a man is standing ON would sink the squad while they walked
     * over the thing built to keep them out of it — and would undo two tickets
     * (033, 035) in one line.
     */
    expect(submersionFor(TERRAIN.BRIDGE)).toBe(0)
  })

  it('and on a tile id this build has never heard of', () => {
    // Levels 3-5 are not imported yet and tile ids are an open enum. The neutral
    // answer for an unknown tile is dry: a man mysteriously waist-deep in a field
    // is a stranger bug than one who is not submerged where he should be.
    expect(submersionFor(99)).toBe(0)
    expect(submersionFor(-1)).toBe(0)
  })

  it('and a nonsense id does not produce NaN', () => {
    // The value is multiplied by a sprite height and subtracted from a world
    // position. A NaN there puts the soldier nowhere at all, and nothing on
    // screen explains a unit that has stopped being drawn.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(submersionFor(bad))).toBe(true)
    }
  })
})
