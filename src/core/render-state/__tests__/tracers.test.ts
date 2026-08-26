import { describe, it, expect } from 'vitest'
import {
  createTracerBuffer,
  DEFAULT_TRACER_CAPACITY,
  DEFAULT_TRACER_LIFETIME_SECONDS,
} from '../tracers'
import type { TracerShot } from '../tracers'

/**
 * Ticket 025a — the live tracer buffer.
 *
 * PURE, AND TIME ARRIVES AS AN ARGUMENT. A tracer is a visual afterimage
 * measured in real milliseconds, so it must be driven by the RENDERER's clock —
 * but `src/core` may not read one, and a tracer that read the wall clock itself
 * could not be tested under Node at all. So `add` is told when the shot
 * happened and `visible` is told what time it is now, exactly the way
 * `interpolateEntities` is told its alpha. The renderer owns the clock; this
 * owns the decision.
 *
 * NOT SIMULATION. Nothing here may reach a mission result. A headless replay and
 * a rendered one must produce the same mission whether or not anybody drew a
 * tracer, which is why this lives in `render-state` beside the interpolation
 * rather than anywhere near `core/world`.
 */

const shot = (originX: number, originZ: number, targetX: number, targetZ: number): TracerShot => ({
  originX,
  originZ,
  targetX,
  targetZ,
})

const A = shot(0, 0, 3, 0)
const B = shot(1, 1, 4, 1)

describe('a tracer lives, fades and dies', () => {
  it('is visible the instant it is fired', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 10)
    expect(b.visible(10)).toHaveLength(1)
  })

  it('carries the endpoints it was given, unchanged', () => {
    // The whole point of feeding this from `ShotFired`: ticket 011a already
    // clamps a round's far end to the near face of a wall, so a tracer drawn to
    // the event's endpoint stops at the wall rather than passing through it —
    // and it does so with no geometry code here at all. Altering the endpoints
    // would throw that away.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 0)
    expect(b.visible(0)[0]).toMatchObject({
      originX: 0,
      originZ: 0,
      targetX: 3,
      targetZ: 0,
    })
  })

  it('starts at fade 0', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 5)
    expect(b.visible(5)[0]?.fade).toBe(0)
  })

  it('is half faded at half its life', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 0.2 })
    b.add(A, 0)
    expect(b.visible(0.1)[0]?.fade).toBeCloseTo(0.5, 6)
  })

  it('is gone once its life is over', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 0.2 })
    b.add(A, 0)
    expect(b.visible(0.2)).toEqual([])
    expect(b.visible(5)).toEqual([])
  })

  it('never reports a fade of 1 or more, so nothing draws a dead tracer', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 0.2 })
    b.add(A, 0)
    for (const t of [0, 0.05, 0.1, 0.19, 0.199999]) {
      const fade = b.visible(t)[0]?.fade
      expect({ t, ok: fade !== undefined && fade >= 0 && fade < 1 }).toEqual({ t, ok: true })
    }
  })

  it('expires each tracer on its own clock, not the newest one`s', () => {
    // The failure this prevents is a burst where the last round keeps the first
    // one alive — a smear that never clears while the trigger is held.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 0)
    b.add(B, 0.9)
    expect(b.visible(0.95)).toHaveLength(2)
    expect(b.visible(1.5)).toHaveLength(1) // A has gone, B has not
    expect(b.visible(1.5)[0]).toMatchObject({ originX: 1 })
  })
})

describe('reading it does not change it', () => {
  it('answers the same twice for the same instant', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 0)
    expect(b.visible(0.5)).toEqual(b.visible(0.5))
  })

  it('a tracer read past its life is not resurrected by an earlier read', () => {
    // `visible` is a query, so asking about a later time must not destroy the
    // answer to an earlier one — the renderer may legitimately ask twice in a
    // frame, and a hitching frame can ask about a time it has already passed.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 0)
    expect(b.visible(2)).toEqual([])
    expect(b.visible(0.5)).toHaveLength(1)
  })
})

describe('it is bounded', () => {
  it('has a capacity', () => {
    expect(createTracerBuffer({ capacity: 4 }).capacity).toBe(4)
  })

  it('drops the OLDEST when it overflows', () => {
    // An unbounded array fed from an event bus is a leak with a fuse on it. When
    // it does overflow, the round that just went off matters more than one from
    // four volleys ago.
    const b = createTracerBuffer({ capacity: 3, lifetimeSeconds: 100 })
    for (let i = 0; i < 5; i += 1) b.add(shot(i, 0, i + 1, 0), 0)
    const live = b.visible(0)
    expect(live).toHaveLength(3)
    expect(live.map((t) => t.originX)).toEqual([2, 3, 4])
  })

  it('keeps working after wrapping many times over', () => {
    const b = createTracerBuffer({ capacity: 3, lifetimeSeconds: 100 })
    for (let i = 0; i < 100; i += 1) b.add(shot(i, 0, i + 1, 0), 0)
    expect(b.visible(0).map((t) => t.originX)).toEqual([97, 98, 99])
  })

  it('defaults to a capacity well above any volley the game can fire', () => {
    // Level 1 fields five soldiers; a whole squad and every enemy firing on the
    // same tick is single digits of rounds. The default is not a tuning knob, it
    // is headroom.
    expect(DEFAULT_TRACER_CAPACITY).toBeGreaterThanOrEqual(64)
  })

  it('defaults to a lifetime short enough to read as a streak, not a laser', () => {
    expect(DEFAULT_TRACER_LIFETIME_SECONDS).toBeGreaterThan(0)
    expect(DEFAULT_TRACER_LIFETIME_SECONDS).toBeLessThan(0.5)
  })
})

