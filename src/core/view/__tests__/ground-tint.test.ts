import { describe, it, expect } from 'vitest'
import {
  GROUND_MEAN_LINEAR,
  TINT_EXPOSURE,
  TINT_HUE_STRENGTH,
  groundTint,
  linearLuminance,
} from '../ground-tint'
import { GROUND_SURFACES } from '../ground-surface'

/**
 * Ticket 034 — what a tile's vertex colour has to BE once three different
 * textures can sit under it.
 *
 * The terrain material computes `texture * vertexColour`, so the vertex colour
 * was never "the colour of the tile" — it is "what this texture must be
 * multiplied by to look like that tile". With one texture that distinction was
 * academic. With three it is the whole ticket, because the multiplier depends on
 * which texture is underneath.
 *
 * THE FAILURE MODE, NAMED: computing a water tile's gain against the JUNGLE's
 * mean. Water is 2.3x brighter than the jungle floor, so the river renders about
 * a stop and a quarter too hot — and it looks like a lighting bug, not a lookup
 * bug, which is how it would survive review.
 */

/** A mid grass green in linear space, standing in for `tileStyle`'s output. */
const GRASS = { r: 0.159, g: 0.3466, b: 0.0782 }

describe('the measured texture means', () => {
  it('has one for every surface', () => {
    // A surface with no mean is a division by undefined; the gain would be NaN
    // and the tile would render black.
    for (const surface of GROUND_SURFACES) {
      const mean = GROUND_MEAN_LINEAR[surface]
      expect({ surface, ok: mean.r > 0 && mean.g > 0 && mean.b > 0 }).toEqual({ surface, ok: true })
    }
  })

  it('keeps the jungle mean that ticket 009c measured off the committed asset', () => {
    /**
     * Not a fresh measurement, deliberately — this is the number the whole of
     * 009c's tint math was tuned against, and re-deriving it slightly
     * differently would shift the brightness of every grass, canopy and rock
     * tile in the game while looking like a no-op.
     */
    expect(GROUND_MEAN_LINEAR.jungle).toEqual({ r: 0.0693, g: 0.0642, b: 0.0093 })
  })

  it('pins water and bridge to their measured values, not merely to each other', () => {
    /**
     * THIS FILE'S OWN BLIND SPOT, FOUND BY MUTATION. Every other assertion here
     * computes its expectation as `… / linearLuminance(GROUND_MEAN_LINEAR[surface])`
     * — reading the same table the production code reads. That proves the gain
     * formula and proves NOTHING about which mean belongs to which texture.
     * Swapping the water and bridge entries left all 1980 tests green, rendering
     * the river 19% dark and the deck 19% hot.
     *
     * So the two are pinned literally, exactly as the jungle already was.
     * Measured off the source art with the one-liner in `GROUND_MEAN_LINEAR`'s
     * comment.
     */
    expect(GROUND_MEAN_LINEAR.water).toEqual({ r: 0.0678, g: 0.1661, b: 0.1155 })
    expect(GROUND_MEAN_LINEAR.bridge).toEqual({ r: 0.3281, g: 0.1336, b: 0.0433 })

    // And they are genuinely different textures: the bridge is warm, the water
    // is cool. A swap is caught by the values above; this says why it matters.
    expect(GROUND_MEAN_LINEAR.bridge.r).toBeGreaterThan(GROUND_MEAN_LINEAR.bridge.b)
    expect(GROUND_MEAN_LINEAR.water.b).toBeGreaterThan(GROUND_MEAN_LINEAR.water.r)
  })

  it('and the two new textures are much brighter, which is why the mean has to be per texture', () => {
    /**
     * Measured off the source art. If these were close to the jungle's, using
     * the wrong one would be a subtle bug; they are not close, so it is a loud
     * one — and that is worth pinning, because a later re-export of the art that
     * happened to darken them would quietly weaken every assertion below.
     */
    const jungle = linearLuminance(GROUND_MEAN_LINEAR.jungle)
    expect(linearLuminance(GROUND_MEAN_LINEAR.water) / jungle).toBeGreaterThan(2)
    expect(linearLuminance(GROUND_MEAN_LINEAR.bridge) / jungle).toBeGreaterThan(2)
  })
})

