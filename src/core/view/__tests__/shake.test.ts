import { describe, it, expect } from 'vitest'
import { shakeFor, SHAKE_REACH_TILES } from '../shake'

/**
 * Ticket 025 — how hard a blast shakes the camera.
 *
 * `camera-rig.ts` has had a shake channel since ticket 013 — `shake(amount)`,
 * taking the strongest request, with the decay already in `core/view` — and
 * NOTHING HAS EVER CALLED IT. This is the number that finally does.
 *
 * A PURE FUNCTION OF DISTANCE AND SIZE, which is what makes it testable without
 * a camera at all. The rig owns the decay and the displacement; this owns only
 * "how much".
 */

describe('a blast shakes harder the closer it is', () => {
  it('hardest under the camera centre', () => {
    expect(shakeFor(0, 3)).toBeGreaterThan(shakeFor(5, 3))
  })

  it('and falls off monotonically all the way out', () => {
    // Monotonic rather than merely "less at the far end": a curve that dipped
    // and rose again would produce a blast that shook more from further away,
    // which reads as the camera being broken rather than as distance.
    let previous = Infinity
    for (let d = 0; d <= SHAKE_REACH_TILES * 1.5; d += 0.5) {
      const amount = shakeFor(d, 3)
      expect({ d, ok: amount <= previous }).toEqual({ d, ok: true })
      previous = amount
    }
  })

  it('reaching nothing at all past its reach', () => {
    /**
     * A detonation the player cannot see must not move the camera. Without a
     * floor, a mortar at the far corner of level 2 nudges the view every time it
     * lands, and the player reads it as a rendering fault — there is nothing on
     * screen that explains it.
     */
    expect(shakeFor(SHAKE_REACH_TILES, 3)).toBe(0)
    expect(shakeFor(SHAKE_REACH_TILES * 4, 3)).toBe(0)
  })
})

describe('and harder the bigger it is', () => {
  it('a wider blast shakes more than a small one at the same distance', () => {
    expect(shakeFor(2, 6)).toBeGreaterThan(shakeFor(2, 1))
  })

  it('but a zero-radius blast still does nothing', () => {
    // Ordnance with no blast is not an explosion, and must not become one here.
    expect(shakeFor(0, 0)).toBe(0)
  })
})

describe('it is bounded, because the rig trusts it', () => {
  it('never leaves [0, 1], however absurd the inputs', () => {
    /**
     * `CameraRig.shake` clamps too, but a value out of range here would already
     * have lost the `Math.max` comparison it is fed through — the strongest
     * request wins, so an unclamped 40 from one grenade would pin the camera at
     * maximum for the whole decay and nothing quieter could ever be heard again.
     */
    const inputs = [-5, 0, 0.5, 3, 1e6, SHAKE_REACH_TILES]
    for (const d of inputs) {
      for (const r of inputs) {
        const amount = shakeFor(d, r)
        expect({ d, r, ok: amount >= 0 && amount <= 1 }).toEqual({ d, r, ok: true })
      }
    }
  })

  it('and survives nonsense without returning NaN', () => {
    /**
     * A NaN reaching the rig wins its `Math.max` against every real request and
     * then poisons the camera's position for the rest of the mission — the
     * quietest possible catastrophic failure. Written with positive comparisons
     * for the reason `resolution.ts` gives at length.
     */
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(shakeFor(bad, 3))).toBe(true)
      expect(Number.isFinite(shakeFor(3, bad))).toBe(true)
    }
  })

  it('and a negative distance is treated as no distance, not as beyond the reach', () => {
    // Distance is a magnitude; a negative one is a caller bug, and the safe
    // answer is the one at the origin rather than silently no shake at all.
    expect(shakeFor(-1, 3)).toBe(shakeFor(0, 3))
  })
})
