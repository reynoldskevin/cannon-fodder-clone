import { describe, it, expect } from 'vitest'
import { scene } from './fixture'

/**
 * Ticket 007 — who leads, and what happens to the order when they die.
 *
 * The leader is the first LIVING member in roster order. That is a query, not a
 * stored id, and the distinction is the whole point: a stored `leaderId` is a
 * field that can be stale, and the moment it is stale the squad either follows a
 * corpse or scatters. Asking the question again after a death cannot be stale.
 *
 * "Preserving the order" is the part that is easy to get subtly wrong. The
 * obvious implementation drops the detachment when its leader dies and the
 * survivors stop where they stand — which looks, to a player, exactly like the
 * squad panicking, and is the difference between losing a man and losing a
 * mission.
 */

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

const OPTS = { speedTilesPerSecond: 3 } as const

describe('leadership', () => {
  it('makes the first roster member the leader', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    for (const id of ids) expect(s.squad.leaderOf(id)).toBe(ids[0])
  })

  it('promotes the next living member when the leader dies', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    s.run(30)
    s.world.despawn(ids[0]!)
    s.run(1)
    expect(s.squad.leaderOf(ids[1]!)).toBe(ids[1])
    expect(s.squad.leaderOf(ids[2]!)).toBe(ids[1])
  })

  it('keeps the order across the promotion', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3)].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 4 })
    s.run(30)
    s.world.despawn(ids[0]!)
    s.run(500)
    // The survivors finish the march the dead leader was on.
    expect(s.tileOf(ids[1]!).x).toBeGreaterThan(13)
    expect(s.tileOf(ids[2]!).x).toBeGreaterThan(11)
    expect(s.squad.targetOf(ids[1]!)).toEqual({ x: 16, y: 4 })
  })

  it('skips over several dead members at once', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3), s.spawn(3, 6)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    s.world.despawn(ids[0]!)
    s.world.despawn(ids[1]!)
    s.run(1)
    expect(s.squad.leaderOf(ids[2]!)).toBe(ids[2])
  })

  it('handles the last man standing — he leads himself', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    s.world.despawn(ids[0]!)
    s.run(300)
    expect(s.squad.leaderOf(ids[1]!)).toBe(ids[1])
    expect(s.tileOf(ids[1]!).x).toBeGreaterThan(10)
  })

  it('drops a detachment whose members are all dead, without throwing', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    expect(s.squad.detachmentCount).toBe(1)
    for (const id of ids) s.world.despawn(id)
    expect(() => {
      s.run(5)
    }).not.toThrow()
    expect(s.squad.detachmentCount).toBe(0)
    expect(s.squad.leaderOf(ids[0]!)).toBeUndefined()
  })
})

describe('splitting', () => {
  it('moves exactly the named ids into their own detachment', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3), s.spawn(3, 6)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    s.squad.order([ids[2]!, ids[3]!], { x: 3, y: 7 })
    expect(s.squad.detachmentCount).toBe(2)
    expect(s.squad.leaderOf(ids[0]!)).toBe(ids[0])
    expect(s.squad.leaderOf(ids[1]!)).toBe(ids[0])
    expect(s.squad.leaderOf(ids[2]!)).toBe(ids[2])
    expect(s.squad.leaderOf(ids[3]!)).toBe(ids[2])
  })

  it('leaves the remainder on their old target', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3)].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 4 })
    s.squad.order([ids[2]!], { x: 3, y: 7 })
    expect(s.squad.targetOf(ids[0]!)).toEqual({ x: 16, y: 4 })
    expect(s.squad.targetOf(ids[2]!)).toEqual({ x: 3, y: 7 })
  })

  it('actually sends the two halves to different places', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(8, 4), s.spawn(8, 5), s.spawn(8, 3), s.spawn(8, 6)].map((e) => e.id)
    s.squad.order(ids, { x: 17, y: 4 })
    s.squad.order([ids[2]!, ids[3]!], { x: 1, y: 4 })
    s.run(500)
    expect(s.tileOf(ids[0]!).x).toBeGreaterThan(14)
    expect(s.tileOf(ids[2]!).x).toBeLessThan(4)
  })

  it('re-promotes the remainder when the split takes their leader', () => {
    // Splitting off the leader is the interesting case: the rump squad must find
    // a new leader and keep going, exactly as if the leader had died.
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5), s.spawn(3, 3)].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 4 })
    s.squad.order([ids[0]!], { x: 3, y: 7 })
    expect(s.squad.leaderOf(ids[1]!)).toBe(ids[1])
    expect(s.squad.targetOf(ids[1]!)).toEqual({ x: 16, y: 4 })
  })

  it('re-ordering the whole squad does not create a second detachment', () => {
    const s = scene(OPEN, OPTS)
    const ids = [s.spawn(3, 4), s.spawn(3, 5)].map((e) => e.id)
    s.squad.order(ids, { x: 15, y: 4 })
    s.squad.order(ids, { x: 3, y: 6 })
    expect(s.squad.detachmentCount).toBe(1)
  })
})

describe('orders naming units that are not there', () => {
  it('ignores unknown ids without throwing', () => {
    const s = scene(OPEN, OPTS)
    const a = s.spawn(3, 4)
    expect(() => {
      s.squad.order([a.id, 9999], { x: 15, y: 4 })
      s.run(60)
    }).not.toThrow()
    expect(s.squad.leaderOf(a.id)).toBe(a.id)
  })

  it('ignores dead ids without throwing', () => {
    const s = scene(OPEN, OPTS)
    const a = s.spawn(3, 4)
    const b = s.spawn(3, 5)
    s.world.despawn(b.id)
    s.squad.order([b.id, a.id], { x: 15, y: 4 })
    s.run(200)
    // `a` leads because `b` is not living, and the march still happens.
    expect(s.squad.leaderOf(a.id)).toBe(a.id)
    expect(s.tileOf(a.id).x).toBeGreaterThan(8)
  })

  it('creates no detachment for an order with no live ids at all', () => {
    // Asserted AFTER a tick, deliberately. `createSquadSystem(grid, options)`
    // never receives a `World` — a `SimSystem` is handed one per tick and at no
    // other time — so at the moment `order` is called the system cannot know
    // whether 4242 names anybody. Demanding it did would force either a
    // constructor coupled to a world instance (which `createCombatSystem` is
    // not) or a heuristic on the id VALUE, and 4242 is a perfectly ordinary
    // entity id in a long mission. Validation on the tick that follows is the
    // honest seam; what matters is that the empty detachment does not survive.
    const s = scene(OPEN, OPTS)
    s.squad.order([4242], { x: 15, y: 4 })
    s.run(1)
    expect(s.squad.detachmentCount).toBe(0)
  })
})
