/**
 * What the renderer is handed each frame (ticket 010).
 *
 * Deliberately a PLAIN ARRAY OF PLAIN DATA. These were built from level spawn
 * data before there was a sim and are now built by `core/session` from `World`;
 * the shape did not change and neither did the renderer, because the renderer
 * never depended on `World` in the first place.
 */

/** One drawable thing in the world this frame. */
export interface RenderEntity {
  /** Stable across frames. Drives instance matching, phase offset and facing memory. */
  readonly id: number
  /** Which sprite source to draw from: `'soldier'`, `'tree1'`, `'bush'`, ... */
  readonly unit: string
  /** Animation name within that source. Static props use their single clip. */
  readonly animation: string
  /** World position on the ground plane. */
  readonly x: number
  readonly z: number
  /** Ground height at that position — the sprite's feet sit here. */
  readonly y: number
  /** Direction the entity is facing, on the ground plane. `(0, 0)` means "unchanged". */
  readonly dx: number
  readonly dz: number
  /**
   * When the current animation started, on the renderer's clock, in seconds.
   * A one-shot `die` measures its hold from here, so it must not drift.
   */
  readonly animationStart: number
  /** Optional multiply tint, `0xrrggbb`. Absent means untinted. */
  readonly tint?: number | undefined
}
