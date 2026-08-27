import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createFxRenderer } from '../fx-renderer'
import type { Fx } from '../../core/render-state/fx'

/**
 * Ticket 025 — the thin half.
 *
 * THE INDEX SAID "unit: none — rendering layer" AND THAT IS WRONG HERE. This
 * project believed `src/render` untestable until it measured otherwise:
 * `BufferGeometry`, `InstancedMesh` and `MeshStandardMaterial` are plain JS
 * objects that only touch the GPU on upload, and ticket 034 found six mutations
 * that rendered the map wrong surviving behind that belief. Every module in the
 * layer carried a comment claiming it could not be tested.
 *
 * What is asserted here is deliberately narrow — the loop, the pooling, and the
 * fact that nothing allocates per frame. How it LOOKS is not a thing a test can
 * hold, and pretending otherwise is how a suite ends up green and useless.
 */

const fx = (over: Partial<Fx> = {}): Fx => ({
  id: 1,
  kind: 'burst',
  x: 0,
  z: 0,
  scale: 1,
  fade: 0,
  ...over,
})

describe('it draws exactly what it is handed', () => {
  it('one instance per visible effect', () => {
    const r = createFxRenderer()
    r.update([fx({ id: 1 }), fx({ id: 2 }), fx({ id: 3 })])
    expect(r.drawnCount).toBe(3)
  })

  it('and none at all when nothing is live', () => {
    // The quiet case, and the one a pooled renderer gets wrong: leftover
    // instances from the last frame stay on screen as effects that never fade.
    const r = createFxRenderer()
    r.update([fx({ id: 1 }), fx({ id: 2 })])
    r.update([])
    expect(r.drawnCount).toBe(0)
  })

  it('and shrinks as effects expire, rather than keeping a high-water mark', () => {
    const r = createFxRenderer()
    r.update([fx({ id: 1 }), fx({ id: 2 }), fx({ id: 3 }), fx({ id: 4 })])
    r.update([fx({ id: 1 })])
    expect(r.drawnCount).toBe(1)
  })
})

describe('and allocates nothing per frame', () => {
  it('reusing the same object graph across updates', () => {
    /**
     * THE ACCEPTANCE CRITERION "all particle systems are pooled", asserted by
     * identity rather than by counting allocations, which Vitest cannot see. A
     * renderer that rebuilt its mesh each frame would hand back a different
     * object here — and would also churn GPU buffers every frame of a firefight,
     * which is the cost this criterion exists to prevent.
     */
    const r = createFxRenderer()
    r.update([fx({ id: 1 })])
    const first = r.object
    r.update([fx({ id: 1 }), fx({ id: 2 })])
    expect(r.object).toBe(first)
  })

  it('and standing up to more effects than it was sized for without throwing', () => {
    // The buffer is capped upstream, but "capped" and "the renderer's own limit"
    // are two numbers, and a renderer that indexed past its instance count would
    // throw in the middle of the busiest frame of the mission.
    const r = createFxRenderer({ capacity: 4 })
    const many = Array.from({ length: 50 }, (_, i) => fx({ id: i }))
    expect(() => r.update(many)).not.toThrow()
    expect(r.drawnCount).toBeLessThanOrEqual(4)
  })
})

describe('every kind the buffer can produce is drawable', () => {
  it('none of them throws or silently draws nothing', () => {
    // A renderer with a `switch` that forgot a kind draws nothing for it, and
    // the effect is simply missing — which looks exactly like the bug this whole
    // ticket exists to fix.
    const r = createFxRenderer()
    for (const kind of ['muzzle', 'burst', 'death'] as const) {
      r.update([fx({ kind })])
      expect({ kind, drawn: r.drawnCount }).toEqual({ kind, drawn: 1 })
    }
  })
})

/**
 * THE GEOMETRY ITSELF, WHICH THE FIRST DRAFT OF THIS FILE DID NOT TOUCH.
 *
 * Everything above reads `drawnCount` and `object` identity — and adversarial
 * review showed that leaves SEVEN mutations alive, including one that is an
 * acceptance criterion verbatim: deleting `* effect.scale` stops a burst scaling
 * with its blast radius, and the whole suite stayed green. `fx.test.ts` proves
 * the scale is STORED; nothing proved it was USED.
 *
 * Which is the exact belief this file's own header warns about, re-created one
 * file further along. `position` and `color` are plain `Float32Array`s and Node
 * can read them, so they are read.
 */
