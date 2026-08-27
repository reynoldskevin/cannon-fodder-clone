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
  /**
   * How much of this sprite is under the water surface, as a fraction of its
   * own drawn height, in `[0, 1)` (ticket 041). Zero for almost everything.
   *
   * A FRACTION AND NOT A `y` OFFSET, which is the only reason this field can
   * exist here at all. `core/view/submersion.ts` decides it from the tile a unit
   * is standing on; converting it to world units needs the sprite's height and
   * the renderer's vertical pre-stretch, and `src/core/**` may not import the
   * renderer to learn either. So the fraction crosses the boundary and
   * `src/render/entity-renderer.ts` does the multiplication.
   *
   * OPTIONAL HERE, LIKE `tint`, AND ABSENT MEANS ZERO — the same bargain for
   * the same reason: the neutral value is also the value almost every drawable
   * has, and 0 makes the renderer's offset exactly zero rather than merely
   * small, so a producer that says nothing draws precisely what it drew before
   * this field existed. `EntityRenderer` spells that default once, at the two
   * points it reads the field.
   *
   * THE PRODUCERS DO NOT TAKE THAT OPTION, THOUGH ONLY ONE OF THEM IS HELD TO
   * IT. `core/session` returns `SubmergedRenderEntity`, where the field is
   * required, so its producers cannot forget. The scenery in `src/render` is
   * typed plain `RenderEntity` and states 0 by choice rather than by compulsion —
   * worth knowing before trusting the field to be present on anything that did
   * not come out of the session. Props and trees say 0 and mean it, because a palm is
   * rooted where the level author placed it and "its tile is flooded" was never
   * a reason to bury it.
   */
  readonly submersion?: number | undefined
  /**
   * Whether this unit is DISCHARGING HIS WEAPON right now (ticket 044).
   *
   * ONE FACT, READ BY THE PICTURE AND BY THE SOUND. The fire animation is chosen
   * from it and the sustained gunfire voice is gated on it, so a man cannot be
   * drawn firing while silent or heard firing while still. That is not tidiness:
   * ticket 042 shipped precisely that split — a wading man played the fire clip
   * while the water gate refused every round — because the animation asked
   * `isFiring` ("holds an order") and the rule asked the terrain. Two functions
   * that agree today is the shape this project has now paid for three times
   * (025, 041, 042), so there is deliberately only one.
   *
   * NOT "HOLDS A FIRE ORDER". A man in the river holds his order and resumes the
   * instant he lands; he is not firing while he is in it, and this says so.
   *
   * Optional, and absent means false, on the same bargain as `submersion` above:
   * trees and props do not fire, and a producer that says nothing draws what it
   * drew before the field existed.
   */
  readonly firing?: boolean | undefined
  /** Optional multiply tint, `0xrrggbb`. Absent means untinted. */
  readonly tint?: number | undefined
}

/**
 * A `RenderEntity` whose submersion has actually been DECIDED rather than left
 * to the default.
 *
 * The distinction is worth a name because the two sides of the field want
 * different things. A CONSUMER — `EntityRenderer`, and anything else handed an
 * arbitrary drawable — has to cope with the field being absent, so the wire
 * shape keeps it optional. A PRODUCER that reads terrain, which is every
 * producer in this repo, has no excuse for omitting it: `undefined` there would
 * mean "nobody looked", which is indistinguishable from "he is dry" exactly
 * when it matters. `core/session` therefore promises the stronger shape, and a
 * caller reading `.submersion` off it gets a number rather than a maybe.
 */
export interface SubmergedRenderEntity extends RenderEntity {
  readonly submersion: number
}
