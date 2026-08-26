import { describe, it, expect } from 'vitest'
import { planTrajectory, positionAt } from '../ballistics'
import type { OrdnanceSpec } from '../table'

/**
 * Ticket 015 — flight, as pure arithmetic.
 *
 * NO GRID, NO WORLD, NO CLOCK. Where a projectile is at tick n is a function of
 * where it was launched from, where it was aimed, and the spec it was launched
 * with — nothing else. That is what makes the arc assertable by inspection here
 * and what keeps the cover clamp (which genuinely does need the grid) in the
 * system, where it belongs.
 *
 * TIME IS TICKS and speed is tiles per tick, exactly as `combat/weapons.ts`
 * measures a cooldown. A projectile whose flight was expressed in seconds would
 * have to be converted somewhere, and that rounding decision is what makes two
 * machines replay the same mission differently.
 */

const spec = (over: Partial<OrdnanceSpec>): OrdnanceSpec => ({
  name: 'test',
  arc: 'ballistic',
  speedTilesPerTick: 0.25,
  fuseTicks: 120,
  blastRadiusTiles: 2,
  peakDamage: 10,
  falloff: 'linear',
  cooldownTicks: 30,
  ammoCost: 1,
  damagesFriendlies: true,
  ...over,
})

const BALLISTIC = spec({ arc: 'ballistic' })
const FLAT = spec({ arc: 'flat', speedTilesPerTick: 1 })

describe('a ballistic projectile arcs and lands where it was aimed', () => {
  it('starts at the muzzle, on the ground', () => {
    const t = planTrajectory(BALLISTIC, 1, -2, 4, 0)
    const start = positionAt(t, 0)
    expect(start.x).toBeCloseTo(1, 12)
    expect(start.z).toBeCloseTo(-2, 12)
    expect(start.y).toBeCloseTo(0, 12)
  })

  it('lands exactly on the aim point', () => {
    // THE WHOLE POINT OF SOLVING THE ARC. A grenade that lands "somewhere near"
    // where it was thrown is a grenade the player cannot aim, and the blast
    // radius would be covering for the error rather than being the mechanic.
    const t = planTrajectory(BALLISTIC, -3, 2, 5, -6)
    const end = positionAt(t, t.flightTicks)
    expect(end.x).toBeCloseTo(5, 9)
    expect(end.z).toBeCloseTo(-6, 9)
  })

  it('is back on the ground when it lands, not still in the air', () => {
    const t = planTrajectory(BALLISTIC, 0, 0, 7, 3)
    expect(positionAt(t, t.flightTicks).y).toBeCloseTo(0, 9)
  })

  it('is genuinely in the air in between', () => {
    // Without this, a "ballistic" projectile that simply slid along the ground
    // would satisfy every endpoint assertion above.
    const t = planTrajectory(BALLISTIC, 0, 0, 8, 0)
    expect(positionAt(t, t.flightTicks / 2).y).toBeGreaterThan(0)
  })

  it('is above the ground at every interior moment of its flight', () => {
    const t = planTrajectory(BALLISTIC, 0, 0, 6, 0)
    const heights: number[] = []
    for (let i = 1; i < t.flightTicks; i += 1) heights.push(positionAt(t, i).y)
    expect(heights.length).toBeGreaterThan(2)
    expect(heights.every((h) => h > 0)).toBe(true)
  })

  it('peaks in the middle, not at either end', () => {
    const t = planTrajectory(BALLISTIC, 0, 0, 10, 0)
    let peakAt = 0
    let peak = -Infinity
    for (let i = 0; i <= t.flightTicks; i += 0.25) {
      const y = positionAt(t, i).y
      if (y > peak) {
        peak = y
        peakAt = i
      }
    }
    expect(peakAt).toBeCloseTo(t.flightTicks / 2, 1)
  })

  it('throws a longer distance higher', () => {
    // The readable consequence of a real gravity term: reaching further means
    // hanging in the air longer, which means climbing higher on the way.
    const near = planTrajectory(BALLISTIC, 0, 0, 3, 0)
    const far = planTrajectory(BALLISTIC, 0, 0, 12, 0)
    expect(positionAt(far, far.flightTicks / 2).y).toBeGreaterThan(
      positionAt(near, near.flightTicks / 2).y,
    )
  })

  it('travels a straight line in plan view — it arcs upward, not sideways', () => {
    // A grenade curving in X/Z would be a mortar shell with windage, and the
    // player aiming it would have no way to predict where it goes.
    const t = planTrajectory(BALLISTIC, 0, 0, 8, 4)
    for (let i = 0; i <= t.flightTicks; i += 1) {
      const p = positionAt(t, i)
      // The line from (0,0) to (8,4) is z = x / 2.
      expect(p.z).toBeCloseTo(p.x / 2, 9)
    }
  })
})

