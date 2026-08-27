import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'

/**
 * Ticket 038 — hearing is what turns a man around.
 *
 * The vision cone would be a cruelty on its own: an enemy shot in the back would
 * have no way of ever finding out, so a squad could stand behind a garrison and
 * dismantle it one man at a time with no risk at all. Gunfire is the answer, and
 * it is the half that was ALREADY BUILT — `nearestRumour` has walked an idle man
 * toward a shot inside his alert radius since ticket 012.
 *
 * What this ticket adds is the coupling: the `alert` errand points him at the
 * noise, and a man who faces the noise can then SEE what made it. Those two
 * facts have to meet, or hearing becomes a man walking blindly at a sound.
 *
 * EARS ARE NOT DIRECTIONAL. The cone gates SIGHT and nothing else; a rumour is
 * heard from any direction. An arc on hearing would be a second stealth
 * mechanic nobody asked for, and would make the one above unrecoverable.
 */

describe('a shot from behind', () => {
  it('is heard, even though the shooter cannot be seen', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(10, 6, 'enemy') // facing south by default
    r.spawn(10, 2, 'player', 10_000) // four tiles NORTH: behind him
    r.run(6)
    // The premise: sight alone leaves him idle.
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    r.ai.hear([r.shotAt(10, 2)])
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('turns him toward it', () => {
    // The coupling, stated directly. Without it he investigates a noise while
    // looking the other way, and walks past the man who made it.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 6, 'enemy')
    r.ai.hear([r.shotAt(10, 2)])
    r.run(20)
    const facing = r.ai.facingOf(enemy.id)!
    expect(facing.dz).toBeLessThan(0) // north, toward the shot
  })

  it('and he then acquires the man who fired it', () => {
    /**
     * THE WHOLE POINT, END TO END. Being shot at must be recoverable, or the
     * cone turns every garrison into free kills. He hears, he turns, and on a
     * later tick the shooter is inside the arc and gets noticed.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 8, 'enemy')
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
    const enemy = r.spawn(10, 8, 'enemy')
    r.ai.hear([r.shotAt(10, 1)])
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and hearing is not gated by the arc — that is what makes it hearing', () => {
    /**
     * Asserted as a PAIR, in front and behind at the same distance, because
     * "he heard it" on its own is satisfied by a build in which the rumour scan
     * quietly grew a cone too and the shot happened to be in front.
     */
    const behind = rig(OPEN)
    const a = behind.spawn(10, 6, 'enemy')
    behind.ai.hear([behind.shotAt(10, 2)])
    behind.run(4)

    const ahead = rig(OPEN)
    const b = ahead.spawn(10, 6, 'enemy')
    ahead.ai.hear([ahead.shotAt(10, 10)])
    ahead.run(4)

    expect({
      behind: behind.ai.stateOf(a.id),
      ahead: ahead.ai.stateOf(b.id),
    }).toEqual({ behind: 'alert', ahead: 'alert' })
  })
})
