import { describe, it, expect } from 'vitest'
import { rig } from './rig'
import { OBJECTIVE_TYPES } from '../index'

/**
 * Ticket 013 — what each objective type reads, and when it is satisfied.
 *
 * `mission-end.test.ts` is where the two events and the latch live; this file is
 * only about evaluation, and the split matters because the failures are
 * different. An objective that completes one tick early is a mission the player
 * wins with an enemy still standing; an objective that never completes is a
 * mission that cannot be won at all, and neither is visible from the other file.
 *
 * PARTIAL PROGRESS IS ASSERTED THROUGHOUT, not just the boolean. It is what the
 * HUD draws, so "3 of 5" being wrong is a lie the player reads every frame even
 * on a mission that ends correctly.
 */

describe('the supported types are a closed, enumerable set', () => {
  it('is exactly the four the ticket names', () => {
    expect([...OBJECTIVE_TYPES].sort()).toEqual([
      'collect_chests',
      'kill_all',
      'kill_count',
      'reach_area',
    ])
  })
})

describe('kill_all', () => {
  it('is not complete while an enemy lives', () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    r.spawn(3, 3, 'player', 1000)
    const a = r.spawn(10, 3, 'enemy')
    r.spawn(12, 3, 'enemy')
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 0, total: 2 })
    r.kill(a.id)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 1, total: 2 })
  })

  it('is complete when the last one falls', () => {
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    r.spawn(3, 3, 'player', 1000)
    const a = r.spawn(10, 3, 'enemy')
    const b = r.spawn(12, 3, 'enemy')
    r.kill(a.id)
    r.kill(b.id)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true, done: 2, total: 2 })
  })

  it('counts enemies, not bodies on the field', () => {
    // A player unit dying must not advance an enemy body count, and a level that
    // spawns no enemy at all is a level whose kill_all is already done rather
    // than one that can never be won.
    const r = rig({ objectives: [{ type: 'kill_all' }] })
    const p = r.spawn(3, 3, 'player')
    r.spawn(10, 3, 'enemy')
    r.kill(p.id)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 0, total: 1 })
  })
})

describe('kill_count', () => {
  it('needs its count and no more', () => {
    const r = rig({ objectives: [{ type: 'kill_count', count: 2 }] })
    r.spawn(3, 3, 'player', 1000)
    const ids = [
      r.spawn(10, 3, 'enemy').id,
      r.spawn(11, 3, 'enemy').id,
      r.spawn(12, 3, 'enemy').id,
    ]
    r.kill(ids[0]!)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 1, total: 2 })
    r.kill(ids[1]!)
    r.run(2)
    // Complete with a third enemy still alive — that is the whole difference
    // between this type and `kill_all`, and a system that quietly evaluated
    // both the same way would pass every `kill_all` test in the file.
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true, done: 2, total: 2 })
    expect(r.world.entities.filter((e) => e.team === 'enemy')).toHaveLength(1)
  })

  it('does not count player casualties toward it', () => {
    const r = rig({ objectives: [{ type: 'kill_count', count: 2 }] })
    const a = r.spawn(3, 3, 'player', 1000)
    const b = r.spawn(4, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.kill(a.id)
    r.kill(b.id)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 0 })
  })

  it('does not run backwards when the count is already met', () => {
    const r = rig({ objectives: [{ type: 'kill_count', count: 1 }] })
    r.spawn(3, 3, 'player', 1000)
    const a = r.spawn(10, 3, 'enemy')
    r.kill(a.id)
    r.run(60)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true, done: 1, total: 1 })
  })
})

describe('reach_area', () => {
  const objective = [{ type: 'reach_area', x: 16, y: 8, radius: 2 }]

  it('is not complete while the squad is elsewhere', () => {
    const r = rig({ objectives: objective })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false })
  })

  it('completes when a living player unit stands inside it', () => {
    const r = rig({ objectives: objective })
    const p = r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.place(p.id, 16, 8)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true })
  })

  it('respects the radius rather than the tile', () => {
    // Two tiles, so a man 1.5 tiles away is inside and one 3 tiles away is not.
    // A system that had collapsed the radius to an exact tile match would pass
    // the case above and fail the player who is standing on the objective.
    const near = rig({ objectives: objective })
    const a = near.spawn(3, 3, 'player', 1000)
    near.spawn(10, 3, 'enemy')
    near.place(a.id, 16, 9.5)
    near.run(2)

    const far = rig({ objectives: objective })
    const b = far.spawn(3, 3, 'player', 1000)
    far.spawn(10, 3, 'enemy')
    far.place(b.id, 16, 11)
    far.run(2)

    expect({
      near: near.objectives.progress()[0]?.complete,
      far: far.objectives.progress()[0]?.complete,
    }).toEqual({ near: true, far: false })
  })

  it('does not count an enemy standing there', () => {
    const r = rig({ objectives: objective })
    r.spawn(3, 3, 'player', 1000)
    const e = r.spawn(10, 3, 'enemy')
    r.place(e.id, 16, 8)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false })
  })

  it('does not count a dead man who died there', () => {
    // `reach_area` is "get a man there and keep him there" — the original's
    // objectives are held, not touched once. A corpse on the spot is not a squad
    // that reached it.
    const r = rig({ objectives: objective })
    const p = r.spawn(3, 3, 'player')
    r.spawn(4, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.place(p.id, 16, 8)
    r.kill(p.id)
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false })
  })
})

