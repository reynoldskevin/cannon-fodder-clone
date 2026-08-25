/**
 * Sprite animation playback (ticket 010) — which frame, at what time.
 *
 * Engine-free: the renderer turns the frame index into an atlas rect, but the
 * decision of *which* index is pure arithmetic and is tested as such.
 */

/** The playback properties of one animation, straight out of `sprites.manifest.json`. */
export interface AnimationClip {
  /** How many frames the animation has. At least 1. */
  readonly frameCount: number
  /** Frames per second, as declared by the manifest. */
  readonly fps: number
  /** `true` to cycle forever (walk); `false` to play once and hold (die). */
  readonly loop: boolean
}

/**
 * Golden-ratio conjugate. Multiplying an integer id by it and taking the
 * fractional part is a cheap low-discrepancy sequence: consecutive ids land far
 * apart in [0, 1) rather than clustering, which is exactly the property a
 * per-entity phase offset needs.
 */
const GOLDEN = 0.618033988749895

/**
 * The frame to show `seconds` into an animation.
 *
 * ONE-SHOT ANIMATIONS HOLD. `die` must play once and stay on its final frame —
 * a looping death animation resurrects corpses every third of a second, which
 * is both a gameplay lie and the sort of thing that shows up in a demo.
 *
 * Every degenerate input is answered with a valid in-range integer rather than
 * a NaN: this is called once per entity per frame, and a single NaN frame index
 * would sample garbage UVs for a whole batch.
 */
export function frameAt(clip: AnimationClip, seconds: number): number {
  const frameCount = Number.isFinite(clip.frameCount) ? Math.floor(clip.frameCount) : 1
  if (frameCount <= 1) return 0

  // A zero or negative fps has no meaningful playback rate; freeze on frame 0
  // rather than dividing the timeline by nothing.
  if (!Number.isFinite(clip.fps) || clip.fps <= 0) return 0

  // Negative time is "before the animation started" (a phase offset can push an
  // entity there); non-finite time is a broken clock. Both show frame 0.
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0

  const elapsed = Math.floor(t * clip.fps)
  if (!Number.isFinite(elapsed)) return 0

  if (!clip.loop) return Math.min(elapsed, frameCount - 1)
  return ((elapsed % frameCount) + frameCount) % frameCount
}

/**
 * A stable per-entity phase offset in [0, 1) cycles.
 *
 * A squad spawned on the same tick would otherwise animate in perfect lockstep,
 * which reads as one four-legged organism rather than four soldiers. Derived
 * from the id so it survives a despawn/respawn and needs no stored state.
 */
export function phaseOffset(id: number): number {
  if (!Number.isFinite(id)) return 0
  const n = Math.abs(Math.trunc(id))
  const fraction = (n * GOLDEN) % 1
  // Guard the fractional part back into range: floating error at large ids can
  // land exactly on 1, and callers rely on this being < 1.
  return fraction >= 1 || fraction < 0 ? 0 : fraction
}
