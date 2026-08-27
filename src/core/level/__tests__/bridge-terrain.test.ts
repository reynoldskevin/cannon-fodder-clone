import { describe, it, expect } from 'vitest'
import {
  TERRAIN,
  canFireFromTerrain,
  speedMultiplierForTerrain,
  traversalForTerrain,
} from '../terrain'
import { ALL_TRAVERSAL, INFANTRY, VEHICLE } from '../../pathing/traversal-mask'

/**
 * Ticket 033 — what a bridge IS to the simulation.
 *
 * All three answers below are the table's DEFAULT answer, and that is exactly
 * why they are asserted rather than assumed. A default is what you get when
 * nobody has thought about the case; these are what you get when somebody has,
 * and the two are indistinguishable from the code. If a later ticket gives
 * bridges a rule of their own — a plank that slows a vehicle, a rope bridge that
 * cannot be fired from — these tests are what says the current answers were
 * chosen.
 */

describe('a bridge admits everything a road does', () => {
  it('carries vehicles, which is the whole structural point of it', () => {
    /**
     * Ticket 003a made water `INFANTRY`-only and wrote down why while no vehicle
     * existed: a bridge that saves a man a few seconds is scenery, and a bridge
     * that is the only way a vehicle ever crosses is level design — and that
     * cannot be reconstructed later from a map on which every crossing was
     * equally passable. This is the other end of that sentence.
     */
    expect(traversalForTerrain(TERRAIN.BRIDGE)).toBe(ALL_TRAVERSAL)
    expect(traversalForTerrain(TERRAIN.BRIDGE) & VEHICLE).not.toBe(0)
    expect(traversalForTerrain(TERRAIN.WATER)).toBe(INFANTRY)
    expect(traversalForTerrain(TERRAIN.WATER) & VEHICLE).toBe(0)
  })

  it('is crossed at full speed — you do not wade over a bridge', () => {
    expect(speedMultiplierForTerrain(TERRAIN.BRIDGE)).toBe(1)
    expect(speedMultiplierForTerrain(TERRAIN.WATER)).toBeLessThan(1)
  })

  it('and can be fought on, which is what makes crossing it the safe option', () => {
    /**
     * Ticket 007b disarmed swimmers so that crossing under fire is a commitment
     * rather than a slower walk. That trade only exists if the bridge is the
     * side of it where you can shoot back.
     */
    expect(canFireFromTerrain(TERRAIN.BRIDGE)).toBe(true)
    expect(canFireFromTerrain(TERRAIN.WATER)).toBe(false)
  })
})

describe('and none of this disturbs the open-enum fallback', () => {
  it('an id from a newer importer still passes, moves and fights', () => {
    /**
     * `TileId` is an open enum by design — `types.ts` states that adding one
     * must never be a schema break. Every lookup here has to keep a neutral
     * answer for an id it has never seen, or a level from a newer importer
     * quietly loses its far half to a build that is merely out of date: a map
     * that looks intact and cannot be finished.
     */
    const future = 99
    expect(traversalForTerrain(future)).toBe(ALL_TRAVERSAL)
    expect(speedMultiplierForTerrain(future)).toBe(1)
    expect(canFireFromTerrain(future)).toBe(true)
  })

  it('and the ids that already had answers still have the same ones', () => {
    // Bridge is a NEW id, not a renumbering. A drift here moves every tile on
    // every published level.
    expect({ ...TERRAIN }).toEqual({
      UNKNOWN: 0,
      GRASS: 1,
      CANOPY: 2,
      ROCK: 3,
      WATER: 4,
      BRIDGE: 5,
    })
  })
})
