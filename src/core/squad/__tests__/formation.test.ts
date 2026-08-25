import { describe, it, expect } from 'vitest'
import { scene } from './fixture'

/**
 * Ticket 007 — formation follow.
 *
 * WHAT "FORMATION" HAS TO MEAN TO BE WORTH HAVING. Three properties, and all
 * three are independently breakable:
 *
 *   1. The squad ARRIVES. A follower that tracks its slot perfectly while the
 *      leader never reaches the target is a formation of stationary men.
 *   2. The slots are BEHIND the leader, whichever way it is walking. A wedge
 *      welded to world north looks correct for exactly one order and then
 *      marches the squad in front of its own leader on the way back.
 *   3. Nobody OVERLAPS. Cannon Fodder's squad reads as several men because you
 *      can count them; stacked sprites read as one man with a bad shadow.
 *
 * Assertions are on tile positions after enough ticks to settle, not on internal
 * steering vectors — the steering is the implementer's to choose, the resulting
 * arrangement is not.
 */

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

/** 3 tiles/sec at a 1/60 timestep is 0.05 tiles a tick — 240 ticks is 12 tiles of travel. */
const OPTS = { speedTilesPerSecond: 3, separationRadius: 0.6, slotSpacing: 0.9 } as const

describe('a squad under a move order', () => {
  it('walks its leader to the ordered tile', () => {
    const s = scene(OPEN, OPTS)
    const a = s.spawn(2, 5)
    s.squad.order([a.id], { x: 16, y: 5 })
    s.run(400)
    const p = s.tileOf(a.id)
    expect(p.x).toBeCloseTo(16, 0)
    expect(p.y).toBeCloseTo(5, 0)
  })

  it('brings its followers along', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(2, 5), s.spawn(2, 6), s.spawn(2, 4)].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 5 })
    s.run(400)
    for (const id of ids) {
      // Not "on the target" — followers hold slots BEHIND it. Near it.
      expect(s.tileOf(id).x).toBeGreaterThan(12)
    }
  })

  it('does not leave anyone standing at the start line', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(2, 5), s.spawn(2, 6), s.spawn(2, 4), s.spawn(3, 5)].map((e) => e.id)
    const before = ids.map((id) => s.tileOf(id).x)
    s.squad.order(ids, { x: 16, y: 5 })
    s.run(400)
    ids.forEach((id, i) => {
      expect(s.tileOf(id).x).toBeGreaterThan(before[i]! + 5)
    })
  })

  it('does nothing at all without an order', () => {
    // The system must be inert until commanded. A squad that drifts on spawn is
    // a squad that has walked into the enemy before the player has clicked.
    const s = scene(OPEN, OPTS)
    const a = s.spawn(2, 5)
    const b = s.spawn(3, 5)
    const before = [s.tileOf(a.id), s.tileOf(b.id)]
    s.run(120)
    expect([s.tileOf(a.id), s.tileOf(b.id)]).toEqual(before)
  })
})

describe('slots rotate with the leader', () => {
  /** Settle a squad walking toward `target` and report each unit's tile. */
  function marchTo(target: { x: number; y: number }): { lead: { x: number; y: number }; rest: { x: number; y: number }[] } {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(10, 5), s.spawn(10, 6), s.spawn(10, 4)].map((e) => e.id)
    s.squad.order(ids, target)
    s.run(200)
    return { lead: s.tileOf(ids[0]!), rest: [s.tileOf(ids[1]!), s.tileOf(ids[2]!)] }
  }

  it('puts followers WEST of the leader when the squad walks east', () => {
    const { lead, rest } = marchTo({ x: 18, y: 5 })
    for (const r of rest) expect(r.x).toBeLessThan(lead.x)
  })

  it('puts followers EAST of the leader when the squad walks west', () => {
    const { lead, rest } = marchTo({ x: 1, y: 5 })
    for (const r of rest) expect(r.x).toBeGreaterThan(lead.x)
  })

  it('puts followers NORTH of the leader when the squad walks south', () => {
    // +y is south in tile space. Walking south means the tail is at lower y.
    const { lead, rest } = marchTo({ x: 10, y: 9 })
    for (const r of rest) expect(r.y).toBeLessThan(lead.y)
  })

  it('puts followers SOUTH of the leader when the squad walks north', () => {
    const { lead, rest } = marchTo({ x: 10, y: 1 })
    for (const r of rest) expect(r.y).toBeGreaterThan(lead.y)
  })
})

