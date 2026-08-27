import { describe, it, expect } from 'vitest'
import {
  createMissionEndHold,
  bannerFor,
  MISSION_END_HOLD_SECONDS,
} from '../mission-end'

/**
 * Ticket 058 — a mission ends on a held banner, not on an instant cut.
 *
 * THE CUT WAS THE BUG. `outcome()` is latched, so the frame it stops reading
 * `playing` is the frame `endMission` swaps the screen — and the victory and
 * defeat cues, which `main.ts` deliberately exempts from the `onMission` gate so
 * they survive that swap, therefore play UNDER Boot Hill or under the Briefing.
 * The player hears the result of a field he is no longer looking at.
 *
 * WHY THE LATCH IS IN `core` AND NOT IN THE RENDER LOOP. What is decidable here
 * is entirely a matter of policy — when to start holding, what to say, when the
 * hold is up, and that the transition happens ONCE — and none of it needs a DOM,
 * a canvas or a clock of its own. `main.ts` is the one place in the game Vitest
 * cannot reach, so the rule lives here and `main.ts` is left holding a call.
 *
 * TIME IS A PARAMETER, NOT A READING. Every method that cares about the clock is
 * given `now`; nothing in this module calls `Date.now` or `performance.now`.
 * That is what lets these cases step time by hand, and it is the same reason
 * `main.ts` can drive the hold off the render loop's `elapsed` rather than off a
 * `setTimeout` that would outlive a teardown.
 */

describe('what the banner says', () => {
  it('a completed mission reads MISSION COMPLETE', () => {
    expect(bannerFor('complete')).toBe('MISSION COMPLETE')
  })

  it('a failed one reads MISSION FAILED', () => {
    expect(bannerFor('failed')).toBe('MISSION FAILED')
  })

  it('and the two are not the same string', () => {
    // A `bannerFor` that ignored its argument would satisfy neither case above
    // on its own, but a copy-paste that returned the win text for both would
    // pass one and fail the other silently in a suite that only ran one.
    expect(bannerFor('complete')).not.toBe(bannerFor('failed'))
  })

  it('and both are upper case, as every display-face line in the game is', () => {
    for (const text of [bannerFor('complete'), bannerFor('failed')]) {
      expect(text).toBe(text.toUpperCase())
    }
  })
})

describe('the hold does nothing until a mission is decided', () => {
  it('shows no banner before anything has happened', () => {
    const hold = createMissionEndHold()
    expect(hold.banner()).toBeNull()
  })

  it('and never reports itself elapsed while it has not begun', () => {
    /**
     * THE TRAP, AND IT IS THE ONE THAT WOULD END EVERY MISSION ON FRAME ONE. A
     * hold whose start defaults to 0 and which answers `now - start >= 3` would
     * be "elapsed" from the first frame the clock passed three seconds — which
     * is to say from three seconds into every mission, decided or not.
     */
    const hold = createMissionEndHold()
    for (const now of [0, 1, MISSION_END_HOLD_SECONDS, 1000]) {
      expect(hold.elapsed(now)).toBe(false)
    }
  })
})

describe('once it begins, it holds for three seconds', () => {
  it('puts the banner up on the frame it begins', () => {
    const hold = createMissionEndHold()
    hold.begin('complete', 12)
    expect(hold.banner()).toBe('MISSION COMPLETE')
  })

  it('and is not elapsed on that frame, nor a moment before its time', () => {
    const hold = createMissionEndHold()
    hold.begin('failed', 12)
    expect(hold.elapsed(12)).toBe(false)
    expect(hold.elapsed(12 + MISSION_END_HOLD_SECONDS - 0.001)).toBe(false)
  })

  it('and IS elapsed once the three seconds are up', () => {
    const hold = createMissionEndHold()
    hold.begin('failed', 12)
    expect(hold.elapsed(12 + MISSION_END_HOLD_SECONDS)).toBe(true)
    expect(hold.elapsed(12 + MISSION_END_HOLD_SECONDS + 5)).toBe(true)
  })

  it('measured from when it began, not from zero', () => {
    /**
     * A mission decided at 90 seconds must hold until 93, not be instantly up
     * because the clock already reads more than three. `elapsed` compares
     * against the START, and this is the case that says so — the two above pass
     * for a hold that began at 0 as well.
     */
    const hold = createMissionEndHold()
    hold.begin('complete', 90)
    expect(hold.elapsed(91)).toBe(false)
    expect(hold.elapsed(92.9)).toBe(false)
    expect(hold.elapsed(93)).toBe(true)
  })

  it('and the hold is three seconds, which is the thing the player asked for', () => {
    expect(MISSION_END_HOLD_SECONDS).toBe(3)
  })
})

