import { describe, it, expect } from 'vitest'
import { rig, endings } from './rig'

/**
 * Ticket 013 — the two events that end a mission, and the latch behind them.
 *
 * `evaluation.test.ts` decides WHETHER an objective is satisfied. This file is
 * about what happens at the moment one is, and it is a separate file because
 * every bug here is a duplicate or a contradiction rather than a wrong answer:
 * a `MissionComplete` emitted on every tick after the win, a mission that
 * reports both outcomes, a squad wiped out on the winning tick and awarded the
 * victory anyway.
 *
 * ALL OF THESE ARE ONE-FRAME BUGS IN PRACTICE. The app shows a screen on the
 * first `MissionComplete` it sees, so a second one changes nothing visible and a
 * hundred more change nothing visible, right up until a later ticket counts them
 * for a campaign score. That is exactly the kind of thing that is cheap to pin
 * now and expensive to find later.
 */

describe('winning', () => {
  const winnable = () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    r.spawn(3, 3, 'player', 1000)
    const enemy = r.spawn(10, 3, 'enemy')
    return { r, enemy }
  }

  it('emits MissionComplete when the last objective is satisfied', () => {
    const { r, enemy } = winnable()
    expect(endings(r.run(10))).toHaveLength(0) // nothing yet
    r.kill(enemy.id)
    const events = r.run(2)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(1)
  })

  it('emits it exactly once, however long the mission runs on', () => {
    const { r, enemy } = winnable()
    r.kill(enemy.id)
    const events = r.run(600)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(1)
  })

  it('names the objective that finished it', () => {
    const { r, enemy } = winnable()
    r.kill(enemy.id)
    const done = r.run(2).find((e) => e.type === 'MissionComplete')
    expect(done).toMatchObject({ objective: 'kill_all' })
  })

  it('reports the outcome for anything that asks later', () => {
    // The event is a one-shot and the HUD is not guaranteed to be listening on
    // the tick it fires — a frame that ran eight steps drains them all at once.
    // `outcome()` is the state the screen can be rebuilt from.
    const { r, enemy } = winnable()
    expect(r.objectives.outcome()).toBe('playing')
    r.kill(enemy.id)
    r.run(2)
    expect(r.objectives.outcome()).toBe('complete')
  })
})

describe('losing', () => {
  const losable = () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    const a = r.spawn(3, 3, 'player')
    const b = r.spawn(4, 3, 'player')
    r.spawn(10, 3, 'enemy')
    return { r, a, b }
  }

  it('does not fail while one man is left', () => {
    const { r, a } = losable()
    r.kill(a.id)
    expect(endings(r.run(60))).toHaveLength(0)
  })

  it('emits MissionFailed when the last man falls', () => {
    const { r, a, b } = losable()
    r.kill(a.id)
    r.kill(b.id)
    const events = r.run(2)
    expect(events.filter((e) => e.type === 'MissionFailed')).toHaveLength(1)
    expect(r.objectives.outcome()).toBe('failed')
  })

  it('emits it exactly once', () => {
    const { r, a, b } = losable()
    r.kill(a.id)
    r.kill(b.id)
    expect(r.run(600).filter((e) => e.type === 'MissionFailed')).toHaveLength(1)
  })

  it('gives a reason', () => {
    const { r, a, b } = losable()
    r.kill(a.id)
    r.kill(b.id)
    const failed = r.run(2).find((e) => e.type === 'MissionFailed')
    expect(failed).toMatchObject({ reason: expect.any(String) })
    expect((failed as { reason: string }).reason.length).toBeGreaterThan(0)
  })

  it('does not fail a mission that has not started', () => {
    // An empty world is a session between `createSession` and `spawnFromLevel`,
    // and a wipe check that counts zero living players would declare it lost
    // before the first man is placed.
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    expect(endings(r.run(10))).toHaveLength(0)
    expect(r.objectives.outcome()).toBe('playing')
  })
})

