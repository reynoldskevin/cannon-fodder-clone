import { describe, it, expect } from 'vitest'
import {
  createFxBuffer,
  FX_KINDS,
  FX_LIFETIME_SECONDS,
  DEFAULT_FX_CAPACITY,
  type FxKind,
} from '../fx'

/**
 * Ticket 025 — the live effects buffer.
 *
 * Grenades and rockets are invisible: `Explosion` is emitted, men die, and
 * nothing appears, so a player cannot tell a detonation from a coincidence.
 *
 * BUILT ON `tracers.ts`'s CONTRACT, DELIBERATELY. Same ring, same
 * time-as-an-argument rule, same `visible` as a pure query. `src/core` may not
 * read a clock — the engine-free boundary ESLint enforces — and an effect
 * measured in SIM ticks would last a different span of wall time at 30 fps and
 * at 144, because a flash is a fact about the display and not about the mission.
 */

const spawn = (kind: FxKind, x = 0, z = 0, scale = 1) => ({ kind, x, z, scale })

describe('the buffer is a bounded ring', () => {
  it('holds what it is given, oldest first', () => {
    const fx = createFxBuffer({ capacity: 4 })
    fx.add(spawn('burst', 1, 1), 0)
    fx.add(spawn('muzzle', 2, 2), 0)
    const live = fx.visible(0)
    expect(live.map((e) => e.kind)).toEqual(['burst', 'muzzle'])
    expect(live.map((e) => e.x)).toEqual([1, 2])
  })

  it('never returns more than its capacity, however much is thrown at it', () => {
    // Fed straight off an event bus for the length of a mission. An array that
    // only pushes is a leak with a fuse on it.
    const fx = createFxBuffer({ capacity: 8 })
    for (let i = 0; i < 500; i += 1) fx.add(spawn('burst', i, 0), 0)
    expect(fx.visible(0)).toHaveLength(8)
  })

  it('and drops the OLDEST when it overflows', () => {
    // The round that just went off matters more to a player than one from four
    // volleys ago.
    const fx = createFxBuffer({ capacity: 3 })
    for (let i = 0; i < 5; i += 1) fx.add(spawn('burst', i, 0), 0)
    expect(fx.visible(0).map((e) => e.x)).toEqual([2, 3, 4])
  })

  it('gives every effect an id unique for the life of the buffer', () => {
    // The renderer pools by index and may key per-effect state off this; two
    // effects sharing an id would drop one of them.
    const fx = createFxBuffer({ capacity: 4 })
    for (let i = 0; i < 12; i += 1) fx.add(spawn('burst'), 0)
    const ids = fx.visible(0).map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reports the capacity it was built with, and refuses a nonsense one', () => {
    expect(createFxBuffer({ capacity: 16 }).capacity).toBe(16)
    // A zero-capacity ring has nowhere to write; a fractional one indexes off
    // the end of its own array.
    expect(createFxBuffer({ capacity: 0 }).capacity).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(createFxBuffer({ capacity: 4.7 }).capacity)).toBe(true)
    expect(createFxBuffer().capacity).toBe(DEFAULT_FX_CAPACITY)
  })
})

describe('effects expire on the RENDER clock', () => {
  it('an effect is at the start of its life the instant it is added', () => {
    const fx = createFxBuffer()
    fx.add(spawn('burst'), 10)
    expect(fx.visible(10)[0]?.fade).toBe(0)
  })

  it('and is gone once its lifetime has passed', () => {
    const fx = createFxBuffer()
    const life = FX_LIFETIME_SECONDS.burst
    fx.add(spawn('burst'), 10)
    expect(fx.visible(10 + life * 0.5)).toHaveLength(1)
    expect(fx.visible(10 + life + 0.001)).toHaveLength(0)
  })

  it('fading monotonically in [0, 1) on the way', () => {
    const fx = createFxBuffer()
    const life = FX_LIFETIME_SECONDS.burst
    fx.add(spawn('burst'), 0)
    let previous = -1
    for (let t = 0; t < life; t += life / 20) {
      const fade = fx.visible(t)[0]?.fade
      expect(fade).toBeDefined()
      expect(fade!).toBeGreaterThanOrEqual(previous)
      expect(fade!).toBeLessThan(1)
      previous = fade!
    }
  })

  it('and each kind lives for its own span, not one shared number', () => {
    /**
     * A muzzle flash is a blink; a detonation hangs. One lifetime for both would
     * make whichever it was tuned for look right and the other look broken — and
     * it is the kind of thing that reads as "the FX are bad" rather than as a
     * number somebody chose.
     */
    const spans = FX_KINDS.map((k) => FX_LIFETIME_SECONDS[k])
    expect(new Set(spans).size).toBeGreaterThan(1)
    for (const k of FX_KINDS) expect(FX_LIFETIME_SECONDS[k]).toBeGreaterThan(0)
    expect(FX_LIFETIME_SECONDS.muzzle).toBeLessThan(FX_LIFETIME_SECONDS.burst)
  })

  it('and an effect asked about BEFORE it happened is at the start, not brighter', () => {
    /**
     * A hitching frame can ask about a time it has already run past — and the
     * renderer draws alpha as `peak * (1 - fade)`, so a negative fade comes out
     * BRIGHTER than a live effect. `fx.ts` guards it and says so; nothing was
     * checking, and removing the guard left the whole suite green.
     */
    const fx = createFxBuffer()
    fx.add(spawn('burst'), 10)
    expect(fx.visible(5)[0]?.fade).toBe(0)
  })

  it('an expired effect frees nothing and destroys no earlier answer', () => {
    /**
     * `visible` IS A QUERY. Expiring entries inside it — the obvious spelling —
     * makes the answer depend on the order the questions were asked, and both
     * orders happen for real: a renderer may ask twice in one frame, and a frame
     * that hitches asks about a time it has already run past.
     */
    const fx = createFxBuffer()
    fx.add(spawn('burst'), 0)
    expect(fx.visible(999)).toHaveLength(0)
    expect(fx.visible(0)).toHaveLength(1)
  })
})