describe('order', () => {
  it('reports tracers oldest first', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 10 })
    b.add(shot(1, 0, 2, 0), 0)
    b.add(shot(2, 0, 3, 0), 1)
    b.add(shot(3, 0, 4, 0), 2)
    expect(b.visible(2).map((t) => t.originX)).toEqual([1, 2, 3])
  })

  it('gives every tracer a distinct id', () => {
    // The renderer pools quads by index; two tracers sharing an id would drop
    // one of them.
    const b = createTracerBuffer({ lifetimeSeconds: 10 })
    for (let i = 0; i < 20; i += 1) b.add(A, i * 0.01)
    const ids = b.visible(0.19).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('hostile inputs', () => {
  it('survives a clock that goes backwards', () => {
    // A tracer cannot be un-fired. Asked about a moment before it existed, it is
    // at worst brand new — never negatively faded, which would light it brighter
    // than a live round.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 10)
    const fade = b.visible(9)[0]?.fade
    expect(fade === undefined || fade >= 0).toBe(true)
  })

  it('survives several shots stamped at the same instant', () => {
    // A volley: `CombatSystem` decides every shot in a tick against one snapshot,
    // so simultaneous rounds are the normal case, not an edge one.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(A, 3)
    b.add(B, 3)
    b.add(A, 3)
    expect(b.visible(3)).toHaveLength(3)
  })

  it('keeps a zero-length shot rather than discarding it', () => {
    // A round aimed at the tile its shooter stands on. It is a real event and
    // the renderer can decline to draw it; swallowing it here would hide a
    // genuine oddity from anyone debugging one.
    const b = createTracerBuffer({ lifetimeSeconds: 1 })
    b.add(shot(2, 2, 2, 2), 0)
    expect(b.visible(0)).toHaveLength(1)
  })

  it('is empty before anything is fired', () => {
    expect(createTracerBuffer().visible(0)).toEqual([])
  })
})

describe('what `visible` hands back is the caller`s to keep', () => {
  it('does not alias the ring, so a later shot cannot rewrite an earlier read', () => {
    /**
     * THE OPTIMISATION SOMEONE WILL REACH FOR, and it is silently wrong.
     *
     * `visible` allocates a small object per live tracer, and the obvious way to
     * avoid that is to hand back the ring's own entries with a `fade` bolted on.
     * The buffer then overwrites those entries in place as new rounds arrive —
     * so a renderer holding last frame's array would watch its tracers teleport
     * to the endpoints of shots fired after it looked.
     *
     * A reviewer made exactly that change and the entire suite stayed green,
     * which is why this case exists. The docstring promises `visible` mutates
     * nothing; the expiry test covers half of that promise and this covers the
     * other half.
     */
    const b = createTracerBuffer({ capacity: 2, lifetimeSeconds: 100 })
    b.add(shot(1, 1, 2, 2), 0)
    const held = b.visible(0)
    expect(held[0]).toMatchObject({ originX: 1, targetX: 2 })

    // Enough shots to wrap the ring and overwrite the slot the held tracer came
    // from, several times over.
    for (let i = 0; i < 6; i += 1) b.add(shot(90 + i, 0, 91 + i, 0), 0)

    expect(held[0]).toMatchObject({ originX: 1, originZ: 1, targetX: 2, targetZ: 2 })
  })

  it('hands back a different array each time', () => {
    const b = createTracerBuffer({ lifetimeSeconds: 10 })
    b.add(A, 0)
    expect(b.visible(0)).not.toBe(b.visible(0))
  })
})

describe('the options are guarded, because one day somebody will pass nonsense', () => {
  it('refuses a capacity of zero rather than swallowing every shot', () => {
    // A zero-length ring accepts rounds and shows none of them — a tracer
    // feature that is silently off, which is worse than one that is loudly
    // broken.
    const b = createTracerBuffer({ capacity: 0, lifetimeSeconds: 10 })
    expect(b.capacity).toBeGreaterThanOrEqual(1)
    b.add(A, 0)
    expect(b.visible(0)).toHaveLength(1)
  })

  it('refuses a fractional capacity rather than indexing past the ring', () => {
    const b = createTracerBuffer({ capacity: 2.5, lifetimeSeconds: 10 })
    expect(Number.isInteger(b.capacity)).toBe(true)
    for (let i = 0; i < 5; i += 1) b.add(shot(i, 0, i + 1, 0), 0)
    expect(b.visible(0).length).toBeLessThanOrEqual(b.capacity)
  })

  it('refuses a lifetime of zero or less', () => {
    // A non-positive lifetime divides by zero or goes negative, and a negative
    // fade would light a tracer BRIGHTER than a live round — forever, since it
    // never reaches 1 and never expires.
    for (const lifetimeSeconds of [0, -1]) {
      const b = createTracerBuffer({ lifetimeSeconds })
      b.add(A, 0)
      const fade = b.visible(0)[0]?.fade
      expect({ lifetimeSeconds, ok: fade !== undefined && fade >= 0 && fade < 1 }).toEqual({
        lifetimeSeconds,
        ok: true,
      })
    }
  })
})