const attr = (r: ReturnType<typeof createFxRenderer>, name: 'position' | 'color') => {
  const mesh = r.object as THREE.Mesh
  const a = (mesh.geometry as THREE.BufferGeometry).getAttribute(name)
  return a as THREE.BufferAttribute
}

/** The world-space extent of the first quad drawn, on the X axis. */
const spanX = (r: ReturnType<typeof createFxRenderer>): number => {
  const p = attr(r, 'position')
  let min = Infinity
  let max = -Infinity
  for (let v = 0; v < 6; v += 1) {
    const x = p.getX(v)
    min = Math.min(min, x)
    max = Math.max(max, x)
  }
  return max - min
}

describe('the quad it writes is the effect it was given', () => {
  it('a burst twice the blast radius is twice as wide on the ground', () => {
    // ACCEPTANCE CRITERION 1. Dropping `* effect.scale` in the renderer left
    // every other test in this file passing.
    const small = createFxRenderer()
    small.update([fx({ kind: 'burst', scale: 1 })])
    const big = createFxRenderer()
    big.update([fx({ kind: 'burst', scale: 2 })])
    expect(spanX(big)).toBeCloseTo(spanX(small) * 2, 5)
  })

  it('and a zero-scale effect is skipped rather than drawn inside out', () => {
    const r = createFxRenderer()
    r.update([fx({ kind: 'burst', scale: 0 }), fx({ kind: 'burst', scale: -3 })])
    expect(r.drawnCount).toBe(0)
  })

  it('and it is centred on where the effect happened', () => {
    const r = createFxRenderer()
    r.update([fx({ kind: 'burst', x: 12, z: -7, scale: 1 })])
    const p = attr(r, 'position')
    let sx = 0
    let sz = 0
    for (let v = 0; v < 6; v += 1) {
      sx += p.getX(v)
      sz += p.getZ(v)
    }
    expect(sx / 6).toBeCloseTo(12, 5)
    expect(sz / 6).toBeCloseTo(-7, 5)
  })
})

describe('and it fades as the buffer says it has', () => {
  it('a half-faded effect is drawn dimmer than a fresh one', () => {
    /**
     * The visible half of the lifetime criterion. Dropping `* (1 - effect.fade)`
     * makes every effect burn at full brightness until it vanishes — a pop
     * rather than a fade — and nothing else in this suite can see it.
     */
    const fresh = createFxRenderer()
    fresh.update([fx({ kind: 'burst', fade: 0 })])
    const dying = createFxRenderer()
    dying.update([fx({ kind: 'burst', fade: 0.5 })])
    expect(attr(dying, 'color').getW(0)).toBeLessThan(attr(fresh, 'color').getW(0))
  })

  it('and one at the end of its life is drawn at nothing', () => {
    const r = createFxRenderer()
    r.update([fx({ kind: 'burst', fade: 1 })])
    expect(attr(r, 'color').getW(0)).toBeCloseTo(0, 6)
  })
})

describe('and it is composited as light, which is the only way it composites', () => {
  it('additively, so a flash brightens the jungle instead of stamping a patch on it', () => {
    /**
     * TICKET 047 REMOVED THE CHOICE. This described a `blending` option with two
     * settings, and the case that lived here asserted the `'normal'` one — which
     * existed for exactly one caller, the decal pool, because a scorch mark is
     * dark and additively blended dark is invisible. The decals are gone, so
     * `'normal'` had no caller left; an option no caller can select is a branch
     * nothing exercises and the next reader has to reason about anyway.
     *
     * What survives is the assertion that still has a subject: every effect is
     * LIGHT. A muzzle flash that stamped an opaque quad over the ground would be
     * a worse version of the thing this ticket was asked to delete.
     */
    expect((createFxRenderer().object as THREE.Mesh).material).toMatchObject({
      blending: THREE.AdditiveBlending,
    })
  })
})