describe('a flat projectile does not arc at all', () => {
  it('stays on the ground for the whole flight', () => {
    // `Math.abs` so a computed `-0` — which a gravity term multiplied by zero
    // produces — reads as the zero it is rather than failing on `Object.is`.
    const t = planTrajectory(FLAT, 0, 0, 9, 0)
    for (let i = 0; i <= t.flightTicks; i += 1) {
      expect({ i, y: Math.abs(positionAt(t, i).y) }).toEqual({ i, y: 0 })
    }
  })

  it('covers equal ground in equal time', () => {
    // Constant velocity, which is what "flat" means mechanically: a rocket does
    // not slow down and does not drop.
    const t = planTrajectory(FLAT, 0, 0, 8, 0)
    const a = positionAt(t, 1).x - positionAt(t, 0).x
    const b = positionAt(t, 3).x - positionAt(t, 2).x
    expect(a).toBeCloseTo(b, 9)
    expect(a).toBeGreaterThan(0)
  })

  it('still lands exactly on the aim point', () => {
    const t = planTrajectory(FLAT, 2, -1, -6, 5)
    const end = positionAt(t, t.flightTicks)
    expect(end.x).toBeCloseTo(-6, 9)
    expect(end.z).toBeCloseTo(5, 9)
  })
})

describe('flight time comes from speed and distance', () => {
  it('a faster projectile arrives sooner', () => {
    const slow = planTrajectory(spec({ speedTilesPerTick: 0.2 }), 0, 0, 10, 0)
    const fast = planTrajectory(spec({ speedTilesPerTick: 2 }), 0, 0, 10, 0)
    expect(fast.flightTicks).toBeLessThan(slow.flightTicks)
  })

  it('a further target takes longer', () => {
    const near = planTrajectory(BALLISTIC, 0, 0, 2, 0)
    const far = planTrajectory(BALLISTIC, 0, 0, 20, 0)
    expect(far.flightTicks).toBeGreaterThan(near.flightTicks)
  })

  it('is a whole number of ticks, because the sim has no half ticks', () => {
    for (const d of [1, 3, 7, 9.5, 13.25]) {
      const t = planTrajectory(BALLISTIC, 0, 0, d, 0)
      expect({ d, integer: Number.isInteger(t.flightTicks) }).toEqual({ d, integer: true })
    }
  })

  it('never takes less than a tick, however short the throw', () => {
    // A flight of zero ticks divides by zero when the arc is solved and detonates
    // the projectile inside the tick that launched it — before anything has had a
    // chance to see it exist.
    const t = planTrajectory(BALLISTIC, 4, 4, 4, 4)
    expect(t.flightTicks).toBeGreaterThanOrEqual(1)
  })
})

describe('hostile inputs, because a table is data somebody will get wrong', () => {
  it('a zero-length throw produces a finite trajectory, not NaN', () => {
    // Right-clicking the tile you are standing on. There is no direction, and
    // `NaN` here would propagate into a blast centre and damage nobody anywhere.
    const t = planTrajectory(BALLISTIC, 3, -2, 3, -2)
    for (let i = 0; i <= t.flightTicks; i += 1) {
      const p = positionAt(t, i)
      expect({ i, finite: Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) })
        .toEqual({ i, finite: true })
    }
    const end = positionAt(t, t.flightTicks)
    expect(end.x).toBeCloseTo(3, 9)
    expect(end.z).toBeCloseTo(-2, 9)
  })

  it('a non-positive speed still arrives, rather than flying forever', () => {
    // `ceil(distance / 0)` is Infinity, and a projectile with an infinite flight
    // time never detonates, never expires and never leaves the in-flight array —
    // a leak that looks exactly like a grenade that did nothing.
    for (const speedTilesPerTick of [0, -1]) {
      const t = planTrajectory(spec({ speedTilesPerTick }), 0, 0, 5, 0)
      expect({ speedTilesPerTick, finite: Number.isFinite(t.flightTicks) }).toEqual({
        speedTilesPerTick,
        finite: true,
      })
      expect(t.flightTicks).toBeGreaterThanOrEqual(1)
    }
  })

  it('reading past the landing clamps to the impact point rather than burrowing', () => {
    // The renderer interpolates with a fractional tick and can legitimately ask
    // about a moment just past impact on a long frame. Un-clamped, the arc's
    // parabola continues downward and the last frame of a grenade is drawn under
    // the map.
    const t = planTrajectory(BALLISTIC, 0, 0, 6, 0)
    const past = positionAt(t, t.flightTicks + 5)
    expect(past.x).toBeCloseTo(6, 9)
    expect(past.z).toBeCloseTo(0, 9)
    expect(past.y).toBeCloseTo(0, 9)
  })

  it('reading before the launch clamps to the muzzle', () => {
    const t = planTrajectory(BALLISTIC, 1, 1, 6, 0)
    const before = positionAt(t, -3)
    expect(before.x).toBeCloseTo(1, 12)
    expect(before.z).toBeCloseTo(1, 12)
    expect(before.y).toBeCloseTo(0, 12)
  })
})

describe('a trajectory is a value, and reading it does not change it', () => {
  it('answers the same twice for the same tick', () => {
    const t = planTrajectory(BALLISTIC, 0, 0, 7, 2)
    expect(positionAt(t, 3)).toEqual(positionAt(t, 3))
  })

  it('hands back a fresh point each time, not one shared buffer', () => {
    // The trap the tracer buffer already caught once: reusing one point object
    // is the obvious allocation win, and it means a caller holding two samples
    // is holding the same sample twice.
    const t = planTrajectory(BALLISTIC, 0, 0, 7, 2)
    const a = positionAt(t, 1)
    const b = positionAt(t, 5)
    expect(a).not.toBe(b)
    expect(a).not.toEqual(b)
  })
})
