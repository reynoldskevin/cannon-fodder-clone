import { describe, it, expect } from 'vitest'
import { firingCue, cueFor, AUDIO_REACH_TILES, type FiringSource } from '../index'

/** The bus stamps every event; `cueFor` ignores it but the type requires it. */
const stamp = { tick: 0, seq: 0 }

/**
 * Ticket 044 — gunfire is a sustained sound, not a one-shot per round.
 *
 * MEASURED BEFORE ANY CODE. `gunfire.wav`'s RMS envelope, read out of the file
 * at 25 ms resolution, is a shot roughly every 0.1 s held flat across the whole
 * 1.492 s at full amplitude to 1.45 s with NO decay. It is a continuous
 * automatic burst — a LOOP — and it was being fired as a one-shot per round.
 *
 * So one round bought 1.5 s of automatic fire; the 32-tick (0.53 s) rifle
 * cooldown overlapped a single man ~3 deep and a squad ~12; and releasing the
 * trigger did nothing at all, because the voice ran to the end of its buffer.
 *
 * This file pins the pure half: which unit the one sustained voice follows, and
 * that `ShotFired` no longer asks for a cue of its own.
 */

const LISTENER = { x: 0, z: 0, halfWidth: 20 }

const at = (id: number, x: number, z = 0): FiringSource => ({ id, x, z })

describe('firingCue — who the one voice follows', () => {
  it('is silent when nobody is firing', () => {
    expect(firingCue([], LISTENER)).toBeNull()
  })

  it('asks for the rifle when somebody is', () => {
    const request = firingCue([at(1, 2)], LISTENER)
    expect(request?.cue).toBe('rifle')
  })

  it('places the voice at the man who is firing', () => {
    const request = firingCue([at(1, 5, -3)], LISTENER)
    expect({ x: request?.x, z: request?.z }).toEqual({ x: 5, z: -3 })
  })

  it('follows the NEAREST man when several are firing', () => {
    /**
     * With one mono sample, the loudest source is the only one a single voice
     * can honestly represent. Fifteen enemies firing is not fifteen voices.
     */
    const request = firingCue([at(1, 20), at(2, 3), at(3, 11)], LISTENER)
    expect(request?.x).toBe(3)
  })

  it('is not fooled by the order they arrive in', () => {
    // The same three, nearest first rather than last: a function that simply
    // took the head or the tail of the list passes one of these two and not both.
    const request = firingCue([at(2, 3), at(1, 20), at(3, 11)], LISTENER)
    expect(request?.x).toBe(3)
  })

  it('breaks an exact tie on the lower id', () => {
    // Every ordering decision in this codebase breaks this way, so a replay
    // cannot diverge on which of two equidistant men the voice chose.
    const request = firingCue([at(7, 4), at(3, -4)], LISTENER)
    expect(request?.x).toBe(-4)
  })

  it('is silent when every firing man is out of earshot', () => {
    /**
     * NOT MERELY QUIET. A voice claimed for a sound at zero gain is a voice, and
     * a firefight the player cannot hear must not hold the one sustained slot
     * while a man beside him shoots — the per-cue cap's own argument, one level
     * up.
     */
    const far = AUDIO_REACH_TILES + 1
    expect(firingCue([at(1, far), at(2, -far)], LISTENER)).toBeNull()
  })

  it('still hears a man just inside the reach', () => {
    // The control for the case above: a fixture where nobody could be heard for
    // an unrelated reason satisfies it perfectly.
    expect(firingCue([at(1, AUDIO_REACH_TILES - 1)], LISTENER)).not.toBeNull()
  })

  it('ignores a man at a position that is not a number', () => {
    /**
     * `StereoPanner.pan` and `AudioParam.value` both THROW on NaN, and this
     * request is handed straight to them. A non-finite position is a caller bug
     * and must not become an exception inside the render loop's event drain.
     */
    const request = firingCue([at(1, Number.NaN), at(2, Number.POSITIVE_INFINITY), at(3, 6)], LISTENER)
    expect(request?.x).toBe(6)
  })

  it('is silent when every firing man has a broken position', () => {
    expect(firingCue([at(1, Number.NaN)], LISTENER)).toBeNull()
  })
})

describe('a round no longer asks for a cue of its own', () => {
  it('ShotFired is silent, because the sustained voice already covers it', () => {
    /**
     * IT MUST BE, OR THE TWO PATHS DOUBLE UP. This is the line that made one
     * trigger pull play a 1.5-second burst; leaving it in alongside the
     * sustained voice would play every round twice.
     */
    expect(
      cueFor({
        ...stamp,
        type: 'ShotFired',
        shooterId: 1,
        targetId: 2,
        weapon: 'rifle',
        hit: true,
        originX: 0,
        originZ: 0,
        targetX: 1,
        targetZ: 1,
      }),
    ).toBeNull()
  })

  it('and so is an enemy round, which is the same weapon table', () => {
    expect(
      cueFor({
        ...stamp,
        type: 'ShotFired',
        shooterId: 1,
        targetId: 2,
        weapon: 'enemy-rifle',
        hit: false,
        originX: 0,
        originZ: 0,
        targetX: 1,
        targetZ: 1,
      }),
    ).toBeNull()
  })

  it('but an explosion still sounds, so this did not silence the game', () => {
    // The control. A `cueFor` that returned null for everything passes both
    // cases above.
    expect(
      cueFor({ ...stamp, type: 'Explosion', x: 1, y: 0, z: 1, radiusTiles: 3, ordnance: 'grenade', sourceId: 1 }),
    ).not.toBeNull()
  })
})
