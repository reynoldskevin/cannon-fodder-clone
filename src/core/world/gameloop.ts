/**
 * The fixed-timestep accumulator (ticket 005).
 *
 * ARCHITECTURE.md ("Determinism"): the simulation runs at a fixed 60 Hz
 * whatever the display does, and the renderer interpolates between the last two
 * states. That separation is the whole reason a mission plays out identically
 * on a 60 Hz laptop and a 144 Hz monitor. Let frame time reach the sim directly
 * and display rate becomes an input to combat results, at which point
 * determinism — and every test that leans on it — is a fiction.
 *
 * This module is PURE and engine-free: `advance(dt)` maps real elapsed seconds
 * onto whole simulation steps and nothing else. There is no
 * `requestAnimationFrame` here and no clock read; `app/` owns both and feeds the
 * dt in, the same division of labour as `core/view/orientation.ts` holding the
 * camera maths that `render/camera-rig.ts` merely plumbs. It also means the loop
 * can be driven by a synthetic list of frame times in a test, which is how the
 * awkward cases below are covered at all.
 */

/** Seconds per simulation step. 60 Hz, fixed. */
export const FIXED_TIMESTEP = 1 / 60

/**
 * The most steps one frame may run before the backlog is discarded.
 *
 * Two failure modes bracket this number. Too low and a legitimate hitch — a
 * shader compile, a GC pause, a 100 ms frame — silently loses simulation time,
 * so the floor is six steps. Too high and a tab restored after a minute in the
 * background hands us dt = 60 s, which is 3600 steps in one frame; running them
 * blocks the main thread long enough to produce the next enormous frame, which
 * is the spiral of death. Eight steps is ~133 ms of catch-up: comfortably past
 * any real hitch, nowhere near long enough to stall a frame.
 */
export const MAX_STEPS_PER_FRAME = 8

/**
 * Slack on the "is a whole step available?" comparison, as a fraction of a step.
 *
 * A display's frame time is generally not representable in binary: `1/144`
 * rounds down, so 144 of them sum to 0.9999999999999974 s rather than 1, a hair
 * under the 60 steps of `1/60` (itself rounded) that a second should buy.
 * Compared strictly, that second yields 59 steps.
 *
 * WHAT THAT ACTUALLY COSTS, stated precisely so the next person does not have to
 * re-derive it: the shortfall is a ONE-STEP PHASE OFFSET, not a drift. With no
 * slack, cumulative steps at each second boundary at 144 Hz run 59, 119, 179,
 * 239, 299 — one behind from the first second onward, then a clean +60 every
 * second after. A ten-minute mission loses one step in total, not six hundred.
 * And 144 Hz is the only rate it touches: 30, 50, 60, 75, 90, 100, 120, 165,
 * 240 and 360 all yield 60 either way.
 *
 * So the epsilon buys something small and specific — it removes a permanent
 * off-by-one on the most common high-refresh display, so the same mission stands
 * at the same tick whether it was started on a 144 Hz panel or a 60 Hz one.
 * Cheap at a millionth of a step (16 ns): far above the accumulated float error
 * it absorbs, far below any timing signal a real frame could carry.
 *
 * THE BOUND ON THE OTHER SIDE, since a tolerance can only ever create steps. The
 * adversarial input is a frame time of exactly `FIXED_TIMESTEP - STEP_EPSILON`
 * repeated forever: each step leaves the accumulator an epsilon below zero and
 * the clamp in `advance` forgives that debt, so the deficit never accumulates
 * into a skipped step. Measured, that invents one step per 1e6 frames — roughly
 * 4.6 hours of continuous 60 Hz play per extra tick, and only for an input
 * pathologically tuned to this constant. It is a real hole, not a closed one;
 * it is simply orders of magnitude smaller than the off-by-one it removes.
 */
const STEP_EPSILON = FIXED_TIMESTEP * 1e-6

/** A fixed-timestep clock. Engine-free; `app/` drives it from rAF. */
export interface GameLoop {
  /**
   * Fold `dt` real seconds into the accumulator and report how many whole
   * simulation steps to run now.
   */
  advance(dt: number): number
  /**
   * How far into the next step we already are, in [0, 1). The renderer blends
   * the previous and current sim states by this, which is what turns 60 Hz
   * state into smooth motion on a 144 Hz display.
   */
  readonly alpha: number
  /** Drop any partial step. For a mission restart or a resume from pause. */
  reset(): void
}

export function createGameLoop(): GameLoop {
  let accumulator = 0

  return {
    advance(dt: number): number {
      // Hostile input is rejected outright rather than clamped. A negative dt
      // (a clock adjustment, a stale timestamp) must not rewind the sim, and
      // NaN added to the accumulator poisons it permanently — every subsequent
      // comparison is false and the simulation stops for good, with no error.
      // `Infinity` lands here too, which is the correct answer: an infinite
      // frame is not a frame, and the alternative is capping it to a burst of
      // catch-up steps for time that never elapsed.
      if (!Number.isFinite(dt) || dt <= 0) return 0

      accumulator += dt

      let steps = 0
      while (accumulator >= FIXED_TIMESTEP - STEP_EPSILON && steps < MAX_STEPS_PER_FRAME) {
        accumulator -= FIXED_TIMESTEP
        steps += 1
      }
      // Taking a step on the epsilon can leave the accumulator a hair below
      // zero. Left there it would make `alpha` negative and the renderer would
      // interpolate backwards past the state it has. Note this clamp is also
      // what makes the invented-step case in STEP_EPSILON possible: it writes
      // off an epsilon of debt each time rather than carrying it.
      if (accumulator < 0) accumulator = 0

      // Anything still owing is DISCARDED, not deferred. Carrying it forward
      // would hand the next frame the same oversized backlog and just move the
      // spiral one frame along. The modulo keeps the sub-step phase, so `alpha`
      // stays continuous across the discontinuity instead of snapping to zero.
      if (accumulator >= FIXED_TIMESTEP) {
        accumulator %= FIXED_TIMESTEP
      }

      return steps
    },

    get alpha(): number {
      const fraction = accumulator / FIXED_TIMESTEP
      // `accumulator` is always below one timestep by construction, but the
      // division can still round up to exactly 1 when it is within half an ulp
      // of the step. An alpha of 1 means the renderer extrapolates a frame past
      // the state it has, which reads as a one-frame jitter that is impossible
      // to reproduce; clamping to the largest value below 1 costs a comparison.
      return fraction < 1 ? fraction : 1 - Number.EPSILON
    },

    reset(): void {
      accumulator = 0
    },
  }
}
