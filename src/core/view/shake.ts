/**
 * How hard a blast shakes the camera (ticket 025).
 *
 * `CameraRig` has had a shake channel since ticket 013 — `addShake(amount)`,
 * taking the strongest request, with the decay in `camera.ts`'s `shakeStep` —
 * and NOTHING HAS EVER CALLED IT. This is the number that finally does.
 *
 * A PURE FUNCTION OF DISTANCE AND SIZE, which is what makes the falloff testable
 * without a camera at all. The rig owns the decay and the displacement; this owns
 * only "how much", and it is the only part of the three that has a choice to get
 * wrong.
 *
 * NOT SIMULATION, like the rest of the FX layer: it is fed from `Explosion`
 * after the fact, and the mission would resolve identically with the camera
 * bolted down.
 */

/**
 * How far a blast is felt, in tiles. `TILE_WORLD_SIZE` is 1, so this is also a
 * distance in world units — see `projection.ts`.
 *
 * A HARD FLOOR, NOT AN ASYMPTOTE, and that is the point of the constant. A
 * detonation the player cannot see must not move the camera: without a reach, a
 * mortar in the far corner nudges the view every time it lands and the player
 * reads it as a rendering fault, because there is nothing on screen that
 * explains it.
 *
 * Four times the largest blast the armoury ships (the grenade's 2.5 tiles), so
 * every shipped explosion has a wide margin of falloff to spend rather than
 * cutting off while it is still shaking hard. RAISE IT and distant fighting
 * starts intruding on whatever the player is doing; LOWER IT towards the blast
 * radii themselves and the shake becomes an on/off switch centred on the camera.
 */
export const SHAKE_REACH_TILES = 10

/**
 * The blast radius that shakes as hard as the rig will go, in tiles.
 *
 * Above the shipped ordnance rather than equal to it — the grenade is 2.5 tiles
 * and the rocket 2 — so the two weapons in the game sit in the middle of the
 * range and something bigger later has somewhere to go. Were this set AT the
 * grenade, every grenade would max the channel and the rocket would be
 * indistinguishable from it.
 */
const SHAKE_FULL_RADIUS_TILES = 4

/**
 * How hard a blast of `radiusTiles`, `distanceTiles` from the camera centre,
 * should shake the view. Always in `[0, 1]`.
 *
 * WRITTEN WITH POSITIVE COMPARISONS, for the reason `combat/resolution.ts` gives
 * at length: every comparison against NaN is false, so a corrupted input falls
 * through `!(radiusTiles > 0)` and `!(distance < SHAKE_REACH_TILES)` to a safe
 * answer instead of producing one. A NaN here would not be a quiet wrong number:
 * it wins the `Math.max` inside `CameraRig.addShake` against every real request
 * and then poisons the camera's position for the rest of the mission, which is
 * the most catastrophic and least visible failure this file can have. (`addShake`
 * guards its input too. Two guards, because the value passes through a `Math.max`
 * that no later check can undo.)
 */
export function shakeFor(distanceTiles: number, radiusTiles: number): number {
  // Ordnance with no blast is not an explosion, and must not become one here.
  // NaN and negative radii land in the same branch, which is the answer that
  // cannot surprise anybody: nothing moves.
  if (!(radiusTiles > 0)) return 0
  // Clamped rather than extrapolated, so an absurd radius saturates instead of
  // returning something the rig would have to clamp a second time. An infinite
  // radius fails the `<` and lands on 1.
  const strength =
    radiusTiles < SHAKE_FULL_RADIUS_TILES ? radiusTiles / SHAKE_FULL_RADIUS_TILES : 1
  // Distance is a MAGNITUDE. A negative one is a caller bug, and the safe answer
  // is the one at the origin rather than silently no shake at all — a sign error
  // upstream should be loud. NaN arrives here too, and is treated the same way.
  const distance = distanceTiles > 0 ? distanceTiles : 0
  // At and past the reach, exactly zero — see `SHAKE_REACH_TILES`. Negated form
  // deliberately, so an infinite distance also lands here.
  if (!(distance < SHAKE_REACH_TILES)) return 0
  const remaining = 1 - distance / SHAKE_REACH_TILES
  // SQUARED, so the curve is steep near the blast and shallow at the edge. A
  // linear falloff still has half its strength five tiles out, which makes every
  // grenade anywhere on screen feel like one that landed on the squad; squaring
  // keeps that reading for the ones that are actually close. Still monotonic —
  // `remaining` is in `(0, 1]` and squaring preserves order over that range —
  // which matters because a curve that dipped and rose again would give a blast
  // that shook HARDER from further away.
  return strength * remaining * remaining
}
