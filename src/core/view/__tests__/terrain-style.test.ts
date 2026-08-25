import { describe, it, expect } from 'vitest'
import { tileStyle, TILE_STYLES } from '../terrain-style'

/**
 * Ticket 009 — terrain appearance.
 *
 * Tile ids are an OPEN enum (ARCHITECTURE.md extension points: buildings add
 * ids without a schema break), so an unknown id must degrade to a visible
 * fallback rather than crashing or rendering invisibly.
 */

describe('known tile ids', () => {
  it('gives every declared tile id a style', () => {
    for (const id of Object.keys(TILE_STYLES).map(Number)) {
      const s = tileStyle(id, true)
      expect(s.colour).toMatch(/^#[0-9a-f]{6}$/i)
      expect(Number.isFinite(s.height)).toBe(true)
    }
  })

  it('renders grass and canopy IDENTICALLY — see the canopy case below', () => {
    // This asserted the opposite until the squares were chased down. The floor
    // is one texture times a per-tile tint, and any difference in that tint
    // draws a hard tile-shaped edge on the ground. Kept as its own case rather
    // than deleted, because "grass and canopy must differ" is the obvious thing
    // to reach for and this is where the reason not to lives.
    expect(tileStyle(1, true).colour).toBe(tileStyle(2, false).colour)
  })

  it('lays canopy FLAT, level with grass, so no tile stands on a pedestal', () => {
    /**
     * REVERSED DELIBERATELY, and the old assertion is worth keeping in view:
     * "gives canopy more height than grass, so the map reads in 3D". That was
     * ticket 010a's decision and it cost more than it bought.
     *
     * One tree is planted per FRINGE canopy tile — any canopy tile with a
     * non-canopy neighbour — so a lone tree in open grass is fringe on all four
     * sides and stood on a one-tile block with nothing beside it to hide the
     * block's walls. Every isolated trunk on level 1 sat on a visible dark
     * square. The map still reads in 3D; the trees do it, which is what they
     * are for.
     *
     * EQUAL, not merely close. Any difference at all puts a step at every
     * grass/canopy boundary, which relocates the artefact rather than removing
     * it.
     */
    expect(tileStyle(2, false).height).toBe(tileStyle(1, true).height)
    expect(tileStyle(2, true).height).toBe(tileStyle(1, true).height)
  })

  it('draws canopy with the SAME tint as grass, so no tile edge shows', () => {
    /**
     * The last of the squares, and the assertion that keeps it gone.
     *
     * The floor is one tileable texture multiplied by a per-tile vertex colour,
     * and that colour is constant across a tile — so two neighbouring tiles with
     * different tints meet at a hard, axis-aligned edge. It did not matter how
     * close the two greens were: a canopy tile with no tree over it still drew a
     * rectangle on the grass. Nudging them nearer only made it fainter.
     *
     * Identical is the only value that has no edge. What tells a player where
     * the forest is, is the trees.
     */
    expect(tileStyle(2, false).colour).toBe(tileStyle(1, true).colour)
    expect(tileStyle(2, true).colour).toBe(tileStyle(1, true).colour)
  })
})

describe('walkable vs blocked', () => {
  it('distinguishes blocked from walkable for the same tile id', () => {
    const walkable = tileStyle(1, true)
    const blocked = tileStyle(1, false)
    expect(blocked.colour !== walkable.colour || blocked.height !== walkable.height).toBe(true)
  })

  it('never renders a blocked tile lower than its walkable form', () => {
    // Blocked terrain reading as a raised obstacle is what makes the map legible.
    for (const id of Object.keys(TILE_STYLES).map(Number)) {
      expect(tileStyle(id, false).height).toBeGreaterThanOrEqual(tileStyle(id, true).height)
    }
  })
})

describe('unknown tile ids (open enum)', () => {
  it('falls back to a visible style instead of throwing', () => {
    const s = tileStyle(9999, true)
    expect(s.colour).toMatch(/^#[0-9a-f]{6}$/i)
    expect(Number.isFinite(s.height)).toBe(true)
  })

  it('handles a negative id', () => {
    expect(() => tileStyle(-1, true)).not.toThrow()
  })

  it('marks the fallback so an unstyled tile is obvious on screen', () => {
    expect(tileStyle(9999, true).isFallback).toBe(true)
    expect(tileStyle(1, true).isFallback).toBe(false)
  })
})
