import { describe, expect, it } from 'vitest'
import { CameraRig } from '../camera-rig'
import type { WorldBounds } from '../../core/view/projection'

/**
 * Ticket 087 — the game starts closer in.
 *
 * TESTED THROUGH THE RIG, NOT THE CONSTANT. `DEFAULT_VIEW_HEIGHT` is private to
 * `camera-rig.ts` and exporting it just to assert on it would test the spelling
 * of a number rather than the thing the player sees. What the ticket promises is
 * the height the rig BOOTS at, after its constructor has run `resize` and both
 * clamps — so that is what every case here reads, off the public `zoom` getter.
 *
 * NO WEBGL IS INVOLVED. `CameraRig` builds an `OrthographicCamera` and nothing
 * else, which is pure maths in Three.js, so this runs in Vitest's node
 * environment like the rest of `src/render/__tests__`.
 */

/** The default the ticket asks for, in world units of viewport height. */
const EXPECTED_DEFAULT = 12

/** A level far too big for the sky-free cap to bite at 12 tiles of viewport. */
const BIG_LEVEL: WorldBounds = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }

/** A 16:9 window, which is what almost everybody plays in. */
const WIDESCREEN = { width: 1920, height: 1080 }

describe('the default zoom', () => {
  it('boots at twelve world units of viewport height', () => {
    const rig = new CameraRig(BIG_LEVEL, WIDESCREEN)

    expect(rig.zoom.viewHeight).toBeCloseTo(EXPECTED_DEFAULT, 6)
  })

  it('boots strictly inside the legal range, so nothing is clamped at startup', () => {
    const rig = new CameraRig(BIG_LEVEL, WIDESCREEN)

    expect(rig.zoom.viewHeight).toBeGreaterThan(rig.zoom.min)
    expect(rig.zoom.viewHeight).toBeLessThan(rig.zoom.max)
  })

  it('leaves the closest zoom the player may reach at ten', () => {
    const rig = new CameraRig(BIG_LEVEL, WIDESCREEN)

    expect(rig.zoom.min).toBeCloseTo(10, 6)
  })

  it('is closer than the sixteen units the camera used to start at', () => {
    const rig = new CameraRig(BIG_LEVEL, WIDESCREEN)

    expect(rig.zoom.viewHeight).toBeLessThan(16)
  })

  it('still yields to the sky-free cap on a level too small to frame at twelve', () => {
    // Small enough that showing twelve units of viewport height would put
    // background on screen; the cap, not the default, decides the boot height.
    const smallLevel: WorldBounds = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 }

    const rig = new CameraRig(smallLevel, WIDESCREEN)

    expect(rig.zoom.max).toBeLessThan(EXPECTED_DEFAULT)
    expect(rig.zoom.viewHeight).toBeCloseTo(rig.zoom.max, 6)
  })
})
