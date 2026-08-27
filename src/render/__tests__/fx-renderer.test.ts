import { describe, it, expect } from 'vitest'
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
    for (const kind of ['muzzle', 'burst', 'death', 'decal'] as const) {
      r.update([fx({ kind })])
      expect({ kind, drawn: r.drawnCount }).toEqual({ kind, drawn: 1 })
    }
  })
})
