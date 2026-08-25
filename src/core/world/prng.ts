/**
 * The simulation's only source of randomness (ticket 005).
 *
 * ARCHITECTURE.md ("Determinism") forbids `Math.random()` anywhere in `core/`:
 * a global generator is shared mutable state, so the *order* in which unrelated
 * subsystems happen to draw becomes part of the result. Combat spread, AI
 * hesitation and ordnance scatter all draw from here, so if this stream is not
 * byte-for-byte reproducible then neither is anything above it, and the
 * determinism guarantee that makes the whole layer unit-testable is a fiction.
 *
 * ALGORITHM: splitmix32. Chosen for three properties this codebase actually
 * needs, rather than for statistical pedigree:
 *
 *   - The state is a SINGLE uint32, so `getState()` is one finite integer that
 *     round-trips through `JSON.stringify` unchanged. A save/replay snapshot
 *     that had to serialise a four-word xorshift state is four more chances to
 *     restore a stream slightly wrong, and a stream restored slightly wrong
 *     produces a divergence hundreds of ticks later with no visible cause.
 *   - The output is a bijective mix of the state and the state advances by a
 *     fixed odd stride, so the generator is full-period (2^32) and never
 *     repeats an output within one mission. A short period reads as visibly
 *     cyclic enemy behaviour, which looks like an AI bug rather than an RNG one.
 *   - The mix avalanches hard on the FIRST call, so seeds 1, 2, 3... give
 *     unrelated streams. Squads are seeded by index; a generator whose early
 *     draws track its seed would make every enemy squad behave identically.
 */

/** The simulation's random source. Deterministic, snapshottable, never global. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, `maxExclusive`). Returns 0 for a degenerate range. */
  int(maxExclusive: number): number
  /** Uniform in [`min`, `max`). */
  range(min: number, max: number): number
  /** A uniformly chosen element, or `undefined` for an empty array. */
  pick<T>(items: readonly T[]): T | undefined
  /**
   * A new independent stream, seeded from (and advancing) this one. Lets a
   * subsystem draw as much as it likes without shifting everyone else's stream,
   * which is what stops "the AI now considers one extra target" from changing
   * every bullet's spread in the mission.
   */
  fork(): Rng
  /** The stream position, as one finite integer. */
  getState(): number
  /** Resume from a position produced by `getState`, on any instance. */
  setState(state: number): void
}

/** The golden-ratio stride. Odd, so adding it repeatedly visits all 2^32 states. */
const STRIDE = 0x9e3779b9

const MIX_A = 0x21f0aad5
const MIX_B = 0x735a2d97

/** 2^32, the divisor that maps a uint32 onto [0, 1). */
const UINT32_SCALE = 4294967296

/**
 * Create a stream from a seed. Two calls with the same seed are completely
 * independent objects that produce identical sequences.
 */
export function createRng(seed: number): Rng {
  // `>>> 0` normalises anything the caller passes — a negative seed, a float,
  // a value past 2^32 — into the uint32 the state actually is, rather than
  // letting a non-integer state silently poison every subsequent draw.
  let state = seed >>> 0

  /** One step of splitmix32: advance the counter, return the avalanched output. */
  const nextUint32 = (): number => {
    state = (state + STRIDE) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), MIX_A)
    z = Math.imul(z ^ (z >>> 15), MIX_B)
    return (z ^ (z >>> 15)) >>> 0
  }

  const next = (): number => nextUint32() / UINT32_SCALE

  const int = (maxExclusive: number): number => {
    // `Math.floor` of NaN is NaN, and `NaN > 0` is false, so this one guard
    // covers NaN, zero and negative ranges. Returning 0 rather than throwing:
    // callers reach here with `entities.length`, which is legitimately 0 when
    // the last enemy dies, and a throw there would be a crash on a win.
    const n = Math.floor(maxExclusive)
    if (!(n > 0)) return 0
    // A degenerate range draws nothing, so the stream position depends only on
    // the choices actually made — the same run always consumes the same draws.
    const v = Math.floor(next() * n)
    // `next()` can return a value within one ulp of 1 for large `n`, where the
    // multiply rounds up to exactly `n`. Clamping costs a comparison and
    // removes an out-of-bounds index that would appear once in billions of
    // draws and be unreproducible from the bug report.
    return v < n ? v : n - 1
  }

  const range = (min: number, max: number): number => min + next() * (max - min)

  return {
    next,
    int,
    range,
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined
      return items[int(items.length)]
    },
    fork(): Rng {
      // Seeding the child from a DRAW rather than from the raw state: the raw
      // state and its successor are one stride apart, and while splitmix's mix
      // would still separate them, seeding from an already-avalanched value
      // makes the independence a property of the seed itself.
      return createRng(nextUint32())
    },
    getState: (): number => state,
    setState: (restored: number): void => {
      state = restored >>> 0
    },
  }
}
