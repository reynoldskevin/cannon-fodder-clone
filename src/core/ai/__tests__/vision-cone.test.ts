import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'
import { VISION_HALF_ANGLE_COS, DEFAULT_AWARENESS_RADIUS_TILES, DEFAULT_ENEMY_FACING } from '../tuning'

/**
 * Ticket 038 — an enemy sees what is in front of him.
 *
 * `acquire` tested team, squared distance and a sightline raycast, and NOTHING
 * about direction: the scan was a disc, so a man could be noticed from directly
 * behind. This gives it a forward arc.
 *
 * THE DEFAULT FACING IS SOUTH, and it is read off the shipped maps rather than
 * picked. Level 1 spawns its avatars at y = 39, 41 against enemies at y = 6, 9,
 * 13; level 2 spawns avatars at y = 44, 45 against enemies from y = 8. The squad
 * arrives from the south on both, so a garrison facing south is one facing the
 * way the player actually comes. A default of north would leave every enemy in
 * the game staring away from the fight, which is not a stealth mechanic but a
 * broken one.
 *
 * In this grid `+z` is south and `+x` is east, matching `session/index.ts`'s
 * `-z is north` convention.
 */

/** Where a man `distance` tiles away at `degrees` off the facing stands, in tiles. */
const offAxis = (
  originX: number,
  originY: number,
  degrees: number,
  distance: number,
): { x: number; y: number } => {
  const radians = (degrees * Math.PI) / 180
  return {
    // The default facing is +z, so the axis is the y axis and the swing is in x.
    x: originX + Math.sin(radians) * distance,
    y: originY + Math.cos(radians) * distance,
  }
}

describe('the arc is a front arc', () => {
  it('a man three tiles in FRONT is noticed, exactly as before', () => {
    // The control. Without it, an enemy that had simply gone blind would satisfy
    // every "does not see him" case below.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 3, 'enemy')
    r.spawn(10, 6, 'player', 10_000) // three tiles SOUTH — the way he is looking
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the same man three tiles BEHIND is not', () => {
    /**
     * THE TICKET, IN ONE ASSERTION. Identical distance, identical clear
     * sightline, identical everything but the side of him it is on.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 6, 'enemy')
    r.spawn(10, 3, 'player', 10_000) // three tiles NORTH — behind him
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('nor is one far behind but well inside his sight range', () => {
    // Guards against a cone that is really a shortened sight range.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 8, 'enemy')
    r.spawn(10, 2, 'player', 10_000) // six tiles north, inside the twelve he sees
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
    const r = rig(OPEN)
    const enemy = r.spawn(6, 2, 'enemy')
    const player = r.spawn(6, 4, 'player', 10_000)
    const at = offAxis(6, 2, 50, DISTANCE)
    r.place(player.id, at.x, at.y)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and a man 70 degrees off it is not', () => {
    expect(Math.cos((70 * Math.PI) / 180)).toBeLessThan(VISION_HALF_ANGLE_COS)
    const r = rig(OPEN)
    const enemy = r.spawn(6, 2, 'enemy')
    const player = r.spawn(6, 4, 'player', 10_000)
    const at = offAxis(6, 2, 70, DISTANCE)
    r.place(player.id, at.x, at.y)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and it is symmetric — 50 degrees the other way is seen too', () => {
    // A cone implemented with a signed comparison rather than an absolute one
    // would see half the arc and be blind on the other side, which reads as an
    // enemy who can only be flanked from one direction.
    const r = rig(OPEN)
    const enemy = r.spawn(12, 2, 'enemy')
    const player = r.spawn(12, 4, 'player', 10_000)
    const at = offAxis(12, 2, -50, DISTANCE)
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
    const r = rig(OPEN)
    const enemy = r.spawn(10, 6, 'enemy')
    const player = r.spawn(10, 6, 'player', 10_000)
    // Half the awareness radius directly BEHIND him — comfortably inside it, and
    // derived so a retune of the radius cannot leave this fixture outside.
    r.place(player.id, 10, 6 - DEFAULT_AWARENESS_RADIUS_TILES * 0.5)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the exception really is a short one', () => {
    // The guard on the other side: an awareness radius as long as his sight
    // would delete the cone entirely while leaving every case above passing.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 6, 'enemy')
    const player = r.spawn(10, 6, 'player', 10_000)
    r.place(player.id, 10, 6 - DEFAULT_AWARENESS_RADIUS_TILES * 2)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})

describe('the arc does not replace anything the scan already did', () => {
  it('a man in front but beyond sight range is still not seen', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(4, 0, 'enemy')
    r.spawn(4, 9, 'player', 10_000) // nine tiles is inside twelve...
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')

    const far = rig(OPEN, { sightRangeTiles: 3 })
    const farEnemy = far.spawn(4, 0, 'enemy')
    far.spawn(4, 9, 'player', 10_000) // ...but not inside three
    far.run(10)
    expect(far.ai.stateOf(farEnemy.id)).toBe('idle')
  })

  it('and a man in front behind a wall is still not seen', () => {
    // The sightline raycast is untouched. A cone that replaced it rather than
    // joining it would let enemies see through cover in the direction they face.
    const WALL = `
      ....................
      ....................
      ####################
      ....................
      ....................
      ....................
      ....................
      ....................
      ....................
      ....................
    `
    const r = rig(WALL)
    const enemy = r.spawn(10, 1, 'enemy')
    r.spawn(10, 5, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and a player unit is still never given a state of its own', () => {
    const r = rig(OPEN)
    const mine = r.spawn(10, 3, 'player', 10_000)
    r.spawn(10, 6, 'enemy')
    r.run(4)
    expect(r.ai.stateOf(mine.id)).toBeUndefined()
  })
})

describe('the default facing', () => {
  it('is south, which is the way the squad arrives on both shipped maps', () => {
    expect(DEFAULT_ENEMY_FACING.dz).toBeGreaterThan(0)
    expect(DEFAULT_ENEMY_FACING.dx).toBe(0)
  })

  it('and it is a unit vector, because the cone test is a dot product', () => {
    // A non-normalised default would scale the dot product and silently widen or
    // narrow the arc for every enemy that had not moved yet.
    const { dx, dz } = DEFAULT_ENEMY_FACING
    expect(Math.hypot(dx, dz)).toBeCloseTo(1, 10)
  })
})
