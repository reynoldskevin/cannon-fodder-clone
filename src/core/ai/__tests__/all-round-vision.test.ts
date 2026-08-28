import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { rig } from './rig'
import { DEFAULT_ENEMY_FACING } from '../tuning'

/**
 * Ticket 086 — an enemy sees in every direction.
 *
 * REPLACES `vision-cone.test.ts`, which was named after a mechanic that no
 * longer exists. Ticket 038 gave sight a 120° forward arc, so a player could
 * walk up behind a guard in the open and go unnoticed; sight is now what hearing
 * has always been — a question about range and line of sight, asked all round.
 *
 * THE INTERESTING HALF OF THIS FILE IS THE SECOND HALF. Widening an angle is one
 * deleted comparison and hard to get wrong; what is easy to get wrong is
 * deleting one comparison too many. Range, walls and team filtering sat beside
 * the arc in the same scan, and the group that guards them is carried over from
 * the old file UNCHANGED, because those are the regressions this could actually
 * cause.
 *
 * In this grid `+z` is south and `+x` is east, matching `session/index.ts`'s
 * `-z is north` convention.
 */

/**
 * A 20 x 20 arena, so a man placed north of its centre has real map on both
 * sides of him. Inherited from the old file: an enemy's default facing points at
 * the middle of the level, so "behind him" needs room to exist.
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
  const dx = facing.dx * Math.cos(r) - facing.dz * Math.sin(r)
  const dz = facing.dx * Math.sin(r) + facing.dz * Math.cos(r)
  return { x: originX + dx * distance, y: originY + dz * distance }
}

/** Spawn an enemy, settle his default facing, and report it. */
const sentry = (r: ReturnType<typeof rig>, tileX: number, tileY: number) => {
  const enemy = r.spawn(tileX, tileY, 'enemy')
  r.run(1)
  const facing = r.ai.facingOf(enemy.id)
  if (facing === undefined) throw new Error('no facing')
  return { enemy, facing }
}

/**
 * SIX TILES, KEPT FROM THE OLD FILE. It is outside the four-tile awareness
 * radius that used to notice a man in any direction, and inside the twelve a
 * sentry can see — so under the OLD rule the behind-him case below was reliably
 * idle. Keeping the distance is what makes the inversion mean something: same
 * fixture, opposite expectation.
 */
const GAP = 6

