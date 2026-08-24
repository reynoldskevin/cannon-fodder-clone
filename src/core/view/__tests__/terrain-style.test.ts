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

  it('renders grass and canopy differently', () => {
    expect(tileStyle(1, true).colour).not.toBe(tileStyle(2, false).colour)
  })

  it('gives canopy more height than grass, so the map reads in 3D', () => {
    expect(tileStyle(2, false).height).toBeGreaterThan(tileStyle(1, true).height)
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