describe('the jungle floor keeps exactly the tint it has today', () => {
  it('holds ticket 009c`s two tuned constants', () => {
    // Both were tuned by eye against the real art and both have a documented
    // failure either side of them. A silent drift re-lights the whole map.
    expect(TINT_EXPOSURE).toBe(0.5)
    expect(TINT_HUE_STRENGTH).toBe(0.35)
  })

  it('lands the tile`s brightness exactly where 009c put it', () => {
    /**
     * THE INVARIANT THE OLD CODE RENORMALISED TO, asserted rather than assumed:
     * multiply the texture's mean by the tint and you get the tile's own
     * luminance, scaled by the exposure. That is what preserves ticket 009's
     * brightness hierarchy by construction — canopy darker than grass, blocked
     * distinct from walkable — instead of by eye.
     */
    const tint = groundTint('jungle', GRASS)
    const achieved = linearLuminance({
      r: tint.r * GROUND_MEAN_LINEAR.jungle.r,
      g: tint.g * GROUND_MEAN_LINEAR.jungle.g,
      b: tint.b * GROUND_MEAN_LINEAR.jungle.b,
    })
    expect(achieved).toBeCloseTo(linearLuminance(GRASS) * TINT_EXPOSURE, 6)
  })

  it('and still pushes the tile`s hue onto the texture', () => {
    /**
     * The hue term is what separates grass from canopy from rock on ONE shared
     * image, so it must survive this ticket. A pure scalar gain would have equal
     * channels; this must not.
     */
    const tint = groundTint('jungle', GRASS)
    expect(tint.r).not.toBeCloseTo(tint.g, 3)
    expect(tint.g).not.toBeCloseTo(tint.b, 3)
  })
})

describe('water and the bridge take exposure only, and no hue at all', () => {
  it('is a pure scalar — the same multiplier on all three channels', () => {
    /**
     * WHY NO HUE TERM. `TINT_HUE_STRENGTH` exists to make one image read as
     * three terrains. Water and the bridge have their own art, so pushing
     * `#4d86b5` onto water is insisting on a blue the texture already is — and
     * 009c measured what that does at full strength: the floor's blue channel is
     * nearly empty, so an exact hue match needs an 8x blue gain, which turns
     * every grey pebble violet and drains the greens. The painted highlights go
     * with them.
     */
    for (const surface of ['water', 'bridge'] as const) {
      const tint = groundTint(surface, GRASS)
      expect({ surface, rg: tint.r - tint.g, gb: tint.g - tint.b }).toEqual({
        surface,
        rg: 0,
        gb: 0,
      })
    }
  })

  it('and the gain is computed against ITS OWN mean, not the jungle`s', () => {
    /**
     * THE ONE THIS TICKET EXISTS TO PREVENT. Both new textures are over twice
     * the jungle's brightness, so the wrong mean renders them badly hot — and it
     * is a lookup bug that presents as a lighting bug.
     */
    for (const surface of ['water', 'bridge'] as const) {
      const tint = groundTint(surface, GRASS)
      const expected = (linearLuminance(GRASS) * TINT_EXPOSURE) / linearLuminance(GROUND_MEAN_LINEAR[surface])
      expect({ surface, gain: Number(tint.r.toFixed(9)) }).toEqual({
        surface,
        gain: Number(expected.toFixed(9)),
      })
      // And explicitly NOT the jungle's, which is the mistake being guarded.
      const wrong = (linearLuminance(GRASS) * TINT_EXPOSURE) / linearLuminance(GROUND_MEAN_LINEAR.jungle)
      expect(tint.r).not.toBeCloseTo(wrong, 2)
    }
  })

  it('still lands the tile`s brightness where the exposure asks', () => {
    // The same invariant the jungle satisfies, so the brightness hierarchy
    // crosses a texture boundary intact: a water tile still reads darker than
    // the bank beside it because its STYLE colour is darker, not because its
    // texture happens to be.
    for (const surface of ['water', 'bridge'] as const) {
      const tint = groundTint(surface, GRASS)
      const mean = GROUND_MEAN_LINEAR[surface]
      const achieved = linearLuminance({
        r: tint.r * mean.r,
        g: tint.g * mean.g,
        b: tint.b * mean.b,
      })
      expect({ surface, achieved: Number(achieved.toFixed(9)) }).toEqual({
        surface,
        achieved: Number((linearLuminance(GRASS) * TINT_EXPOSURE).toFixed(9)),
      })
    }
  })
})

describe('degenerate inputs do not produce a NaN on screen', () => {
  it('a black tile tints to black rather than dividing by zero', () => {
    // `floorTint` guarded this and the guard has to survive: a tile whose style
    // colour is black has zero luminance, and the gain is a division by it.
    for (const surface of GROUND_SURFACES) {
      const tint = groundTint(surface, { r: 0, g: 0, b: 0 })
      expect({ surface, tint }).toEqual({ surface, tint: { r: 0, g: 0, b: 0 } })
    }
  })

  it('and every channel of every result is a finite number', () => {
    for (const surface of GROUND_SURFACES) {
      for (const tile of [GRASS, { r: 1, g: 1, b: 1 }, { r: 0.001, g: 0, b: 0 }]) {
        const tint = groundTint(surface, tile)
        const finite = Number.isFinite(tint.r) && Number.isFinite(tint.g) && Number.isFinite(tint.b)
        expect({ surface, tile, finite }).toEqual({ surface, tile, finite: true })
      }
    }
  })
})