describe('collect_chests', () => {
  const chests = [
    { x: 5, y: 5, type: 'chest' },
    { x: 6, y: 5, type: 'chest' },
  ]

  it('reports honest partial progress against the chests the level spawns', () => {
    const r = rig({ objectives: [{ type: 'collect_chests' }], chests })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({
      complete: false,
      done: 0,
      total: 2,
      supported: true,
    })
  })

  it('completes when the count is collected', () => {
    const r = rig({ objectives: [{ type: 'collect_chests' }], chests })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.objectives.collectChest()
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, done: 1, total: 2 })
    r.objectives.collectChest()
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true, done: 2, total: 2 })
  })

  it('takes an explicit count over the level`s chest total', () => {
    const r = rig({ objectives: [{ type: 'collect_chests', count: 1 }], chests })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.objectives.collectChest()
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: true, done: 1, total: 1 })
  })

  it('is UNSUPPORTED on a level with no chests, not already done', () => {
    /**
     * THE HONEST ANSWER TO A REAL GAP. Chests are ticket 017; nothing collects
     * one yet. A `collect_chests` objective needing zero of zero would report
     * complete and hand the player a mission won by doing nothing — the single
     * worst way for this to fail, because it looks like success.
     */
    const r = rig({ objectives: [{ type: 'collect_chests' }], chests: [] })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.run(2)
    expect(r.objectives.progress()[0]).toMatchObject({ complete: false, supported: false })
  })
})

describe('an unknown objective type', () => {
  it('reports unsupported rather than throwing', () => {
    // `LevelObjective.type` is an open enum by decision — the buildings
    // extension point needs it — so a type this build does not know is a
    // document from the future, not a corrupt one.
    const r = rig({ objectives: [{ type: 'destroy_the_radio_mast' }] })
    r.spawn(3, 3, 'player', 1000)
    expect(() => r.run(2)).not.toThrow()
    expect(r.objectives.progress()[0]).toMatchObject({
      type: 'destroy_the_radio_mast',
      supported: false,
      complete: false,
    })
  })

  it('and never completes, so it cannot win the mission by accident', () => {
    const r = rig({ objectives: [{ type: 'destroy_the_radio_mast' }] })
    r.spawn(3, 3, 'player', 1000)
    const events = r.run(600)
    expect(events.filter((e) => e.type === 'MissionComplete')).toHaveLength(0)
  })
})

describe('a mission with several objectives', () => {
  it('reports each one separately, in the order the level lists them', () => {
    const r = rig({
      objectives: [
        { type: 'kill_all' },
        { type: 'reach_area', x: 16, y: 8, radius: 2 },
      ],
    })
    r.spawn(3, 3, 'player', 1000)
    r.spawn(10, 3, 'enemy')
    r.run(2)
    expect(r.objectives.progress().map((p) => p.type)).toEqual(['kill_all', 'reach_area'])
  })

  it('needs all of them', () => {
    const r = rig({
      objectives: [
        { type: 'kill_all' },
        { type: 'reach_area', x: 16, y: 8, radius: 2 },
      ],
    })
    const p = r.spawn(3, 3, 'player', 1000)
    const e = r.spawn(10, 3, 'enemy')
    r.kill(e.id)
    const afterFirst = r.run(2)
    expect(r.objectives.progress()[0]?.complete).toBe(true)
    expect(afterFirst.filter((ev) => ev.type === 'MissionComplete')).toHaveLength(0)

    r.place(p.id, 16, 8)
    const afterSecond = r.run(2)
    expect(afterSecond.filter((ev) => ev.type === 'MissionComplete')).toHaveLength(1)
  })
})
