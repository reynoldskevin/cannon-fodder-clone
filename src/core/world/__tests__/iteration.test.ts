import { describe, it, expect } from 'vitest'
import { World } from '../world'
import { makeLevel } from './fixture'

/**
 * Ticket 005 — `forEachEntity`, the removal-safe walk.
 *
 * This exists because `world.entities` is the LIVE array and `despawn` compacts
 * it in place, so the obvious system body
 *
 *     for (const e of world.entities) { ...; world.despawn(e.id) }
 *
 * skips every entity after a removal — silently, deterministically, and without
 * throwing. It survives every determinism test in this ticket and surfaces much
 * later as "sometimes an enemy just doesn't shoot". Tickets 011 and 012 are
 * exactly the code that would write that loop, so the safe walk needs to be
 * pinned rather than merely documented.
 *
 * The implementation's correctness argument is that `liveEntities` is always
 * ascending by id, so "not yet visited" is exactly "id greater than the last
 * visited id". These tests attack that claim from the directions where the
 * cheap fixes fail: multiple removals per visit, removals of already-visited
 * entities, and removal of the entity currently being held.
 */

function seed(world: World, n: number): number[] {
  return Array.from(
    { length: n },
    (_, i) => world.spawn({ kind: 'rifleman', team: 'player', x: i, z: 0 }).id,
  )
}

describe('forEachEntity', () => {
  it('visits nothing in an empty world', () => {
    const w = new World(makeLevel(), { seed: 1 })
    const seen: number[] = []
    w.forEachEntity((e) => seen.push(e.id))
    expect(seen).toEqual([])
  })

  it('visits every entity exactly once in spawn order', () => {
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 6)
    const seen: number[] = []
    w.forEachEntity((e) => seen.push(e.id))
    expect(seen).toEqual(ids)
  })

  it('visits everyone even when each visit removes the entity it is holding', () => {
    // The case the naive for...of gets wrong: it visits 1, 3, 5 of six.
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 6)
    const seen: number[] = []
    w.forEachEntity((e) => {
      seen.push(e.id)
      w.despawn(e.id)
    })
    expect(seen).toEqual(ids)
    expect(w.entityCount).toBe(0)
  })

  it('visits everyone when every other entity removes itself', () => {
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 8)
    const seen: number[] = []
    w.forEachEntity((e) => {
      seen.push(e.id)
      if (seen.length % 2 === 1) w.despawn(e.id)
    })
    expect(seen).toEqual(ids)
    expect(w.entityCount).toBe(4)
  })

  it('does not skip when a visit removes several ALREADY VISITED entities at once', () => {
    // This is what kills the common `if (list[i] !== e) i--` fix, which only
    // compensates for a single removal per visit. A grenade killing three
    // soldiers behind the current one is exactly this shape.
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 10)
    const seen: number[] = []
    let detonated = false
    w.forEachEntity((e) => {
      seen.push(e.id)
      if (!detonated && seen.length === 5) {
        detonated = true
        w.despawn(ids[0]!)
        w.despawn(ids[1]!)
        w.despawn(ids[2]!)
      }
    })
    expect(seen).toEqual(ids)
  })

  it('does not visit an entity removed before its turn came', () => {
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 6)
    const seen: number[] = []
    w.forEachEntity((e) => {
      seen.push(e.id)
      if (e.id === ids[0]) {
        w.despawn(ids[3]!)
        w.despawn(ids[4]!)
      }
    })
    expect(seen).toEqual(ids.filter((id) => id !== ids[3] && id !== ids[4]))
  })

  it('terminates when a visit clears the entire world', () => {
    const w = new World(makeLevel(), { seed: 1 })
    seed(w, 12)
    const seen: number[] = []
    w.forEachEntity((e) => {
      seen.push(e.id)
      for (const other of [...w.entities]) w.despawn(other.id)
    })
    expect(seen).toHaveLength(1)
    expect(w.entityCount).toBe(0)
  })

  it('visits entities spawned during the walk, and still terminates', () => {
    // Pinning the behaviour rather than asserting it is desirable: reinforcements
    // land at the end of the ascending-id array, so they are ahead of the cursor
    // and do get visited this tick. A system that spawns unconditionally from
    // inside the walk would therefore never finish — which is worth knowing
    // before ticket 012 writes one.
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 3)
    const seen: number[] = []
    let reinforcements = 0
    w.forEachEntity((e) => {
      seen.push(e.id)
      if (reinforcements < 2) {
        reinforcements += 1
        w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      }
    })
    expect(seen).toHaveLength(5)
    expect(seen.slice(0, 3)).toEqual(ids)
    expect(new Set(seen).size).toBe(5)
  })

  it('never visits the same entity twice under randomised churn', () => {
    // 400 trials of arbitrary spawn/despawn from inside the walk. The three
    // invariants below are the whole contract: no repeats, ascending order, and
    // every entity that survives the walk was seen.
    const rng = new World(makeLevel(), { seed: 4242 }).rng
    for (let trial = 0; trial < 400; trial++) {
      const w = new World(makeLevel(), { seed: trial })
      const initial = seed(w, 1 + rng.int(12))
      const seen: number[] = []
      let spawns = 0
      w.forEachEntity((e) => {
        seen.push(e.id)
        const roll = rng.next()
        if (roll < 0.3) {
          w.despawn(e.id)
        } else if (roll < 0.5) {
          const victim = w.entities[rng.int(w.entities.length)]
          if (victim) w.despawn(victim.id)
        } else if (roll < 0.6 && spawns < 3) {
          spawns += 1
          w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
        }
      })

      expect(new Set(seen).size).toBe(seen.length)
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
      }
      // Everything still alive at the end must have been visited, and every
      // survivor from the initial population certainly must have been.
      for (const e of w.entities) {
        if (initial.includes(e.id)) expect(seen).toContain(e.id)
      }
    }
  })

  it('is unaffected by despawning an id that is not present', () => {
    const w = new World(makeLevel(), { seed: 1 })
    const ids = seed(w, 5)
    const seen: number[] = []
    w.forEachEntity((e) => {
      seen.push(e.id)
      w.despawn(999999)
    })
    expect(seen).toEqual(ids)
  })

  it('hands the visitor the live entity, so mutations stick', () => {
    const w = new World(makeLevel(), { seed: 1 })
    seed(w, 4)
    w.forEachEntity((e) => {
      e.health = 42
    })
    expect(w.entities.map((e) => e.health)).toEqual([42, 42, 42, 42])
  })

  it('produces the same visit order as a plain read-only walk', () => {
    const w = new World(makeLevel(), { seed: 1 })
    seed(w, 20)
    const viaHelper: number[] = []
    w.forEachEntity((e) => viaHelper.push(e.id))
    expect(viaHelper).toEqual(w.entities.map((e) => e.id))
  })
})
