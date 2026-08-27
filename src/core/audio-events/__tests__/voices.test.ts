import { describe, it, expect } from 'vitest'
import { createVoiceLimiter, GLOBAL_VOICE_CAP, PER_CUE_VOICE_CAP } from '../index'

/**
 * Ticket 027 — how many things may be making noise at once.
 *
 * MEASURED, NOT GUESSED. `gunfire.wav` is 1.49 seconds and the rifle's cooldown
 * is 32 ticks — 0.53 s — so ONE soldier firing steadily overlaps himself three
 * deep, and a four-man squad twelve deep before a single enemy joins in. That is
 * why the cap is per-cue and not only global: a global cap alone would let the
 * rifle crowd out every explosion and death in the mission.
 */

describe('the global cap', () => {
  it('bounds how many voices are live at once', () => {
    const limiter = createVoiceLimiter({ globalCap: 4, perCueCap: 4 })
    for (let i = 0; i < 20; i += 1) limiter.start('rifle', 0, 1)
    expect(limiter.liveCount(0)).toBe(4)
  })

  it('and voices free themselves as they finish', () => {
    // The limiter is told a duration and answers about a time, exactly like the
    // FX buffer: it holds no clock of its own, because `core` may not read one.
    const limiter = createVoiceLimiter({ globalCap: 4, perCueCap: 4 })
    limiter.start('rifle', 0, 0.5)
    expect(limiter.liveCount(0.2)).toBe(1)
    expect(limiter.liveCount(0.6)).toBe(0)
  })
})

describe('the per-cue cap', () => {
  it('stops one sound crowding out every other', () => {
    /**
     * THE CASE THE MEASUREMENT ABOVE DESCRIBES. Fifteen overlapping copies of a
     * 1.49-second rifle sample is not a firefight, it is a wall of noise — and
     * under a global cap alone it would also mean the grenade that killed the
     * squad made no sound at all, because the rifles had taken every voice.
     */
    const limiter = createVoiceLimiter({ globalCap: 16, perCueCap: 3 })
    for (let i = 0; i < 20; i += 1) limiter.start('rifle', 0, 1)
    expect(limiter.liveCountFor('rifle', 0)).toBe(3)
    // ...and there is still room for the thing that matters.
    limiter.start('explosion', 0, 1)
    expect(limiter.liveCountFor('explosion', 0)).toBe(1)
  })

  it('counted per cue, not shared', () => {
    const limiter = createVoiceLimiter({ globalCap: 16, perCueCap: 2 })
    limiter.start('rifle', 0, 1)
    limiter.start('rifle', 0, 1)
    limiter.start('death', 0, 1)
    expect(limiter.liveCountFor('rifle', 0)).toBe(2)
    expect(limiter.liveCountFor('death', 0)).toBe(1)
  })
})

describe('past the cap the OLDEST is stolen, not the newest dropped', () => {
  it('so the round that just went off is always the one you hear', () => {
    /**
     * The acceptance criterion, and the same rule the tracer and FX rings use.
     * Dropping the NEW voice means a sustained firefight goes silent after the
     * first few rounds and stays silent — the player fires and hears nothing,
     * which reads as the audio having broken rather than as a limit.
     */
    const limiter = createVoiceLimiter({ globalCap: 2, perCueCap: 2 })
    expect(limiter.start('rifle', 0, 10).stolen).toBe(false)
    expect(limiter.start('rifle', 1, 10).stolen).toBe(false)
    const third = limiter.start('rifle', 2, 10)
    expect(third.stolen).toBe(true)
    expect(limiter.liveCount(2)).toBe(2)
  })

  it('and a new cue can always be heard, however busy the rifle is', () => {
    const limiter = createVoiceLimiter({ globalCap: 2, perCueCap: 2 })
    limiter.start('rifle', 0, 10)
    limiter.start('rifle', 0, 10)
    limiter.start('explosion', 1, 10)
    expect(limiter.liveCountFor('explosion', 1)).toBe(1)
  })
})

describe('which voice is stolen, not merely that one was', () => {
  it('the OLDEST goes, so the round that just went off is the one still playing', () => {
    /**
     * ACCEPTANCE CRITERION 5 NAMES THE OLDEST, and nothing was checking it:
     * inverting the comparison so the NEWEST is stolen left the whole suite
     * green. The existing cases only assert that a steal happened.
     *
     * Told apart by DURATION: the first voice is given a long one and the second
     * a short one, so if the oldest really went, the survivor is still live at a
     * time the first would also have been — and if the newest went, it is not.
     */
    const limiter = createVoiceLimiter({ globalCap: 1, perCueCap: 1 })
    limiter.start('rifle', 0, 100)
    limiter.start('rifle', 1, 2)
    // Only the short second voice should be alive, and it ends at t = 3.
    expect(limiter.liveCount(2.5)).toBe(1)
    expect(limiter.liveCount(3.5)).toBe(0)
  })

  it('and the slot it hands back is the slot it claimed', () => {
    /**
     * `src/audio` stops the node in the returned slot. A limiter that always
     * answered 0 would have it stop the wrong voice — cutting a live explosion
     * short while the rifle it meant to steal played on — and returning a
     * constant survived the suite.
     */
    const limiter = createVoiceLimiter({ globalCap: 3, perCueCap: 3 })
    const slots = [
      limiter.start('rifle', 0, 10).slot,
      limiter.start('rifle', 0, 10).slot,
      limiter.start('rifle', 0, 10).slot,
    ]
    expect(new Set(slots).size).toBe(3)
    for (const slot of slots) {
      expect({ slot, ok: Number.isInteger(slot) && slot >= 0 && slot < 3 }).toEqual({
        slot,
        ok: true,
      })
    }
    // And a steal reuses the slot the oldest was in, rather than inventing one.
    expect(slots).toContain(limiter.start('rifle', 1, 10).slot)
  })
})

describe('the shipped caps are sane', () => {
  it('a per-cue cap below the global one, or it does nothing', () => {
    // A per-cue cap at or above the global cap can never bind, and the whole
    // measurement above would be unaddressed while looking addressed.
    expect(PER_CUE_VOICE_CAP).toBeLessThan(GLOBAL_VOICE_CAP)
    expect(PER_CUE_VOICE_CAP).toBeGreaterThan(0)
  })

  it('and a per-cue cap that can actually BIND, not merely be smaller', () => {
    /**
     * `< GLOBAL_VOICE_CAP` is satisfied by 15 against 16, which is a per-cue cap
     * that never binds on any firefight this game can produce — the measurement
     * at the top of this file would be unaddressed while looking addressed.
     * Setting it to 15 survived the suite.
     *
     * Half the global cap is the loose bound: it has to leave room for several
     * DIFFERENT cues at once, which is the whole reason it exists.
     */
    expect(PER_CUE_VOICE_CAP).toBeLessThanOrEqual(GLOBAL_VOICE_CAP / 2)
  })

  it('and enough headroom for a real firefight', () => {
    // Level 2 fields fifteen enemies. A global cap in single digits would silence
    // most of a mission's worth of sound.
    expect(GLOBAL_VOICE_CAP).toBeGreaterThanOrEqual(12)
  })
})