describe('sight is all round', () => {
  it('a man six tiles in FRONT is noticed, exactly as before', () => {
    // The control. Without it, an enemy who had simply become omniscient — or
    // one who had gone blind — would satisfy some of what follows.
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 8)
    r.spawn(10, 8 + GAP, 'player', 10_000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the same man six tiles BEHIND is noticed too', () => {
    /**
     * THE TICKET, IN ONE ASSERTION, and it is the exact case that used to prove
     * the opposite: identical distance, identical clear sightline, identical
     * everything but the side of him it is on.
     */
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 8)
    r.spawn(10, 8 - GAP, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and one far behind but well inside his sight range', () => {
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 7)
    r.spawn(10, 1, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('at every angle around him, not just the two that used to differ', () => {
    /**
     * SWEPT RATHER THAN SAMPLED AT THE OLD BOUNDARY. The previous file tested 50°
     * and 70° because those bracketed a 60° edge; with no edge left, the useful
     * question is whether ANY bearing is still dark. 100° and 170° are the ones
     * that would survive a half-hearted fix — a widened arc rather than a deleted
     * one.
     */
    for (const degrees of [0, 45, 90, 100, 135, 170, 180, 225, 270, 315]) {
      const r = rig(TALL)
      const { enemy, facing } = sentry(r, 10, 10)
      const at = offAxis(10, 10, facing, degrees, GAP)
      r.spawn(at.x, at.y, 'player', 10_000)
      r.run(10)
      expect({ degrees, state: r.ai.stateOf(enemy.id) === 'idle' }).toEqual({
        degrees,
        state: false,
      })
    }
  })
})

describe('and it did not become omniscience', () => {
  /**
   * CARRIED OVER UNCHANGED from `vision-cone.test.ts`'s "the arc does not replace
   * anything the scan already did". The arc was one of five filters in the same
   * loop; these are the other four, and deleting one comparison too many is the
   * only way this ticket could do real damage.
   */
  it('a man beyond sight range is still not seen', () => {
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

  it('and a man behind a wall is still not seen', () => {
    // The sightline raycast is untouched. All-round sight through cover would be
    // a far worse bug than the one this ticket fixes.
    const rows = Array.from({ length: 20 }, (_, y) => '  ' + (y === 6 ? '#' : '.').repeat(20))
    const r = rig('\n' + rows.join('\n') + '\n')
    const { enemy } = sentry(r, 10, 4)
    r.spawn(10, 9, 'player', 10_000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('including one behind a wall and behind him, which is the new corner', () => {
    /**
     * THE CASE THE OLD FILE COULD NOT HAVE HAD. Cover to the REAR was previously
     * redundant — the arc rejected that man before the raycast ever ran — so
     * nothing ever checked that the raycast holds in the direction sight has just
     * been opened up.
     */
    const rows = Array.from({ length: 20 }, (_, y) => '  ' + (y === 6 ? '#' : '.').repeat(20))
    const r = rig('\n' + rows.join('\n') + '\n')
    const { enemy } = sentry(r, 10, 9) // south of the wall, facing the centre
    r.spawn(10, 4, 'player', 10_000) // north of it — behind him AND behind cover
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

describe('facing survives, as a pose rather than a filter', () => {
  /**
   * NOT DELETED WITH THE ARC, though it was the arc that read it.
   * `session/index.ts` calls `ai.facingOf` to decide which way a STATIONARY
   * enemy's sprite points; removing the facing memory would leave every standing
   * guard drawn facing whatever the renderer last remembered.
   */
  it('an enemy still reports a facing', () => {
    const r = rig(TALL)
    const { enemy } = sentry(r, 10, 8)
    expect(r.ai.facingOf(enemy.id)).toBeDefined()
  })

  it('and the fallback is still a unit vector — now because a sprite reads it', () => {
    /**
     * THE REASON CHANGED, THE REQUIREMENT DID NOT. This used to matter because a
     * non-normalised facing would scale the arc's dot product; there is no dot
     * product now. It matters because `renderEntities` takes `dx`/`dz` as a
     * direction, and a NaN or zero-length one draws a man pointing nowhere.
     */
    const { dx, dz } = DEFAULT_ENEMY_FACING
    expect(Math.hypot(dx, dz)).toBeCloseTo(1, 10)
    expect(Number.isFinite(dx) && Number.isFinite(dz)).toBe(true)
  })
})

describe('the arc left nothing behind', () => {
  it('no vision half-angle, and no awareness radius that only softened it', () => {
    /**
     * READ FROM THE SOURCE because a deleted export cannot be imported to be
     * asserted about — the file would not compile. `DEFAULT_AWARENESS_RADIUS_TILES`
     * existed for one reason, quoted in its own comment: "nobody is invisible at
     * arm's length". With sight all round, every man within four tiles is seen by
     * the rule itself, so a surviving constant would be dead machinery that still
     * looks live to the next reader.
     */
    const tuning = readFileSync(new URL('../tuning.ts', import.meta.url), 'utf8')
    expect(tuning).not.toContain('VISION_HALF_ANGLE_COS')
    expect(tuning).not.toContain('AWARENESS_RADIUS')
  })

  it('and no comment in the AI still calls sight an arc', () => {
    /**
     * THE ANTI-PATTERN THIS PROJECT KEEPS MEETING: a comment that describes a
     * mechanic the code no longer has. `system.ts` explained the scan as "A
     * FORWARD ARC, NOT A DISC" in three places; a reader who trusts that will
     * spend an afternoon looking for where the cone is enforced.
     */
    const system = readFileSync(new URL('../system.ts', import.meta.url), 'utf8')
    expect(system).not.toMatch(/forward arc|the arc\b|vision cone/i)
  })
})
