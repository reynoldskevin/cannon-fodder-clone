/**
 * Formation geometry (ticket 007): where a follower stands, relative to a
 * leader who is facing somewhere.
 *
 * Pure arithmetic, deliberately separated from the system that calls it. The
 * shape of the wedge is the part a designer re-tunes and the part a test can
 * assert on its own; the tick loop around it is not.
 *
 * TWO SPACES, ONE ROTATION. A slot is authored in the leader's LOCAL frame —
 * "one row back and half a row to the left" — and rotated into the tile frame by
 * the leader's facing at the moment it is asked for. Authoring the offsets in
 * tile space instead is the bug the acceptance criteria call out by name: a
 * wedge welded to world north sits correctly behind a leader walking south and
 * marches in front of him on the way back.
 *
 * Allocation-free by construction: every function here returns a number, so a
 * per-tick loop over a squad produces no vectors for the nursery to collect.
 */

/**
 * How far a slot sits to the side, as a fraction of how far it sits back.
 *
 * This sets the ANGLE of the V, not its aspect ratio, and the two are easy to
 * confuse: row `r` sits `r * spacing` behind the leader and its two men sit
 * `0.7 * r * spacing` either side, so the row is `1.4 * r * spacing` wide. The
 * formation is therefore WIDER than it is long — each flank line runs about 35
 * degrees off the leader's back — which is the shape that reads as a squad
 * abreast from the game's fixed camera angle rather than as a queue. Below 1 is
 * still what stops it flattening into a rank: each man is nearer the leader's
 * centre line than he is behind it, so the wedge has a nose.
 *
 * It is not a terrain constant. A wedge this wide does not fit a one-tile gap
 * at all; what gets a squad through a corridor is `catchUpDistance` in the
 * system, which retires the slot and puts the follower on the flow field.
 */
const WEDGE_SPREAD = 0.7

/**
 * How far back slot `rank` sits, in tiles. Negative — the wedge is BEHIND.
 *
 * Rank 0 is the leader and has no offset at all: he is the origin the rest are
 * measured from, so the formation cannot drift away from the man it follows.
 * Ranks pair up into rows (1 and 2 in the first row, 3 and 4 in the second), so
 * a squad widens as much as it lengthens instead of forming a single file.
 */
export function slotForward(rank: number, spacing: number): number {
  if (rank <= 0) return 0
  return -Math.ceil(rank / 2) * spacing
}

/**
 * How far to the leader's right slot `rank` sits, in tiles. Odd ranks take the
 * left of the wedge, even ranks the right, so consecutive members of a roster
 * alternate sides rather than piling onto one flank.
 */
export function slotRight(rank: number, spacing: number): number {
  if (rank <= 0) return 0
  const row = Math.ceil(rank / 2)
  const side = rank % 2 === 1 ? -1 : 1
  return side * row * spacing * WEDGE_SPREAD
}

/**
 * The x component of a local (forward, right) offset rotated into tile space by
 * a unit facing vector.
 *
 * The leader's right-hand vector is (-facingY, facingX). Which of the two
 * perpendiculars is called "right" only mirrors the wedge, and a wedge is
 * symmetric, so the choice is arbitrary — but it must be made ONCE and shared
 * by both axes below, or the two components describe different rotations and
 * the formation shears instead of turning.
 */
export function rotatedX(forward: number, right: number, facingX: number, facingY: number): number {
  return facingX * forward - facingY * right
}

/** The y component of the same rotation. See `rotatedX`. */
export function rotatedY(forward: number, right: number, facingX: number, facingY: number): number {
  return facingY * forward + facingX * right
}
