import { describe, it, expect } from 'vitest'
import { rig } from './rig'
import {
  DEFAULT_AWARENESS_RADIUS_TILES,
  DEFAULT_SIGHT_RANGE_TILES,
  DEFAULT_ALERT_RADIUS_TILES,
  VISION_HALF_ANGLE_COS,
} from '../tuning'

/**
 * Ticket 046 — the 360-degree awareness radius rises from two tiles to four.
 *
 * WHAT IT IS: the distance inside which an enemy notices a living target in ANY
 * direction, his 120-degree arc included. Outside it the arc decides; inside it
 * nothing about direction matters at all.
 *
 * WHY IT MOVED. Two tiles is arm's length, and it made the exception almost
 * literal: a soldier could stand three tiles off a sentry's back — well clear of
 * touching him, in the open, with a clear line — and never be noticed. Four is
 * still short enough to be an exception rather than a rule.
 *
 * THE CASES BELOW ARE ASSERTED AT REAL DISTANCES, NOT DERIVED FROM THE CONSTANT.
 * Everywhere else in this suite a fixture that says `RADIUS * 0.5` is right to,
 * because it is testing the mechanism and wants to survive a retune. These cases
 * ARE the retune, so a derived distance would pass at two tiles and at forty and
 * assert nothing about either. Three and eight are written out, and moving the
 * constant is meant to fail them.
 */

/** A 20 x 20 arena, so a man in its northern half has room behind him. */
const TALL = '\n' + Array.from({ length: 20 }, () => '  ' + '.'.repeat(20)).join('\n') + '\n'

/** An enemy in the northern half, settled on the inward facing that gives him. */
const sentry = (r: ReturnType<typeof rig>, tileX: number, tileY: number) => {
  const enemy = r.spawn(tileX, tileY, 'enemy')
  r.run(1)
  const facing = r.ai.facingOf(enemy.id)
  if (facing === undefined) throw new Error('no facing')
  return { enemy, facing }
}

describe('an enemy notices a man three tiles behind him', () => {
  it('though he is looking the other way', () => {
    /**
     * THE TICKET, IN ONE ASSERTION, and it is the exact case that failed before
     * it: at two tiles this man was invisible. He is due NORTH of a sentry whose
     * inward facing points south, so the arc rejects him and only the radius can
     * find him.
     */
    const r = rig(TALL)
    const { enemy, facing } = sentry(r, 10, 8)
    // The fixture's premise: he really is facing away from where the player will
    // stand. Without this the case could pass on a sentry who happened to look
    // north, which would make it a test of the arc rather than of the radius.
    expect(facing.dz).toBeGreaterThan(0)
    r.spawn(10, 5, 'player', 10_000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and that is a change, not something two tiles already did', () => {
    // States the old value's consequence as arithmetic rather than as a claim in
    // a comment. Three tiles was outside two and is inside four; a revert makes
    // this fail alongside the case above rather than leaving it to be explained.
    expect(3).toBeGreaterThan(2)
    expect(3).toBeLessThanOrEqual(DEFAULT_AWARENESS_RADIUS_TILES)
  })
})

describe('but it has not become a disc', () => {
  it('a man eight tiles behind him is still not noticed', () => {
    /**
     * THE GUARD, and the one that matters most: a radius raised far enough
     * DELETES the vision cone, and it deletes it silently — every "he sees what
     * is in front of him" case in `vision-cone.test.ts` keeps passing, because a
     * man in front is noticed either way. Only a case from BEHIND can tell the
     * difference, and this is it. Eight tiles is outside four and comfortably
     * inside his twelve of sight, so nothing but the arc is keeping him hidden.
     */
    const r = rig(TALL)
    const { enemy, facing } = sentry(r, 10, 10)
    expect(facing.dz).toBeGreaterThan(0)
    r.spawn(10, 2, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and the radius stays a small part of sight', () => {
    // The same guard as a bound rather than a scenario, so a future retune that
    // goes too far fails on the number as well as on the behaviour.
    expect(DEFAULT_AWARENESS_RADIUS_TILES).toBeLessThan(DEFAULT_SIGHT_RANGE_TILES / 2)
  })
})

describe('and nothing else about detection moved', () => {
  it('sight, hearing and the arc are where ticket 038 left them', () => {
    /**
     * THE BLAST-RADIUS CHECK. This ticket is one constant. A retune that also
     * widened the arc or extended sight would be a different change wearing this
     * ticket's name, and every case above would still pass — they are all about
     * a man standing behind somebody.
     */
    expect({
      radius: DEFAULT_AWARENESS_RADIUS_TILES,
      sight: DEFAULT_SIGHT_RANGE_TILES,
      hearing: DEFAULT_ALERT_RADIUS_TILES,
      arc: VISION_HALF_ANGLE_COS,
    }).toEqual({ radius: 4, sight: 12, hearing: 14, arc: 0.5 })
    /**
     * THE RADIUS IS PINNED EXACTLY HERE AND NOWHERE ELSE, on purpose. The
     * scenarios above deliberately leave a band — they pass at three as well as
     * at four, because what they assert is that a man three tiles back is seen
     * and one eight tiles back is not, which is the behaviour the ticket asked
     * for rather than the digit. Mutation-checked: 2, 8 and 12 all fail those
     * scenarios; 3 does not, and this line is what catches it.
     */
  })
})
