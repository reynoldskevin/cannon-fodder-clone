import { describe, it, expect } from 'vitest'
import { scene, offMapOrBlocked } from './fixture'
import { INFANTRY } from '../../pathing/navgrid'

/**
 * Ticket 007 — the squad and the terrain.
 *
 * THE ASSERTION THAT MATTERS IS PER-TICK, NOT PER-RUN. A unit that clips through
 * a wall corner for four ticks and comes out the far side ends the run in a
 * perfectly legal place; only a check on every intermediate tick sees it. That is
 * also the honest model of the bug — the illegal state is transient, and it is
 * transient states that make a game look broken while every end-state test
 * passes.
 *
 * Separation is what makes this hard rather than trivial. A unit steering purely
 * along the flow field never leaves the walkable set, because the field is only
 * defined on it. Separation pushes SIDEWAYS, off the field's guidance, and that
 * push is what shoves the man on the outside of a corridor into the wall.
 */

const OPTS = { speedTilesPerSecond: 3, separationRadius: 0.6 } as const

/** A long corridor with a single-tile-wide waist the squad must file through. */
const CORRIDOR = `
  ##################
  ##################
  ..................
  ..................
  ..................
  ##################
  ##################
`

const PINCH = `
  ##################
  .........##.......
  ..................
  .........##.......
  ##################
`

const DOGLEG = `
  ############
  ....#.......
  ....#.......
  ....#.......
  ........####
  ####........
  ####........
  ############
`

describe('units stay on walkable ground', () => {
  it('holds through a wide corridor traversal', () => {
    const s = scene(CORRIDOR, OPTS)
    const ids = [
      s.spawn(1, 3),
      s.spawn(1, 2),
      s.spawn(1, 4),
      s.spawn(2, 3),
      s.spawn(2, 2),
      s.spawn(2, 4),
    ].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 3 })
    for (let t = 0; t < 500; t++) {
      s.run(1)
      const offender = offMapOrBlocked(s, ids, INFANTRY)
      expect({ tick: t, offender }).toEqual({ tick: t, offender: null })
    }
    // Non-vacuous: they actually made the trip rather than never moving.
    expect(s.tileOf(ids[0]!).x).toBeGreaterThan(14)
  })

  it('holds while squeezing through a one-tile pinch', () => {
    // Six men and a gap one tile wide: separation is fighting the flow field the
    // whole way through, which is precisely where a unit gets squeezed out.
    const s = scene(PINCH, OPTS)
    const ids = [
      s.spawn(1, 2),
      s.spawn(2, 2),
      s.spawn(3, 2),
      s.spawn(1, 1),
      s.spawn(2, 1),
      s.spawn(1, 3),
    ].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 2 })
    for (let t = 0; t < 700; t++) {
      s.run(1)
      const offender = offMapOrBlocked(s, ids, INFANTRY)
      expect({ tick: t, offender }).toEqual({ tick: t, offender: null })
    }
    expect(s.tileOf(ids[0]!).x).toBeGreaterThan(12)
  })

  it('holds around a dogleg, where the flow field turns hard', () => {
    const s = scene(DOGLEG, OPTS)
    const ids = [s.spawn(1, 1), s.spawn(2, 1), s.spawn(1, 2), s.spawn(2, 2)].map((e) => e.id)
    s.squad.order(ids, { x: 10, y: 6 })
    for (let t = 0; t < 700; t++) {
      s.run(1)
      const offender = offMapOrBlocked(s, ids, INFANTRY)
      expect({ tick: t, offender }).toEqual({ tick: t, offender: null })
    }
    expect(s.tileOf(ids[0]!).y).toBeGreaterThan(4)
  })

  it('never leaves the map', () => {
    // Ordered hard into a corner, with separation pushing outward. The clamp
    // must be the grid's, not a coincidence of the level being large.
    const s = scene(CORRIDOR, OPTS)
    const ids = [s.spawn(1, 2), s.spawn(1, 2), s.spawn(1, 2), s.spawn(1, 2)].map((e) => e.id)
    s.squad.order(ids, { x: 0, y: 2 })
    for (let t = 0; t < 400; t++) {
      s.run(1)
      for (const id of ids) {
        const p = s.tileOf(id)
        expect({ t, id, inX: p.x >= 0 && p.x < 18, inY: p.y >= 0 && p.y < 7 }).toEqual({
          t,
          id,
          inX: true,
          inY: true,
        })
      }
    }
  })
})

describe('walls slide rather than stop', () => {
  it('lets a unit pushed into a wall keep making progress along it', () => {
    // A unit hugging the north wall of the corridor while walking east must keep
    // going east. Cancelling the whole step because its northward component is
    // illegal is the naive fix, and it produces men who stick to walls.
    const s = scene(CORRIDOR, { ...OPTS, separationRadius: 1.2 })
    const ids = [s.spawn(2, 2), s.spawn(2, 2.4), s.spawn(2, 2.8)].map((e) => e.id)
    s.squad.order(ids, { x: 16, y: 2 })
    s.run(400)
    // Every one of them, including whoever got shoved against the wall.
    for (const id of ids) expect(s.tileOf(id).x).toBeGreaterThan(11)
  })
})

describe('unreachable and degenerate orders', () => {
  it('does not throw when the target is inside a wall', () => {
    const s = scene(CORRIDOR, OPTS)
    const a = s.spawn(2, 3)
    expect(() => {
      s.squad.order([a.id], { x: 5, y: 0 })
      s.run(120)
    }).not.toThrow()
    expect(offMapOrBlocked(s, [a.id], INFANTRY)).toBeNull()
  })

  it('does not throw when the target is off the map', () => {
    const s = scene(CORRIDOR, OPTS)
    const a = s.spawn(2, 3)
    expect(() => {
      s.squad.order([a.id], { x: 999, y: -999 })
      s.run(120)
    }).not.toThrow()
    expect(offMapOrBlocked(s, [a.id], INFANTRY)).toBeNull()
  })

  it('does not throw when the target is unreachable behind a wall', () => {
    const SEALED = `
      .....#.....
      .....#.....
      .....#.....
    `
    const s = scene(SEALED, OPTS)
    const a = s.spawn(1, 1)
    expect(() => {
      s.squad.order([a.id], { x: 9, y: 1 })
      s.run(300)
    }).not.toThrow()
    // It may shuffle, but it must not tunnel through the wall to get there.
    expect(s.tileOf(a.id).x).toBeLessThan(5)
    expect(offMapOrBlocked(s, [a.id], INFANTRY)).toBeNull()
  })
})

describe('catching up', () => {
  it('sends a straggler to the leader rather than to a slot behind a wall', () => {
    // The follower starts on the far side of the dogleg from where its slot will
    // be. Holding the slot means walking into the wall between them; the ticket
    // says a follower that far out paths to the leader instead. The observable
    // is simply that it arrives.
    const s = scene(DOGLEG, { ...OPTS, catchUpDistance: 2 })
    const lead = s.spawn(1, 1)
    const stray = s.spawn(10, 6)
    s.squad.order([lead.id, stray.id], { x: 2, y: 1 })
    s.run(900)
    expect(s.gap(lead.id, stray.id)).toBeLessThan(4)
    expect(offMapOrBlocked(s, [lead.id, stray.id], INFANTRY)).toBeNull()
  })
})
