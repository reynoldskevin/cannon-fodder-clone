import { describe, it, expect } from 'vitest'
import { rig } from './rig'
import { VISION_HALF_ANGLE_COS, DEFAULT_AWARENESS_RADIUS_TILES, DEFAULT_ENEMY_FACING } from '../tuning'

/**
 * Ticket 038 — an enemy sees what is in front of him.
 *
 * `acquire` tested team, squared distance and a sightline raycast, and NOTHING
 * about direction: the scan was a disc, so a man could be noticed from directly
 * behind. This gives it a forward arc.
 *
 * THE DEFAULT FACING IS SOUTH, counted off the shipped maps rather than picked —
 * and it suits most of them, not all. All three of level 1's enemies sit north
 * of its squad start. Ten of level 2's fifteen do; FIVE DO NOT, and those five
 * face away from the approach. An earlier draft of this comment said "the squad
 * arrives from the south on both maps", which is simply false; review caught it
 * by counting. `tuning.ts` carries the numbers and the consequence.
 *
 * In this grid `+z` is south and `+x` is east, matching `session/index.ts`'s
 * `-z is north` convention.
 */

/**
 * A 20 x 20 arena, so its centre is tile (9.5, 9.5) and a man placed NORTH of
 * that has real map on both sides of him.
 *
 * The shipped `OPEN` is 20 x 10, which was fine while the default was a fixed
 * south: since ticket 039 an enemy's default facing points at the middle of the
 * level, so a man in the southern half faces NORTH and "behind him" runs off the
 * top of a ten-row grid. The suite needs room on both sides of its subject.
 */
const TALL = '\n' + Array.from({ length: 20 }, () => '  ' + '.'.repeat(20)).join('\n') + '\n'

/** The tile a man `distance` away at `degrees` off `facing` stands on. */
const offAxis = (
  originX: number,
  originY: number,
  facing: { dx: number; dz: number },
  degrees: number,
  distance: number,
): { x: number; y: number } => {
  const r = (degrees * Math.PI) / 180
  // Rotate the ACTUAL facing rather than assuming +z. Since ticket 039 the
  // default is a direction computed from where the man stands, so it is only
  // approximately south — a fixture that assumed due south would be a few
  // degrees out, which is exactly the margin the boundary cases below turn on.
  const dx = facing.dx * Math.cos(r) - facing.dz * Math.sin(r)
  const dz = facing.dx * Math.sin(r) + facing.dz * Math.cos(r)
  return { x: originX + dx * distance, y: originY + dz * distance }
}

/** Spawn an enemy in the northern half, settle his default facing, and report it. */
const sentry = (r: ReturnType<typeof rig>, tileX: number, tileY: number) => {
  const enemy = r.spawn(tileX, tileY, 'enemy')
  r.run(1)
  const facing = r.ai.facingOf(enemy.id)
  if (facing === undefined) throw new Error('no facing')
  return { enemy, facing }
}