describe('the tie', () => {
  /**
   * THE DECISION, AND IT IS `MissionFailed`.
   *
   * At `INFANTRY_HEALTH = 1` mutual simultaneous kills are ordinary rather than
   * exotic — `CombatSystem` decides a whole volley against one snapshot of the
   * world precisely so that two men who see each other both die — so this tie
   * WILL happen in real play. A player whose last man dies as the last enemy
   * falls did not win the mission, and a game that awards it to a dead squad
   * reads as a bug even to the player it flatters.
   */
  const simultaneous = () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    const player = r.spawn(3, 3, 'player')
    const enemy = r.spawn(10, 3, 'enemy')
    // Both killed before a single tick is run, so the system sees one world in
    // which every objective is complete AND every player unit is dead.
    r.kill(player.id)
    r.kill(enemy.id)
    return r
  }

  it('resolves to failure, not victory', () => {
    const events = simultaneous().run(2)
    expect(events.filter((e) => e.type === 'MissionFailed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(0)
  })

  it('and reports failure afterwards', () => {
    const r = simultaneous()
    r.run(2)
    expect(r.objectives.outcome()).toBe('failed')
  })

  it('emits exactly one ending in total', () => {
    // The tie is the one case where "exactly once" and "never both" can fail
    // together, so the total is asserted rather than each type separately.
    expect(endings(simultaneous().run(600))).toHaveLength(1)
  })
})

describe('the latch', () => {
  it('a mission already won cannot then be lost', () => {
    // The squad walking into an ambush during the victory animation must not
    // turn the win into a loss. Once resolved, the mission is resolved.
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    const player = r.spawn(3, 3, 'player')
    const enemy = r.spawn(10, 3, 'enemy')
    r.kill(enemy.id)
    expect(r.run(2).filter((e) => e.type === 'MissionComplete')).toHaveLength(1)

    r.kill(player.id)
    const after = r.run(60)
    expect(endings(after)).toHaveLength(0)
    expect(r.objectives.outcome()).toBe('complete')
  })

  it('a mission already lost cannot then be won', () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    const player = r.spawn(3, 3, 'player')
    const enemy = r.spawn(10, 3, 'enemy')
    r.kill(player.id)
    expect(r.run(2).filter((e) => e.type === 'MissionFailed')).toHaveLength(1)

    r.kill(enemy.id)
    const after = r.run(60)
    expect(endings(after)).toHaveLength(0)
    expect(r.objectives.outcome()).toBe('failed')
  })

  it('stops evaluating rather than merely stopping emitting', () => {
    // A system that kept scoring and only suppressed the event would report
    // progress that contradicts the screen the player is looking at.
    const r = rig({ objectives: [{ type: 'kill_count', count: 1 }] })
    r.spawn(3, 3, 'player', 1000)
    const a = r.spawn(10, 3, 'enemy')
    const b = r.spawn(11, 3, 'enemy')
    r.kill(a.id)
    r.run(2)
    const atEnd = r.objectives.progress()
    r.kill(b.id)
    r.run(60)
    expect(r.objectives.progress()).toEqual(atEnd)
  })
})

describe('the mission timer', () => {
  it('counts the ticks the simulation ran, not a wall clock', () => {
    // Derived from the tick count so it is exact, identical across replays, and
    // still correct when a frame stalls. `src/core` may not read a clock at all,
    // which is the rule making this the only available answer.
    const r = rig()
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.run(90)
    expect(r.objectives.elapsedTicks).toBe(90)
  })

  it('stops when the mission does', () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    r.spawn(3, 3, 'player', 1000)
    const enemy = r.spawn(10, 3, 'enemy')
    r.run(30)
    r.kill(enemy.id)
    r.run(2)
    const atEnd = r.objectives.elapsedTicks
    r.run(120)
    expect(r.objectives.elapsedTicks).toBe(atEnd)
  })
})
