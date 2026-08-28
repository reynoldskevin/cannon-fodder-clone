import { describe, it, expect } from 'vitest'
import { squadFocus, parseScrollUnlocked, type FollowUnit } from '../follow'
import type { GroundPoint } from '../camera'

/**
 * Ticket 075 — the camera follows the squad, and the player cannot move it.
 *
 * THE WHOLE OF THE DECISION IS HERE because the alternative is a line inside
 * `main.ts`'s render loop, which nothing tests: `src/app` builds a WebGL context
 * on its first statement and Vitest runs `environment: 'node'`. `parseElevation`
 * next door set the precedent for the flag — take the RAW STRING, so every
 * spelling is a unit test rather than something checked by editing the address
 * bar.
 */

/** A player unit at a position. Only the three fields the follow reads. */
const man = (x: number, z: number): FollowUnit => ({ team: 'player', x, z })
const enemy = (x: number, z: number): FollowUnit => ({ team: 'enemy', x, z })

/** Somewhere unmistakably not the origin, so a fallback cannot pass by accident. */
const LAST_LOOK: GroundPoint = { x: 41.5, z: -17.25 }

describe('the view centres on the squad', () => {
  it('on the middle of the men, not on any one of them', () => {
    const focus = squadFocus([man(0, 0), man(4, 0), man(0, 6), man(4, 6)], LAST_LOOK)
    expect(focus).toEqual({ x: 2, z: 3 })
  })

  it('and a lone survivor is centred exactly on himself', () => {
    // The end of most missions, and the case where "average of the squad" and
    // "where the man is" stop being the same sentence.
    expect(squadFocus([man(-9.5, 12.25)], LAST_LOOK)).toEqual({ x: -9.5, z: 12.25 })
  })

  it('and the enemy does not pull it, however many of them there are', () => {
    /**
     * THE FIELD IS FULL OF THEM. A level has sixteen enemies to four of your
     * men, so a centroid that forgot to filter by team would sit closer to the
     * enemy spawn than to the squad and would drift further the more of them
     * were alive — a bug that looks like a tuning problem rather than a missing
     * `filter`.
     */
    const withEnemies = squadFocus(
      [man(0, 0), man(4, 4), enemy(100, 100), enemy(120, 90), enemy(140, 110)],
      LAST_LOOK,
    )
    expect(withEnemies).toEqual({ x: 2, z: 2 })
  })
})

describe('and when there is nobody left it does NOT jump', () => {
  it('returns the fallback, untouched', () => {
    /**
     * THE DEFECT THIS TICKET EXISTS TO AVOID. An average over an empty list is
     * `0/0` or, guarded naively, `(0, 0)` — and world coordinates start at the
     * CORNER of the map. So the frame the last man dies, the camera would leave
     * the fight and show a corner of empty jungle while the player is being told
     * he failed. The mission-end hold (ticket 058) makes that three seconds long.
     */
    expect(squadFocus([], LAST_LOOK)).toEqual(LAST_LOOK)
  })

  it('and the same when only the enemy is left alive', () => {
    // The filtered list is empty even though the input is not — the case a
    // guard written as `if (units.length === 0)` gets wrong.
    expect(squadFocus([enemy(3, 3), enemy(9, 1)], LAST_LOOK)).toEqual(LAST_LOOK)
  })

  it('and it never hands back the caller`s own object to be written through', () => {
    // The fallback is the rig's live target in `main.ts`; returning it by
    // reference would let a caller that adjusted the result move the camera's
    // memory of where it was looking.
    const focus = squadFocus([], LAST_LOOK)
    expect(focus).not.toBe(LAST_LOOK)
    expect(focus).toEqual(LAST_LOOK)
  })
})

describe('the scroll flag reads only one spelling as unlocked', () => {
  it('`1` unlocks it', () => {
    expect(parseScrollUnlocked('1')).toBe(true)
  })

  it('and nothing else does', () => {
    /**
     * A CLOSED LIST, AND `true` IS IN IT ON PURPOSE. `?scroll=true` is the
     * spelling somebody reaches for first, and a parser written as "present and
     * not `0`" would honour it — along with `?scroll=0`, which plainly asks for
     * the opposite. The flag matches `?debug=1`, which is the convention this
     * codebase already has.
     */
    for (const raw of [null, undefined, '', ' ', '0', 'true', 'yes', 'on', '2', '1 ', 'scroll']) {
      expect({ raw, unlocked: parseScrollUnlocked(raw) }).toEqual({ raw, unlocked: false })
    }
  })

  it('so the default is locked, which is the point of the ticket', () => {
    // Stated on its own: every case above could be satisfied by a function that
    // returned `false` for everything, and this is the one that says the DEFAULT
    // — a player who typed no query string at all — is the locked camera.
    expect(parseScrollUnlocked(null)).toBe(false)
    expect(parseScrollUnlocked('1')).toBe(true)
  })
})