describe('a burst carries the size of the blast that made it', () => {
  it('scale is stored verbatim, not recomputed', () => {
    // `Explosion` already reports its radius. A burst that guessed would be a
    // second opinion about how big the detonation was.
    const fx = createFxBuffer()
    fx.add(spawn('burst', 0, 0, 4.5), 0)
    expect(fx.visible(0)[0]?.scale).toBe(4.5)
  })

  it('and two blasts of different sizes stay different', () => {
    const fx = createFxBuffer()
    fx.add(spawn('burst', 0, 0, 1), 0)
    fx.add(spawn('burst', 0, 0, 6), 0)
    expect(fx.visible(0).map((e) => e.scale)).toEqual([1, 6])
  })
})

describe('adding costs no allocation per effect', () => {
  it('the ring is built once, at full capacity', () => {
    /**
     * Asserted through behaviour rather than by counting allocations, which
     * Vitest cannot see: a buffer that grew on demand would report a rising
     * capacity, and one that spliced out the dead would return a shrinking
     * array for a steady input. Neither is allowed to happen.
     */
    const fx = createFxBuffer({ capacity: 6 })
    for (let round = 0; round < 50; round += 1) {
      fx.add(spawn('burst'), round)
      expect(fx.capacity).toBe(6)
    }
    expect(fx.visible(50).length).toBeLessThanOrEqual(6)
  })
})

describe('nothing an explosion leaves behind outlives the fight', () => {
  /**
   * TICKET 047 DELETED THE `decal` KIND, and with it the second pool that
   * existed only to hold it.
   *
   * The scar was a dark quad on the ground with a 45-second life, and it read as
   * a flat coloured square rather than as scorched earth — worse than the clean
   * ground it covered. What went with it was a whole apparatus: a second
   * `createFxBuffer` sized in "marks a map can carry" rather than "things
   * happening at once", a second `FxRenderer` built with `'normal'` blending
   * because a scar is paint where every other effect is light, and a special
   * case in the renderer pinning it to the ground while everything else floats.
   *
   * THE THREE CASES THAT LIVED HERE WERE ABOUT THAT SECOND POOL — that a decal
   * outlives a burst, that a storm of bursts cannot evict a scar, and that scars
   * still recycle. All three named their subject, and their subject is gone;
   * weakening them into decal-free versions would have left three cases arguing
   * for a design decision the codebase no longer makes. The capacity argument
   * they exercised is still a real feature of the ring and is covered by the
   * bounded-ring cases above, which is where it belonged.
   */
  it('every kind that remains is short-lived', () => {
    // The property the deletion actually establishes. A second later, the ground
    // under a detonation is clean — no kind can now outlast a firefight.
    const outliving = FX_KINDS.filter((kind) => FX_LIFETIME_SECONDS[kind] > 2)
    expect(outliving).toEqual([])
  })

  it('and neither the decal nor the death puff is left to spawn', () => {
    /**
     * ASSERTED ON THE RUNTIME LIST as well as in the type. `FX_KINDS` is what
     * `FxKind` is derived from, so a re-added entry is a compile error at every
     * `Record<FxKind, ...>` — but only for code that is compiled. This is what
     * fails if a kind comes back through data.
     *
     * TWO KINDS HAVE NOW GONE THIS WAY. Ticket 047 removed the scorch mark and
     * ticket 051 the dull red puff a falling man left at chest height — both
     * coloured quads standing in for an effect, and the second had nothing left
     * to say once ticket 049 kept the body itself on the field. What remains is
     * the muzzle flash and the detonation, which are both LIGHT.
     */
    expect([...FX_KINDS]).toEqual(['muzzle', 'burst'])
    expect(Object.keys(FX_LIFETIME_SECONDS).sort()).toEqual(['burst', 'muzzle'])
  })
})
