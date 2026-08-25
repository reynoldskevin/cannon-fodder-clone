import { describe, it, expect } from 'vitest'
import { facingFromVector, stableFacing, FACINGS } from '../facing'

/**
 * Ticket 010 — choosing which of the 8 sprite directions to draw.
 *
 * World space is y-up with the terrain in XZ (ticket 009's projection): +x is
 * screen-right, +z is screen-down/toward the camera. So "north" — the sprite
 * sheet's row 0, the back view walking away from the viewer — is -z.
 *
 * The hysteresis cases are the ones that matter in play: a unit walking almost
 * due north has a direction vector that jitters either side of the N/NE
 * boundary every tick, and without damping the sprite strobes between two
 * frames. That reads as a graphical fault, not as movement.
 */

describe('FACINGS', () => {
  it('is the eight compass points clockwise from north', () => {
    expect(FACINGS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])
  })
})

describe('facingFromVector', () => {
  it('maps -z to north (walking away from the camera)', () => {
    expect(facingFromVector(0, -1)).toBe('N')
  })

  it('maps +z to south (walking toward the camera)', () => {
    expect(facingFromVector(0, 1)).toBe('S')
  })

  it('maps +x to east and -x to west', () => {
    expect(facingFromVector(1, 0)).toBe('E')
    expect(facingFromVector(-1, 0)).toBe('W')
  })

  it('maps the four diagonals', () => {
    expect(facingFromVector(1, -1)).toBe('NE')
    expect(facingFromVector(1, 1)).toBe('SE')
    expect(facingFromVector(-1, 1)).toBe('SW')
    expect(facingFromVector(-1, -1)).toBe('NW')
  })

  it('is unaffected by vector magnitude', () => {
    expect(facingFromVector(0, -0.001)).toBe('N')
    expect(facingFromVector(0, -9999)).toBe('N')
  })

  it('assigns every angle to exactly one of the eight sectors', () => {
    for (let deg = 0; deg < 360; deg += 1) {
      const r = (deg * Math.PI) / 180
      const f = facingFromVector(Math.sin(r), -Math.cos(r))
      expect(FACINGS).toContain(f)
    }
  })

  it('gives each sector a 45-degree span', () => {
    const counts = new Map<string, number>()
    for (let deg = 0; deg < 3600; deg += 1) {
      const r = (deg / 10 * Math.PI) / 180
      const f = facingFromVector(Math.sin(r), -Math.cos(r))
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    for (const f of FACINGS) {
      // 3600 samples over 8 sectors = 450 each; allow a little slack.
      expect(counts.get(f)).toBeGreaterThan(400)
      expect(counts.get(f)).toBeLessThan(500)
    }
  })

  it('falls back to a stated default for a zero vector rather than NaN', () => {
    expect(FACINGS).toContain(facingFromVector(0, 0))
  })

  it('handles non-finite input without throwing', () => {
    expect(() => facingFromVector(Number.NaN, 1)).not.toThrow()
    expect(FACINGS).toContain(facingFromVector(Number.NaN, Number.NaN))
  })
})

describe('stableFacing', () => {
  it('keeps the current facing for a tiny wobble across a sector boundary', () => {
    // Almost due north, drifting a hair east of the N/NE boundary.
    const jitter = facingFromVector(0.05, -1)
    expect(stableFacing('N', 0.05, -1)).toBe('N')
    // Without hysteresis the raw mapping may already disagree — that is the point.
    expect(['N', 'NE']).toContain(jitter)
  })

  it('does switch once the direction genuinely changes', () => {
    expect(stableFacing('N', 1, 0)).toBe('E')
    expect(stableFacing('N', 0, 1)).toBe('S')
  })

  it('does not strobe when a vector oscillates around a boundary', () => {
    // Simulate a unit walking almost due north, jittering each tick.
    let facing = 'N' as (typeof FACINGS)[number]
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const wobble = (i % 2 === 0 ? 1 : -1) * 0.08
      facing = stableFacing(facing, wobble, -1)
      seen.add(facing)
    }
    expect(seen.size).toBe(1)
  })

  it('settles on the new facing after a sustained turn', () => {
    let facing = 'N' as (typeof FACINGS)[number]
    for (let i = 0; i < 10; i++) facing = stableFacing(facing, 1, -0.2)
    expect(facing).toBe('E')
  })

  it('keeps the current facing when the entity stops moving', () => {
    // A stationary unit must not snap back to a default direction.
    expect(stableFacing('W', 0, 0)).toBe('W')
  })

  it('accepts any of the eight as a starting facing', () => {
    for (const f of FACINGS) expect(FACINGS).toContain(stableFacing(f, 0, 0))
  })
})