describe('the first outcome wins', () => {
  it('a second begin does not restart the clock', () => {
    /**
     * `main.ts` CALLS `begin` FROM INSIDE THE RENDER LOOP, on every frame where
     * the outcome is not `playing` and the runner is still on the mission —
     * which is every frame of the hold. A `begin` that reset `startedAt` would
     * push the finish line forward by one frame, every frame, and the mission
     * would never end. This is not a hypothetical guard: it is the shape of the
     * only call site.
     */
    const hold = createMissionEndHold()
    hold.begin('complete', 10)
    for (let f = 1; f <= 200; f += 1) hold.begin('complete', 10 + f / 60)
    expect(hold.elapsed(13)).toBe(true)
  })

  it('and does not change what the banner says', () => {
    // Belt and braces on the same latch, from the other side: the outcome is
    // decided once by `core/objectives` and cannot legitimately change, so a
    // hold that took the LAST word rather than the first would be reading a
    // value that is not supposed to move.
    const hold = createMissionEndHold()
    hold.begin('complete', 10)
    hold.begin('failed', 11)
    expect(hold.banner()).toBe('MISSION COMPLETE')
  })
})

describe('and the transition happens exactly once', () => {
  it('the banner comes down when the caller says it is done', () => {
    const hold = createMissionEndHold()
    hold.begin('complete', 10)
    hold.done()
    expect(hold.banner()).toBeNull()
  })

  it('and a finished hold never asks for a second transition', () => {
    /**
     * THE OTHER HALF OF THE ONLY CALL SITE. `main.ts` reads
     * `if (hold.elapsed(now)) { hold.done(); endMission() }` from a loop that
     * keeps running, so a hold that went on answering `true` after `done` would
     * fire `endMission` again — and `endMission` records the mission against the
     * campaign. Twice would bury the same men twice.
     */
    const hold = createMissionEndHold()
    hold.begin('failed', 10)
    expect(hold.elapsed(13)).toBe(true)
    hold.done()
    for (const now of [13, 14, 100]) expect(hold.elapsed(now)).toBe(false)
  })

  it('and a mission that begins again after done gets a fresh hold', () => {
    /**
     * ONE HOLD PER MISSION, AND A SESSION IS REBUILT PER MISSION — but the hold
     * outliving one would be a corpse of a latch that could never fire again,
     * and the next mission would cut instantly. Cheaper to make `done` a reset
     * than to make the caller remember to build a new one.
     */
    const hold = createMissionEndHold()
    hold.begin('complete', 10)
    hold.done()
    hold.begin('failed', 50)
    expect(hold.banner()).toBe('MISSION FAILED')
    expect(hold.elapsed(52)).toBe(false)
    expect(hold.elapsed(53)).toBe(true)
  })
})

describe('a run of frames, the way the render loop actually calls it', () => {
  it('holds for three seconds of frames and transitions on one of them', () => {
    /**
     * THE WHOLE TICKET IN ONE CASE, driven at 60 Hz the way the loop drives it:
     * the outcome lands, the banner goes up, `begin` is called again on every
     * subsequent frame because the guard in `main.ts` is still true, and exactly
     * ONE frame gets to run the transition.
     */
    const hold = createMissionEndHold()
    let transitions = 0
    let bannerFrames = 0
    let decided = false
    for (let f = 0; f < 600; f += 1) {
      const now = f / 60
      // Frame 60 (one second in) is where the mission is decided.
      if (f >= 60) decided = true
      if (decided) {
        hold.begin('complete', now)
        if (hold.elapsed(now)) {
          hold.done()
          transitions += 1
        }
      }
      if (hold.banner() !== null) bannerFrames += 1
    }
    expect(transitions).toBe(1)
    // Three seconds of frames at 60 Hz, give or take the frame the transition
    // lands on. Asserted as a range rather than a number because the exact
    // count depends on where the hold's end falls between two frames.
    expect(bannerFrames).toBeGreaterThanOrEqual(3 * 60 - 2)
    expect(bannerFrames).toBeLessThanOrEqual(3 * 60 + 2)
  })
})