describe('and it samples the ground where the effect stands', () => {
  it('asking the height function for the CENTRE-indexed tile', () => {
    /**
     * Integers name tile CENTRES in this codebase, so the conversion is a round
     * against `(w - 1) / 2` and the corner-indexed spelling samples the tile next
     * door. The file's own comment says two review cycles have already gone on
     * that half tile; nothing was checking it.
     */
    const asked: { x: number; y: number }[] = []
    const r = createFxRenderer({
      ground: {
        size: { w: 21, h: 21 },
        heightAt: (x: number, y: number) => {
          asked.push({ x, y })
          return 3
        },
      },
    })
    // The world origin is the CENTRE tile of a 21x21 grid, which is (10, 10).
    r.update([fx({ kind: 'burst', x: 0, z: 0 })])
    expect(asked[0]).toEqual({ x: 10, y: 10 })
    expect(attr(r, 'position').getY(0)).toBeGreaterThan(3)
  })

  it('and lifts it clear of the terrain it sits on', () => {
    // Without the lift every effect z-fights the ground and flickers.
    const r = createFxRenderer({ ground: { size: { w: 21, h: 21 }, heightAt: () => 0 } })
    r.update([fx({ kind: 'burst' })])
    expect(attr(r, 'position').getY(0)).toBeGreaterThan(0)
  })
})

describe('and it does not hand the driver more work every frame', () => {
  it('update ranges are cleared, not accumulated', () => {
    /**
     * The comment beside this code says the ranges "accumulate — left alone,
     * this would hand the driver one more range per frame for the length of the
     * mission". Removing the two `clearUpdateRanges()` calls left the suite
     * green, so the claim was true and unguarded, which is the combination this
     * project treats as a defect in its own right.
     */
    const r = createFxRenderer()
    for (let frame = 0; frame < 30; frame += 1) r.update([fx({ id: frame })])
    expect(attr(r, 'position').updateRanges.length).toBeLessThanOrEqual(1)
    expect(attr(r, 'color').updateRanges.length).toBeLessThanOrEqual(1)
  })

  it('and the mesh is hidden outright when nothing is live', () => {
    const r = createFxRenderer()
    r.update([fx({ id: 1 })])
    expect(r.object.visible).toBe(true)
    r.update([])
    expect(r.object.visible).toBe(false)
  })
})

describe('an airburst is drawn in the air', () => {
  it('a burst with a height of its own sits above the ground, not on it', () => {
    /**
     * `ExplosionEvent` carries `y` and says why in capitals: a fuse that expires
     * before impact detonates the round in MID-AIR, and "an airburst reported on
     * the ground would hide the whole mechanic". The grenade's `fuseTicks` makes
     * that reachable in ordinary play.
     *
     * The first draft of this renderer dropped `y` on the floor and placed every
     * burst at `groundAt(x, z) + lift`, so the one thing the event goes out of
     * its way to report was the one thing not drawn.
     */
    const ground = { size: { w: 21, h: 21 }, heightAt: () => 0 }
    const low = createFxRenderer({ ground })
    low.update([fx({ kind: 'burst' })])
    const high = createFxRenderer({ ground })
    high.update([fx({ kind: 'burst', y: 4 })])
    expect(attr(high, 'position').getY(0)).toBeCloseTo(attr(low, 'position').getY(0) + 4, 5)
  })

  it('and there is no kind exempt from that any more', () => {
    /**
     * THE CASE THIS REPLACES asserted that a scar ignored the airburst height —
     * a scorch mark is on the terrain by definition, and one that inherited the
     * blast's altitude would hang in the sky where nothing burned. Ticket 047
     * deleted the kind, and the `effect.kind === 'decal' ? 0 : effect.y` special
     * case in the renderer went with it.
     *
     * So the rule is now uniform, and this says so: every remaining kind lifts
     * with the height it is given. A special case reintroduced for one of them
     * would fail here rather than be discovered on screen.
     */
    const ground = { size: { w: 21, h: 21 }, heightAt: () => 0 }
    for (const kind of ['muzzle', 'burst', 'death'] as const) {
      const low = createFxRenderer({ ground })
      low.update([fx({ kind })])
      const high = createFxRenderer({ ground })
      high.update([fx({ kind, y: 4 })])
      expect({
        kind,
        lifted: attr(high, 'position').getY(0) - attr(low, 'position').getY(0),
      }).toEqual({ kind, lifted: expect.closeTo(4, 5) })
    }
  })
})