describe('the arc is a front arc', () => {
  it('a man three tiles in FRONT is noticed, exactly as before', () => {
    // The control. Without it, an enemy that had simply gone blind would satisfy
    // every "does not see him" case below.
    const r = rig(TALL)
    // North of centre, so his inward default points SOUTH.
    const { enemy } = sentry(r, 10, 4)
    r.spawn(10, 7, 'player', 10_000) // three tiles south — the way he is looking
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the same man three tiles BEHIND is not', () => {
    /**
     * THE TICKET, IN ONE ASSERTION. Identical distance, identical clear
     * sightline, identical everything but the side of him it is on.
     */
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 4)
    r.spawn(10, 1, 'player', 10_000) // three tiles NORTH — behind him
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('nor is one far behind but well inside his sight range', () => {
    // Guards against a cone that is really a shortened sight range.
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 7)
    r.spawn(10, 1, 'player', 10_000) // six tiles north, inside the twelve he sees
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})

describe('the edges of the arc', () => {
  /**
   * Placed by ANGLE rather than at hand-picked tiles, and checked against the
   * production constant before being used — a fixture that silently fell outside
   * the arc it meant to be inside would assert nothing at all, which is the
   * failure mode `line-of-fire.test.ts`'s `BESIDE_OFFSET` comment describes.
   */
  const DISTANCE = 5

  it('is 120 degrees wide — 60 either side of where he looks', () => {
    // Stored as a COSINE, not as degrees: the test is a dot product against a
    // normalised offset, and a spec holding degrees would need a `Math.cos` at
    // read time — the derived-field-at-read-time both tuning surfaces forbid.
    expect(VISION_HALF_ANGLE_COS).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 10)
  })

  it('a man 50 degrees off the axis is seen', () => {
    expect(Math.cos((50 * Math.PI) / 180)).toBeGreaterThan(VISION_HALF_ANGLE_COS)
    const r = rig(TALL)
    const { enemy, facing } = sentry(r, 10, 4)
    const player = r.spawn(10, 6, 'player', 10_000)
    const at = offAxis(10, 4, facing, 50, DISTANCE)
    r.place(player.id, at.x, at.y)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and a man 70 degrees off it is not', () => {
    expect(Math.cos((70 * Math.PI) / 180)).toBeLessThan(VISION_HALF_ANGLE_COS)
    const r = rig(TALL)
    const { enemy, facing } = sentry(r, 10, 4)
    const player = r.spawn(10, 6, 'player', 10_000)
    const at = offAxis(10, 4, facing, 70, DISTANCE)
    r.place(player.id, at.x, at.y)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and it is symmetric — 50 degrees the other way is seen too', () => {
    // A cone implemented with a signed comparison rather than an absolute one
    // would see half the arc and be blind on the other side, which reads as an
    // enemy who can only be flanked from one direction.
    const r = rig(TALL)
    const { enemy, facing } = sentry(r, 10, 4)
    const player = r.spawn(10, 6, 'player', 10_000)
    const at = offAxis(10, 4, facing, -50, DISTANCE)
    r.place(player.id, at.x, at.y)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })
})

describe('but nobody is invisible at arm`s length', () => {
  it('a man directly behind him, but very close, IS noticed', () => {
    /**
     * WITHOUT THIS THE MECHANIC READS AS A BUG. A soldier able to stand pressed
     * against an enemy's back indefinitely, unnoticed, is not stealth — every
     * player who sees it reads it as the AI being broken. A man notices someone
     * at arm's length behind him.
     */
    expect(DEFAULT_AWARENESS_RADIUS_TILES).toBeGreaterThan(0)
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 4)
    const player = r.spawn(10, 4, 'player', 10_000)
    // Half the awareness radius directly BEHIND him — comfortably inside it, and
    // derived so a retune of the radius cannot leave this fixture outside.
    r.place(player.id, 10, 4 - DEFAULT_AWARENESS_RADIUS_TILES * 0.5)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the exception really is a short one', () => {
    // The guard on the other side: an awareness radius as long as his sight
    // would delete the cone entirely while leaving every case above passing.
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 4)
    const player = r.spawn(10, 4, 'player', 10_000)
    r.place(player.id, 10, 4 - DEFAULT_AWARENESS_RADIUS_TILES * 2)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})

describe('the arc does not replace anything the scan already did', () => {
  it('a man in front but beyond sight range is still not seen', () => {
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 2)
    r.spawn(10, 11, 'player', 10_000) // nine tiles is inside twelve...
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')

    const far = rig(TALL, { sightRangeTiles: 3 })
    const { enemy: farEnemy } = sentry(far, 10, 2)
    far.spawn(10, 11, 'player', 10_000) // ...but not inside three
    far.run(10)
    expect(far.ai.stateOf(farEnemy.id)).toBe('idle')
  })

  it('and a man in front behind a wall is still not seen', () => {
    // The sightline raycast is untouched. A cone that replaced it rather than
    // joining it would let enemies see through cover in the direction they face.
    // A full-width wall at y = 6, with the sentry north of it and his man south.
    const rows = Array.from({ length: 20 }, (_, y) => '  ' + (y === 6 ? '#' : '.').repeat(20))
    const r = rig('\n' + rows.join('\n') + '\n')
    const { enemy } = sentry(r, 10, 4)
    r.spawn(10, 9, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and a player unit is still never given a state of its own', () => {
    const r = rig(TALL)
    const mine = r.spawn(10, 7, 'player', 10_000)
    r.spawn(10, 4, 'enemy')
    r.run(4)
    expect(r.ai.stateOf(mine.id)).toBeUndefined()
  })
})

describe('the fallback facing is a degenerate-input guard, not a policy', () => {
  it('is still a unit vector, because the cone test is a dot product', () => {
    // A non-normalised value would scale the dot product and silently widen or
    // narrow the arc for whoever fell back to it.
    const { dx, dz } = DEFAULT_ENEMY_FACING
    expect(Math.hypot(dx, dz)).toBeCloseTo(1, 10)
  })

  it('and is only reached by a man with no direction to compute', () => {
    /**
     * SINCE TICKET 039 THIS IS NOT THE DEFAULT. An enemy who has never moved
     * faces the middle of the level, computed from where he stands — so this
     * constant is what is left when that computation has no answer, which is
     * exactly one case: a man standing ON the centre, whose offset is a zero
     * vector with no direction to normalise.
     *
     * It matters that it stays finite rather than what it points at. A NaN
     * facing loses every comparison it enters, so that one man would be blind in
     * every direction, and nothing on screen would explain it.
     */
    expect(Number.isFinite(DEFAULT_ENEMY_FACING.dx)).toBe(true)
    expect(Number.isFinite(DEFAULT_ENEMY_FACING.dz)).toBe(true)
  })
})
