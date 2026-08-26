import { describe, it, expect } from 'vitest'
import { scene } from './fixture'
import { speedMultiplierForTerrain, TERRAIN } from '../../level'

/**
 * Ticket 007b — a man in the water moves slowly.
 *
 * Ticket 003a made the river passable, which was the difference between a
 * winnable level 2 and an unwinnable one. It also made the bridge pointless: a
 * crossing that costs nothing is a crossing nobody thinks about, and the
 * artwork is drawn around a decision. This is the cost.
 *
 * MEASURED AS DISTANCE COVERED, NOT AS TIME TO ARRIVE. Two men given the same
 * order over the same number of ticks, one across water and one across grass —
 * so the claim is about the ground rather than about a goal one of them might
 * reach early and stop at. A test that timed an arrival would also be measuring
 * `ARRIVED_EPSILON` and the formation settle.
 */

/** Eighteen wide: dry the whole way. */
const DRY = `
  ..................
  ..................
  ..................
  ..................
  ..................
`

/** The same map with the middle twelve columns flooded. */
const WET = `
  ..................
  ..................
  ...~~~~~~~~~~~~...
  ..................
  ..................
`

const OPTS = { speedTilesPerSecond: 3, separationRadius: 0.6 } as const

/** March one man east for `ticks` and report how far he got, in tiles. */
function distanceCovered(art: string, ticks: number): number {
  const s = scene(art, OPTS)
  const man = s.spawn(2, 2)
  s.squad.order([man.id], { x: 16, y: 2 })
  s.run(ticks)
  return s.tileOf(man.id).x - 2
}

describe('the water is slower than the bank', () => {
  it('a man crossing water covers less ground than the same man on grass', () => {
    /**
     * THE WHOLE TICKET IN ONE ASSERTION. Both men are ordered the same distance
     * on identical maps but for the flooded strip, and both are still short of
     * the goal when the clock stops — so neither has arrived and stopped, and
     * the only difference between them is what they are standing in.
     */
    const dry = distanceCovered(DRY, 120)
    const wet = distanceCovered(WET, 120)
    expect(wet).toBeLessThan(dry)
    // And by roughly the factor the table states, rather than by any amount at
    // all: a multiplier wired to some other number would pass a bare `<`.
    const slow = speedMultiplierForTerrain(TERRAIN.WATER)
    expect(wet).toBeGreaterThan(dry * slow * 0.8)
    expect(wet).toBeLessThan(dry * slow * 1.25)
  })

  it('and neither man has arrived, so this is about ground and not about goals', () => {
    // The precondition the case above rests on. If the dry man reached the goal
    // and stopped, "less ground" would be measuring his patience.
    expect(distanceCovered(DRY, 120)).toBeLessThan(14)
  })
})

describe('the multiplier itself', () => {
  it('slows water and leaves everything else alone', () => {
    expect(speedMultiplierForTerrain(TERRAIN.WATER)).toBeLessThan(1)
    for (const dry of [TERRAIN.GRASS, TERRAIN.ROCK, TERRAIN.CANOPY]) {
      expect({ dry, m: speedMultiplierForTerrain(dry) }).toEqual({ dry, m: 1 })
    }
  })

  it('is never zero, because a tile that stops a man dead is an obstacle', () => {
    /**
     * A speed of zero would be a second way to spell "impassable" — one that
     * PATHING CANNOT SEE. The flow field would happily route a squad into the
     * water and the man would stand in it for the rest of the mission, which
     * reads as a hang rather than as terrain. Impassability is
     * `traversalForTerrain`'s job and has exactly one spelling.
     */
    for (const id of [TERRAIN.WATER, TERRAIN.GRASS, TERRAIN.CANOPY, TERRAIN.ROCK, 999]) {
      expect({ id, positive: speedMultiplierForTerrain(id) > 0 }).toEqual({ id, positive: true })
    }
  })

  it('moves a tile id it has never heard of at full speed', () => {
    /**
     * The neutral answer, for the same reason `traversalForTerrain` returns
     * `ALL_TRAVERSAL`: `TileId` is an open enum, and a level from a newer
     * importer must not silently bog a squad down in terrain this build cannot
     * name.
     */
    for (const unknown of [99, 4096, -1]) {
      expect({ unknown, m: speedMultiplierForTerrain(unknown) }).toEqual({ unknown, m: 1 })
    }
  })
})

describe('he speeds up the moment he is out', () => {
  it('a man who has crossed moves at full speed again', () => {
    /**
     * The multiplier reads the tile the man is STANDING ON, not the one he is
     * heading for — so he accelerates on the tick he leaves the water, not a
     * tile early and not a tile late.
     *
     * Measured as the distance covered in the LAST stretch of a long march,
     * once he is well clear of the flooded strip, against the same stretch on
     * dry ground. A man permanently slowed by having once been wet would fall
     * behind here.
     */
    const s = scene(WET, OPTS)
    const man = s.spawn(2, 2)
    s.squad.order([man.id], { x: 16, y: 2 })
    // Far enough to be out of the water (it ends at column 14) but short of the
    // goal, so he is still marching at full stride.
    s.run(400)
    const before = s.tileOf(man.id).x
    expect(before).toBeGreaterThan(14)
    s.run(10)
    const wetManStride = s.tileOf(man.id).x - before

    const d = scene(DRY, OPTS)
    const dryMan = d.spawn(2, 2)
    d.squad.order([dryMan.id], { x: 16, y: 2 })
    d.run(400)
    const dryBefore = d.tileOf(dryMan.id).x
    d.run(10)
    const dryStride = d.tileOf(dryMan.id).x - dryBefore

    // Both are on grass for these ten ticks, so their strides must match.
    expect(wetManStride).toBeCloseTo(dryStride, 6)
  })
})

describe('a squad ordered into the river always makes progress', () => {
  it('a man standing in water still moves every tick', () => {
    // The other side of "never zero", through the system rather than the table:
    // a man who entered the water must not be stuck in it.
    const s = scene(WET, OPTS)
    const man = s.spawn(5, 2)
    s.squad.order([man.id], { x: 16, y: 2 })
    let last = s.tileOf(man.id).x
    let stalls = 0
    for (let t = 0; t < 60; t += 1) {
      s.run(1)
      const now = s.tileOf(man.id).x
      if (!(now > last)) stalls += 1
      last = now
    }
    expect(stalls).toBe(0)
  })
})

describe('a march is still deterministic', () => {
  it('two identical crossings end in the same place', () => {
    // The multiplier is a table lookup: no rng, no clock. Ticket 005's whole
    // guarantee runs through this.
    expect(distanceCovered(WET, 200)).toBe(distanceCovered(WET, 200))
  })
})