describe('separation', () => {
  it('unstacks units spawned on the same tile', () => {
    // The degenerate case, and the one that actually happens: two spawns round
    // to the same tile and the squad renders as one soldier.
    const s = scene(OPEN, { ...OPTS, separationRadius: 0.6 })
    const a = s.spawn(5, 5)
    const b = s.spawn(5, 5)
    const c = s.spawn(5, 5)
    expect(s.gap(a.id, b.id)).toBe(0) // non-vacuous: they really do start stacked
    s.squad.order([a.id, b.id, c.id], { x: 15, y: 5 })
    s.run(300)
    expect(s.gap(a.id, b.id)).toBeGreaterThan(0.27)
    expect(s.gap(a.id, c.id)).toBeGreaterThan(0.27)
    expect(s.gap(b.id, c.id)).toBeGreaterThan(0.27)
  })

  it('keeps a marching squad spread out', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 5), s.spawn(3, 6), s.spawn(3, 4), s.spawn(2, 5), s.spawn(2, 6)].map(
      (e) => e.id,
    )
    s.squad.order(ids, { x: 17, y: 5 })
    // Checked EVERY tick, not just at the end: a squad that briefly collapses
    // through itself mid-march and re-spreads on arrival looks broken in motion
    // and perfect in a final-state assertion.
    for (let t = 0; t < 300; t++) {
      s.run(1)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          expect(s.gap(ids[i]!, ids[j]!)).toBeGreaterThan(0.2)
        }
      }
    }
  })

  /** Smallest pairwise gap once a squad ordered a short distance has settled. */
  function settledMinGap(slotSpacing: number, separationRadius: number): number {
    const s = scene(OPEN, { ...OPTS, slotSpacing, separationRadius })
    const ids = [s.spawn(6, 5), s.spawn(6, 5), s.spawn(6, 5), s.spawn(6, 5)].map((e) => e.id)
    s.squad.order(ids, { x: 8, y: 5 })
    s.run(600)
    let min = Infinity
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) min = Math.min(min, s.gap(ids[i]!, ids[j]!))
    }
    return min
  }

  it('opens the gap beyond what the formation geometry alone would give', () => {
    // THE TEST THAT ACTUALLY BITES, and the reason it is shaped so awkwardly.
    //
    // The obvious version — settle a squad at the default spacing and assert the
    // gaps are near the separation radius — is VACUOUS, and was in this file
    // until it was measured. At the defaults the settled minimum gap is decided
    // entirely by the wedge: `slotSpacing * hypot(1, WEDGE_SPREAD)`, about 1.10
    // tiles, which already exceeds any sane radius. Measured at radii 0.6, 1e-9
    // and 0, that gap is 1.098590 every time — identical to six decimal places.
    // An implementation with separation DELETED passes it.
    //
    // Separation is only observable where the slots themselves are tighter than
    // the radius, so that is the configuration to test in. At `slotSpacing` 0.3
    // the wedge alone gives 0.366; separation must push past that.
    const geometryOnly = settledMinGap(0.3, 0)
    const withSeparation = settledMinGap(0.3, 0.6)
    expect(geometryOnly).toBeCloseTo(0.3 * Math.hypot(1, 0.7), 2)
    expect(withSeparation).toBeGreaterThan(geometryOnly + 0.08)
  })

  it('opens the gap further as the separation radius grows', () => {
    // Scaling, not just presence: a fixed nudge that ignores the configured
    // radius would satisfy the test above and still be wrong.
    const small = settledMinGap(0.3, 0.2)
    const large = settledMinGap(0.3, 0.9)
    expect(large).toBeGreaterThan(small)
  })

  it('does not blow the squad apart', () => {
    // Separation that never relents is a squad that expands forever. The men
    // must stay a squad — within a few tiles of their leader.
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(5, 5), s.spawn(5, 5), s.spawn(5, 5), s.spawn(5, 5)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 5 })
    s.run(400)
    for (const id of ids.slice(1)) {
      expect(s.gap(ids[0]!, id)).toBeLessThan(4)
    }
  })
})

describe('arrival', () => {
  it('settles instead of orbiting the target forever', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 5), s.spawn(3, 6), s.spawn(3, 4)].map((e) => e.id)
    s.squad.order(ids, { x: 12, y: 5 })
    s.run(400)
    const settled = ids.map((id) => s.tileOf(id))
    s.run(120)
    ids.forEach((id, i) => {
      const now = s.tileOf(id)
      // A unit that has arrived may still be nudged by separation, but it must
      // not be travelling: two seconds later it is essentially where it was.
      expect(Math.hypot(now.x - settled[i]!.x, now.y - settled[i]!.y)).toBeLessThan(0.35)
    })
  })

  it('re-targets on a second order', () => {
    const s = scene(OPEN, OPTS)
    const a = s.spawn(3, 5)
    s.squad.order([a.id], { x: 15, y: 5 })
    s.run(200)
    s.squad.order([a.id], { x: 3, y: 5 })
    s.run(400)
    expect(s.tileOf(a.id).x).toBeCloseTo(3, 0)
  })
})
