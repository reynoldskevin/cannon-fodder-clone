import { describe, it, expect } from 'vitest'
import { panFor, gainFor, AUDIO_REACH_TILES } from '../index'

/**
 * Ticket 027 — where a sound sits in the stereo field, and how loud it is.
 *
 * A SCREEN-SPACE QUESTION WITH A WORLD-SPACE INPUT, kept pure by passing the
 * camera's centre and half-width rather than a camera. `core` may not import the
 * renderer, and the curve is worth testing without one anyway.
 *
 * THE ASSETS FORCE A DECISION HERE. Every file shipped is STEREO, and a
 * `StereoPannerNode` cannot place a stereo source — the image it already has
 * fights the pan. So `src/audio` downmixes positional cues to mono at decode;
 * these numbers assume it did.
 */

const HALF = 10

describe('pan follows the screen', () => {
  it('dead centre is dead centre', () => {
    expect(panFor(0, 0, HALF)).toBe(0)
  })

  it('right of the camera pans right, left pans left', () => {
    expect(panFor(5, 0, HALF)).toBeGreaterThan(0)
    expect(panFor(-5, 0, HALF)).toBeLessThan(0)
  })

  it('and it is symmetric about the centre', () => {
    // An asymmetric pan puts the same event in different places depending on
    // which way the player happened to walk into it.
    expect(panFor(3, 0, HALF)).toBeCloseTo(-panFor(-3, 0, HALF), 10)
  })

  it('following the camera rather than the world origin', () => {
    // The same world point is on the left or the right depending on where the
    // camera is looking. A pan measured from the origin would put every sound on
    // the same side for a whole mission.
    expect(panFor(5, 8, HALF)).toBeLessThan(0)
    expect(panFor(5, 0, HALF)).toBeGreaterThan(0)
  })

  it('and is clamped hard at both ears', () => {
    /**
     * `StereoPannerNode.pan` is documented as `[-1, 1]` and THROWS on a value
     * outside it. A sound from four screens away is not more-than-fully-left; it
     * is fully left, or — better — inaudible, which is `gainFor`'s job.
     */
    for (const x of [-1e6, -HALF * 3, HALF * 3, 1e6]) {
      const pan = panFor(x, 0, HALF)
      expect({ x, ok: pan >= -1 && pan <= 1 }).toEqual({ x, ok: true })
    }
  })

  it('and never returns NaN, whatever it is handed', () => {
    // A NaN reaching `AudioParam.value` throws, and it would throw from inside a
    // frame that was only trying to play a rifle shot.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(panFor(bad, 0, HALF))).toBe(true)
      expect(Number.isFinite(panFor(0, bad, HALF))).toBe(true)
      expect(Number.isFinite(panFor(0, 0, bad))).toBe(true)
    }
    // A zero-width camera has no field to place anything in; centre is the only
    // answer that is not a division by zero.
    expect(panFor(5, 0, 0)).toBe(0)
  })
})

describe('gain falls off with distance', () => {
  it('loudest under the camera', () => {
    expect(gainFor(0)).toBeGreaterThan(gainFor(5))
  })

  it('monotonically, all the way out', () => {
    let previous = Infinity
    for (let d = 0; d <= AUDIO_REACH_TILES * 1.5; d += 0.5) {
      const gain = gainFor(d)
      expect({ d, ok: gain <= previous }).toEqual({ d, ok: true })
      previous = gain
    }
  })

  it('reaching silence past its reach, so an off-screen firefight is not heard', () => {
    /**
     * Level 2 fields fifteen enemies across ninety-two tiles. Without a floor,
     * every round fired anywhere on the map is audible at some tiny volume, and
     * fifteen men fighting off-screen is a constant wash the player cannot act
     * on and cannot locate.
     */
    expect(gainFor(AUDIO_REACH_TILES)).toBe(0)
    expect(gainFor(AUDIO_REACH_TILES * 10)).toBe(0)
  })

  it('and stays inside [0, 1] on anything', () => {
    for (const d of [-5, 0, 1, AUDIO_REACH_TILES, 1e6, NaN, Infinity]) {
      const gain = gainFor(d)
      expect({ d, ok: gain >= 0 && gain <= 1 }).toEqual({ d, ok: true })
    }
  })

  it('treating a negative distance as no distance', () => {
    // Distance is a magnitude. A negative one is a caller bug, and silence is
    // the wrong answer to it — a cue that vanished would look like a missing
    // asset rather than a bad argument.
    expect(gainFor(-3)).toBe(gainFor(0))
  })
})
