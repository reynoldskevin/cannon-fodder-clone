import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'

/**
 * Hearing reaches where sight cannot (tickets 038 and 012, re-grounded by 086).
 *
 * THE ORIGINAL PREMISE WAS THE VISION CONE, AND IT IS GONE. These cases were
 * written when sight was a 120 degree forward wedge, so "cannot be seen" meant
 * no more than "standing behind him" — and ticket 086 made every one of those
 * setups false, because a man in the open is now seen from any bearing.
 *
 * WHAT MAKES HEARING MATTER INSTEAD is the pair of numbers in `tuning.ts`:
 * `DEFAULT_ALERT_RADIUS_TILES` is 14 and `DEFAULT_SIGHT_RANGE_TILES` is 12. A
 * shot from thirteen tiles is heard by a man who cannot possibly see who fired
 * it, and cover does the same at any distance. That is a real gap and it is the
 * one these cases now stand in — a stronger claim than the old one, since it
 * survives whatever happens to facing.
 *
 * EARS ARE NOT DIRECTIONAL, which is the one thing here that did not change: a
 * rumour is heard from every direction, as sight now is.
 */

/** A 20 x 20 arena. The shipped `OPEN` is 20 x 10 — too short for thirteen
 * tiles of separation, which is what "heard but not seen" now requires. */
const TALL = '\n' + Array.from({ length: 20 }, () => '  ' + '.'.repeat(20)).join('\n') + '\n'

/**
 * Every sentry here is pointed SOUTH explicitly (ticket 039).
 *
 * These cases were written when the default facing was a fixed south, and the
 * word "behind" in each of their names means "north of him". Ticket 039 makes
 * the default an inward direction computed from where a man stands, so which way
 * "behind" points now depends on which half of the arena he was spawned in —
 * which is a property of the fixture, not of hearing.
 *
 * Saying it out loud is what keeps this suite about the thing it is named after.
 * The default facing has its own tests in `facing.test.ts` and
 * `shipped-facing.test.ts`.
 */
const facingSouth = (r: ReturnType<typeof rig>, tileX: number, tileY: number) => {
  const enemy = r.spawn(tileX, tileY, 'enemy')
  r.ai.face(enemy.id, 0, 1)
  return enemy
}

describe('a shot from behind', () => {
  it('is heard, even though the shooter cannot be seen', () => {
    const r = rig(TALL)
    /**
     * THIRTEEN TILES, WHICH IS THE WHOLE FIXTURE (ticket 086). It sits in the
     * two-tile gap between what a man can see (12) and what he can hear (14).
     * Under the old cone this case put the shooter SIX tiles behind — a distance
     * that means nothing now, and would have had him seen before the shot was
     * ever fired, proving the opposite of what it is named for.
     */
    const enemy = facingSouth(r, 10, 15)
    r.spawn(10, 2, 'player', 10_000) // thirteen tiles north: past his sight
    r.run(6)
    // The premise, and it is a real one again: sight alone leaves him idle.
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    r.ai.hear([r.shotAt(10, 2)])
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('turns him toward it', () => {
    // The coupling, stated directly. Without it he investigates a noise while
    // looking the other way, and walks past the man who made it.
    const r = rig(OPEN)
    const enemy = facingSouth(r, 10, 6)
    r.ai.hear([r.shotAt(10, 2)])
    r.run(20)
    const facing = r.ai.facingOf(enemy.id)!
    expect(facing.dz).toBeLessThan(0) // north, toward the shot
  })

  it('and he then acquires the man who fired it', () => {
    /**
     * THE WHOLE POINT, END TO END, and it still has somewhere to go after ticket
     * 086: the shooter starts beyond sight, so hearing is the only thing that
     * can start the walk that brings him into it.
     */
    const r = rig(TALL)
    const enemy = facingSouth(r, 10, 15)
    r.spawn(10, 2, 'player', 10_000)
    r.ai.hear([r.shotAt(10, 2)])
    let noticed = false
    for (let i = 0; i < 60 && !noticed; i += 1) {
      r.run(5)
      noticed = r.ai.stateOf(enemy.id) === 'engage'
    }
    expect(noticed).toBe(true)
  })

  it('but a shot beyond the alert radius still leaves him idle', () => {
    // The guard: "he reacts to gunfire" must not become "he reacts to all
    // gunfire", which would pull the whole map toward the first round fired and
    // delete stealth in the other direction.
    const r = rig(OPEN, { alertRadiusTiles: 3 })
    const enemy = facingSouth(r, 10, 8)
    r.ai.hear([r.shotAt(10, 1)])
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and hearing is not gated by direction either', () => {
    /**
     * Asserted as a PAIR, in front and behind at the same distance, because
     * "he heard it" on its own is satisfied by a build in which the rumour scan
     * quietly grew a wedge and the shot happened to be in front. Sight lost its
     * wedge in ticket 086; this is what stops one appearing on hearing instead.
     */
    const behind = rig(OPEN)
    const a = facingSouth(behind, 10, 6)
    behind.ai.hear([behind.shotAt(10, 2)])
    behind.run(4)

    const ahead = rig(OPEN)
    const b = facingSouth(ahead, 10, 6)
    ahead.ai.hear([ahead.shotAt(10, 10)])
    ahead.run(4)

    expect({
      behind: behind.ai.stateOf(a.id),
      ahead: ahead.ai.stateOf(b.id),
    }).toEqual({ behind: 'alert', ahead: 'alert' })
  })
})
