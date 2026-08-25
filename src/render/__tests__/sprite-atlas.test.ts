import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { createUnitVisual, IDLE_CLIP, STATIC_CLIP, type SpriteManifest } from '../sprite-atlas'
import { createSession } from '../../core/session'
import { makeLevel } from '../../core/session/__tests__/fixture'
import { tileToWorld } from '../../core/view/projection'
import { frameAt, phaseOffset } from '../../core/render-state/animation'

/**
 * The atlas's clip resolution, against the REAL generated manifest.
 *
 * This file exists because of a bug it would have caught. `tools/spritegen`
 * emits three soldier animations — `walk`, `fire`, `die` — and no idle, so a
 * standing soldier was drawn with `walk`, which LOOPS. The whole squad jogged on
 * the spot whenever it was not going anywhere. Nothing was broken enough to
 * throw; it just looked wrong, which is the failure mode a rendering layer with
 * no tests specialises in.
 *
 * The real manifest rather than a hand-written one, deliberately: a fake would
 * assert that this code agrees with my idea of the pipeline's output, which is
 * the mismatch that is worth catching in the first place.
 */

const manifest = JSON.parse(
  readFileSync(
    new URL('../../../public/generated/sprites/sprites.manifest.json', import.meta.url).pathname,
    'utf8',
  ),
) as SpriteManifest

const visual = createUnitVisual(manifest, new THREE.Texture())

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

describe('the authored soldier clips', () => {
  it('has walk, fire and die', () => {
    for (const name of ['walk', 'fire', 'die']) {
      expect({ name, frames: visual.clip('soldier', name).frameCount }).toEqual({
        name,
        frames: 4,
      })
    }
  })

  it('loops walk, but not fire and not die', () => {
    // `fire` is ONE-SHOT: a trigger pull is a single recoil, not a cycle. As a
    // looping clip it also picked up the per-id phase offset, which starts each
    // man at an arbitrary point in his own recoil — so a burst showed whichever
    // frame the global clock happened to be on rather than the four in order.
    expect(visual.clip('soldier', 'walk').loop).toBe(true)
    expect(visual.clip('soldier', 'fire').loop).toBe(false)
    expect(visual.clip('soldier', 'die').loop).toBe(false)
  })

  it('has no authored idle — which is the whole problem', () => {
    // Asserted so that the synthetic idle below is understood as a derivation
    // rather than as something the pipeline emits.
    expect(Object.keys(manifest.units.soldier!.animations).sort()).toEqual(['die', 'fire', 'walk'])
  })
})

