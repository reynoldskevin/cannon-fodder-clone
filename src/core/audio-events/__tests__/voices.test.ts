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

describe('the shipped caps are sane', () => {
  it('a per-cue cap below the global one, or it does nothing', () => {
    // A per-cue cap at or above the global cap can never bind, and the whole
    // measurement above would be unaddressed while looking addressed.
    expect(PER_CUE_VOICE_CAP).toBeLessThan(GLOBAL_VOICE_CAP)
    expect(PER_CUE_VOICE_CAP).toBeGreaterThan(0)
  })

  it('and enough headroom for a real firefight', () => {
    // Level 2 fields fifteen enemies. A global cap in single digits would silence
    // most of a mission's worth of sound.
    expect(GLOBAL_VOICE_CAP).toBeGreaterThanOrEqual(12)
  })
})
