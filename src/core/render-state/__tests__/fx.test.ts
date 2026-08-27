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
    fx.add(spawn('muzzle', 1, 1), 0)
    fx.add(spawn('muzzle', 2, 2), 0)
    const live = fx.visible(0)
    expect(live.map((e) => e.kind)).toEqual(['muzzle', 'muzzle'])
    expect(live.map((e) => e.x)).toEqual([1, 2])
  })

  it('never returns more than its capacity, however much is thrown at it', () => {
    // Fed straight off an event bus for the length of a mission. An array that
    // only pushes is a leak with a fuse on it.
    const fx = createFxBuffer({ capacity: 8 })
    for (let i = 0; i < 500; i += 1) fx.add(spawn('muzzle', i, 0), 0)
    expect(fx.visible(0)).toHaveLength(8)
  })

  it('and drops the OLDEST when it overflows', () => {
    // The round that just went off matters more to a player than one from four
    // volleys ago.
    const fx = createFxBuffer({ capacity: 3 })
    for (let i = 0; i < 5; i += 1) fx.add(spawn('muzzle', i, 0), 0)
    expect(fx.visible(0).map((e) => e.x)).toEqual([2, 3, 4])
  })

  it('gives every effect an id unique for the life of the buffer', () => {
    // The renderer pools by index and may key per-effect state off this; two
    // effects sharing an id would drop one of them.
    const fx = createFxBuffer({ capacity: 4 })
    for (let i = 0; i < 12; i += 1) fx.add(spawn('muzzle'), 0)
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
    fx.add(spawn('muzzle'), 10)
    expect(fx.visible(10)[0]?.fade).toBe(0)
  })

  it('and is gone once its lifetime has passed', () => {
    const fx = createFxBuffer()
    const life = FX_LIFETIME_SECONDS.muzzle
    fx.add(spawn('muzzle'), 10)
    expect(fx.visible(10 + life * 0.5)).toHaveLength(1)
    expect(fx.visible(10 + life + 0.001)).toHaveLength(0)
  })

  it('fading monotonically in [0, 1) on the way', () => {
    const fx = createFxBuffer()
    const life = FX_LIFETIME_SECONDS.muzzle
    fx.add(spawn('muzzle'), 0)
    let previous = -1
    for (let t = 0; t < life; t += life / 20) {
      const fade = fx.visible(t)[0]?.fade
      expect(fade).toBeDefined()
      expect(fade!).toBeGreaterThanOrEqual(previous)
      expect(fade!).toBeLessThan(1)
      previous = fade!
    }
  })

  it('and every kind has a real span of its own', () => {
    /**
     * THE PER-KIND TABLE OUTLIVED HAVING MORE THAN ONE KIND (ticket 054). This
     * case used to prove the spans DIFFERED, which was the argument for a
     * `Record` rather than a constant — a muzzle flash is a blink and a
     * detonation hangs, and one number tuned for either makes the other look
     * broken.
     *
     * With only the flash left there is nothing to differ from, so what survives
     * is the part that still has teeth: every kind's lifetime is a positive
     * number. A zero or a negative would divide the fade by nothing and put an
     * effect on screen for ever or not at all, and the shape stays a `Record` so
     * the next kind is a compile error until it is given one.
     */
    for (const k of FX_KINDS) {
      expect({ k, span: FX_LIFETIME_SECONDS[k] > 0 }).toEqual({ k, span: true })
    }
  })

  it('and an effect asked about BEFORE it happened is at the start, not brighter', () => {
    /**
     * A hitching frame can ask about a time it has already run past — and the
     * renderer draws alpha as `peak * (1 - fade)`, so a negative fade comes out
     * BRIGHTER than a live effect. `fx.ts` guards it and says so; nothing was
     * checking, and removing the guard left the whole suite green.
     */
    const fx = createFxBuffer()
    fx.add(spawn('muzzle'), 10)
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
    fx.add(spawn('muzzle'), 0)
    expect(fx.visible(999)).toHaveLength(0)
    expect(fx.visible(0)).toHaveLength(1)
  })
})

describe('an effect carries the size it was asked for', () => {
  it('scale is stored verbatim, not recomputed', () => {
    // The field outlived the burst that needed it (ticket 054): `scale` is
    // stored verbatim and never recomputed, so a producer that reports a size is
    // drawn at it. The muzzle flash asks for 1 and always has.
    const fx = createFxBuffer()
    fx.add(spawn('muzzle', 0, 0, 4.5), 0)
    expect(fx.visible(0)[0]?.scale).toBe(4.5)
  })

  it('and two blasts of different sizes stay different', () => {
    const fx = createFxBuffer()
    fx.add(spawn('muzzle', 0, 0, 1), 0)
    fx.add(spawn('muzzle', 0, 0, 6), 0)
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
      fx.add(spawn('muzzle'), round)
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

  it('and neither the decal, the death puff nor the burst is left to spawn', () => {
    /**
     * ASSERTED ON THE RUNTIME LIST as well as in the type. `FX_KINDS` is what
     * `FxKind` is derived from, so a re-added entry is a compile error at every
     * `Record<FxKind, ...>` — but only for code that is compiled. This is what
     * fails if a kind comes back through data.
     *
     * THREE KINDS HAVE NOW GONE THIS WAY, and they went for one reason. Ticket
     * 047 removed the scorch mark, 051 the dull red puff a falling man left at
     * chest height, and 054 the orange quad an explosion drew at its own blast
     * radius. Each was a coloured rectangle standing in for an effect, and the
     * last read most like a debug overlay because it literally WAS the blast
     * radius drawn as a box.
     *
     * The muzzle flash is what is left. A detonation is now the camera kick, the
     * sound, and the men who were standing there lying where they fell.
     */
    expect([...FX_KINDS]).toEqual(['muzzle'])
    expect(Object.keys(FX_LIFETIME_SECONDS)).toEqual(['muzzle'])
  })
})