describe('the synthetic idle clip', () => {
  it('exists', () => {
    expect(visual.clip('soldier', 'idle').frameCount).toBe(1)
  })

  it('does not loop — one frame, held forever', () => {
    // A looping one-frame clip is harmless but dishonest; more to the point, if
    // frameCount ever grew back to 4 by accident, `loop: false` keeps it still.
    expect(visual.clip('soldier', 'idle').loop).toBe(false)
  })

  it('draws something in every direction', () => {
    for (const direction of DIRECTIONS) {
      const frame = visual.frame('soldier', 'idle', direction, 0)
      expect({ direction, drawn: frame !== null }).toEqual({ direction, drawn: true })
    }
  })

  it('is walk`s first frame, exactly', () => {
    // Not a new sprite and not a resized one: the same texels, so a soldier who
    // stops does not change size or hop to a different pose.
    for (const direction of DIRECTIONS) {
      expect({ direction, frame: visual.frame('soldier', 'idle', direction, 0) }).toEqual({
        direction,
        frame: visual.frame('soldier', 'walk', direction, 0),
      })
    }
  })

  it('faces where it is asked, not always south', () => {
    // Eight distinct frames, so a standing squad still faces eight ways.
    const seen = new Set(DIRECTIONS.map((d) => JSON.stringify(visual.frame('soldier', 'idle', d, 0))))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('answers frame 0 even if something asks for a later one', () => {
    // The renderer computes the index from `frameCount`, so it should only ever
    // ask for 0 — but a held clip that vanishes on an out-of-range index would
    // be a blank soldier, and a blank soldier is worse than a repeated one.
    expect(visual.frame('soldier', 'idle', 'S', 3)).not.toBeNull()
  })
})

describe('props are unaffected', () => {
  it('still resolves through the static clip', () => {
    // `frame` takes a `Facing`, so a prop is asked for with a real direction and
    // resolves through the static fallback rather than by naming it.
    expect(visual.frame('bush', STATIC_CLIP, 'S', 0)).not.toBeNull()
    expect(visual.clip('bush', STATIC_CLIP).frameCount).toBe(1)
  })

  it('draws a prop whatever animation is asked for', () => {
    expect(visual.frame('tree1', 'walk', 'S', 0)).not.toBeNull()
  })

  it('has no idle for a prop, because a prop has nothing to idle from', () => {
    // The derivation is walk-frame-0; a prop has no walk. It must still draw.
    expect(visual.frame('bush', 'idle', 'S', 0)).not.toBeNull()
  })
})

describe('the session and the atlas agree on animation names', () => {
  /**
   * A CONTRACT TEST across the layer boundary, and the reason is decision-12
   * shaped: `core/session` decides which animation a unit plays and `src/render`
   * decides what that name resolves to, and neither may import the other's
   * constant — `core/` is forbidden from reaching into `render/`. So the two
   * spellings are duplicated, and duplicated strings drift.
   *
   * Testing each side against its own idea of the other proves nothing: the
   * session would confirm it emits `'idle'` and the atlas would confirm it
   * serves `'idle'`, and the day one of them changed, both would still pass
   * while a standing soldier rendered as nothing at all. This test lives in
   * `src/render/` because that is the layer allowed to see both.
   */
  it('every animation the session emits resolves to a real frame', () => {
    // Two separate scenes on one map, kept far enough apart that neither
    // interferes with the other — the rifle reaches 8 tiles, and these are 10
    // rows apart.
    //
    //   row 2  : a lone walker, ordered across open ground and never in range
    //            of anything, so `walk` is observable for hundreds of frames.
    //   row 12 : a firefight against an enemy that cannot be killed in one
    //            round, so the shooter survives having fired.
    //
    // That second half needs saying, because it is a consequence of the tuning
    // rather than of this test: at `INFANTRY_HEALTH = 1` an exchange between two
    // riflemen is mutual and simultaneous — both fire on the same tick and both
    // are corpses by the time anything reads the render state — so the `fire`
    // pose is very nearly unobservable in normal play.
    const level = makeLevel({
      avatars: [
        { x: 2, y: 2 },
        { x: 8, y: 12 },
      ],
      enemies: [],
    })
    const session = createSession(level)
    session.queue.push({
      type: 'move',
      unitIds: [session.selection()[0]!],
      target: { x: 17, y: 2 },
    })

    const tough = tileToWorld(9, 12, level.size)
    session.world.spawn({ kind: 'rifleman', team: 'enemy', x: tough.x, z: tough.z, health: 10_000 })

    // Run long enough to see idle, walk, fire and die all occur.
    const seen = new Set<string>()
    for (let f = 0; f < 400; f++) {
      for (const drawn of session.renderEntities(() => 0)) {
        if (drawn.unit === 'soldier') seen.add(drawn.animation)
      }
      session.advance(1 / 60)
    }

    expect(seen).toContain(IDLE_CLIP) // the specific pair this test exists for
    expect([...seen].sort()).toEqual(['die', 'fire', 'idle', 'walk'])

    for (const animation of seen) {
      for (const direction of DIRECTIONS) {
        const frame = visual.frame('soldier', animation, direction, 0)
        expect({ animation, direction, drawn: frame !== null }).toEqual({
          animation,
          direction,
          drawn: true,
        })
      }
    }
  })
})

describe('a burst plays all four frames of the fire cycle', () => {
  /**
   * THE REPORTED BUG, PINNED END TO END.
   *
   * "Only one of the fire cycle frames is used, there are four." The cause was
   * not in the art or in the atlas: the session set `animation: 'fire'` on
   * exactly the ONE tick a `ShotFired` landed and `idle` on every tick after it,
   * so a clip that runs for 20 ticks (4 frames at 12fps) was on screen for one.
   * Whichever frame the clock happened to land on was the only one ever drawn.
   *
   * This asserts the whole path the way the game walks it: run a session, hold
   * the render state and the renderer's own clock exactly as `main.ts` does,
   * and resolve the frame through the SAME `frameAt` the renderer calls. A test
   * that only checked `animation === 'fire'` would have passed throughout.
   */
  it('shows every frame index at least once', () => {
    // NO ENEMY ON THE MAP, deliberately. Suppressing fire animates exactly like
    // aimed fire, and an enemy here would auto-engage and kill this one-hit-point
    // rifleman long before the burst got going — which is what happened to the
    // first draft of this test.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [] })
    const session = createSession(level)
    const shooter = session.selection()[0]!

    session.queue.push({
      type: 'fire',
      unitIds: [shooter],
      ordnance: 'rifle',
      target: { x: 11, y: 7 },
    })

    const clip = visual.clip('soldier', 'fire')
    const seen = new Set<number>()
    let elapsed = 0
    let firingTicks = 0
    for (let f = 0; f < 400; f++) {
      const dt = 1 / 60
      elapsed += dt
      session.advance(dt)
      const drawn = session.renderEntities(() => 0).find((r) => r.id === shooter)
      if (!drawn || drawn.animation !== 'fire') continue
      firingTicks += 1
      seen.add(frameAt(clip, elapsed - drawn.animationStart + phaseOffset(drawn.id) * 0))
    }

    expect(firingTicks).toBeGreaterThan(20) // he really did keep firing
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  it('holds the fire pose for the length of the clip, not for one tick', () => {
    // 4 frames at 12fps is a third of a second — 20 ticks at 60Hz. One tick is
    // 1/60th, which is at most one display frame and usually none.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [] })
    const session = createSession(level)
    const shooter = session.selection()[0]!
    session.queue.push({
      type: 'fire',
      unitIds: [shooter],
      ordnance: 'rifle',
      target: { x: 11, y: 7 },
    })

    // Find the first tick he fires, then count consecutive firing ticks.
    let run = 0
    let best = 0
    for (let f = 0; f < 200; f++) {
      session.advance(1 / 60)
      const drawn = session.renderEntities(() => 0).find((r) => r.id === shooter)
      if (drawn?.animation === 'fire') {
        run += 1
        best = Math.max(best, run)
      } else {
        run = 0
      }
    }
    expect(best).toBeGreaterThanOrEqual(20)
  })

  it('restarts the cycle on the next round rather than continuing the old one', () => {
    // Each trigger pull is its own recoil. Continuing would leave the second
    // shot showing the held last frame of the first.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [] })
    const session = createSession(level)
    const shooter = session.selection()[0]!
    session.queue.push({
      type: 'fire',
      unitIds: [shooter],
      ordnance: 'rifle',
      target: { x: 11, y: 7 },
    })

    const starts = new Set<number>()
    for (let f = 0; f < 300; f++) {
      session.advance(1 / 60)
      const drawn = session.renderEntities(() => 0).find((r) => r.id === shooter)
      if (drawn?.animation === 'fire') starts.add(drawn.animationStart)
    }
    expect(starts.size).toBeGreaterThan(1) // more than one burst
  })
})

describe('unknown things', () => {
  it('returns null for a unit that does not exist', () => {
    expect(visual.frame('dragon', 'walk', 'S', 0)).toBeNull()
  })

  it('returns a held clip for an animation that does not exist', () => {
    expect(visual.clip('soldier', 'moonwalk').frameCount).toBe(1)
  })
})
