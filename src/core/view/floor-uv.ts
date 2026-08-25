/**
 * Floor UVs (ticket 009c) — where a point on the terrain samples the tileable
 * jungle floor.
 *
 * Engine-free like the rest of `src/core/view`: the renderer bakes these numbers
 * into a `uv` attribute, so the decision that actually matters — that UVs come
 * from WORLD position rather than from each tile's own 0..1 range — is unit
 * tested without a WebGL context.
 *
 * WHY WORLD POSITION. `tools/spritegen` emits `floor.png` at 512x512 and keeps
 * it out of the atlas precisely so it can wrap. Per-tile UVs would restart that
 * 512px image on every one of level 1's 2565 tiles: 2565 identical stamps, each
 * with a hard discontinuity on all four edges, which is a tiled bathroom rather
 * than a jungle floor. Dividing world x/z by a repeat distance instead gives one
 * continuous field over the whole map, and `RepeatWrapping` does the rest on the
 * GPU.
 *
 * WHY NO MODULO HERE. The level is centred on the origin (see `projection.ts`),
 * so half of every map has negative world x and z. `x % n` is negative there and
 * `Math.abs(x) % n` mirrors the texture across the centre line — a seam straight
 * down the middle of the map, which is exactly the artefact this replaces. The
 * honest answer is to emit unbounded UVs (level 1 spans roughly -4.75..4.75
 * repeats, nowhere near float precision limits) and let the wrap mode fold them.
 */

/** UV coordinate into the floor texture. Unbounded — `RepeatWrapping` folds it. */
export interface FloorUv {
  readonly u: number
  readonly v: number
}

/**
 * World-space edge length of one repeat of `floor.png`.
 *
 * CHOSEN BY EYE against level 1 at the 55-degree camera, then justified.
 *
 * The texture's largest features — the monstera fronds — occupy roughly a fifth
 * of its 512px, so a fern's on-screen size is about `repeat / 5` world units,
 * against a 1.539-unit soldier and 1-unit tiles. All three values below were
 * built and looked at on level 1, at the closest zoom and at maximum zoom-out:
 *
 *   repeat  fern size   fern vs soldier   repeats across level 1 (57 tiles)
 *      4      0.8u          0.52x                  14.3
 *      6      1.2u          0.78x                   9.5
 *      8      1.6u          1.04x                   6.6
 *
 * At 4 the ferns stop being plants. Even at the closest zoom the ground reads as
 * a busy stipple rather than as undergrowth, and because fourteen copies fit
 * across the map the eye starts catching the rhythm as a regular banding — the
 * one thing tiling must not do. At 8 a single frond is as tall as a soldier: it
 * is genuinely the lushest of the three standing still, but the undergrowth
 * stops being undergrowth and starts competing with the tree sprites for scale,
 * and at under seven repeats across the map each copy is large enough to
 * recognise as the same arrangement of leaves — wallpaper.
 *
 * 6 is the middle, and it is the one that survived both zoom extremes. A fern is
 * about three quarters of a soldier's height, which reads as the chest-high
 * undergrowth a figure is standing in; at maximum zoom-out the leaf litter and
 * stones are still individually legible rather than dissolving into noise; and
 * the repetition is findable if you go looking for it but does not announce
 * itself. It also puts texel density at 512/6 = 85 texels per tile, close to a
 * tile's on-screen pixel size at the closest zoom — near 1:1, so the art is
 * neither visibly soft nor wastefully oversampled.
 */
export const FLOOR_REPEAT_WORLD_UNITS = 6

/**
 * UV for a world-space ground point.
 *
 * `repeatUnits` is a parameter rather than a read of the constant so the
 * relationship is testable at any scale, and so a future level could tighten or
 * loosen the floor without a second function.
 *
 * A degenerate `repeatUnits` (0, negative, NaN) falls back to 1 rather than
 * emitting `Infinity`/`NaN` UVs, which would poison the whole merged geometry's
 * bounding sphere and silently drop the terrain from every frustum test.
 */
export function floorUv(
  worldX: number,
  worldZ: number,
  repeatUnits: number = FLOOR_REPEAT_WORLD_UNITS,
): FloorUv {
  const period = Number.isFinite(repeatUnits) && repeatUnits > 0 ? repeatUnits : 1
  return { u: worldX / period, v: worldZ / period }
}
