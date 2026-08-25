import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { tileToWorld } from '../../view/projection'

/**
 * Ticket 008a — what a session contains the moment it is built.
 *
 * `World.spawnFromLevel()` already existed and already gets the order right;
 * what did not exist was anything that CALLED it. That is the shape of this
 * whole ticket — nine merged tickets' worth of tested machinery, none of it
 * reachable from the running game — so the first thing to assert is simply that
 * the men are there.
 */

describe('createSession — spawning', () => {
  it('spawns one entity per avatar and per enemy', () => {
    const level = makeLevel({
      avatars: [
        { x: 2, y: 7 },
        { x: 3, y: 7 },
        { x: 4, y: 7 },
      ],
      enemies: [
        { x: 16, y: 7 },
        { x: 17, y: 7 },
      ],
    })
    const s = createSession(level)
    expect(s.world.entityCount).toBe(5)
  })

  it('puts avatars on the player team and enemies on the enemy team', () => {
    const s = createSession(makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [{ x: 16, y: 7 }] }))
    const teams = s.world.entities.map((e) => e.team)
    expect(teams).toEqual(['player', 'enemy'])
  })

  it('places each unit at its spawn tile in world coordinates', () => {
    const level = makeLevel({ avatars: [{ x: 5, y: 9 }], enemies: [] })
    const s = createSession(level)
    const expected = tileToWorld(5, 9, level.size)
    const [unit] = s.world.entities
    expect({ x: unit!.x, z: unit!.z }).toEqual({ x: expected.x, z: expected.z })
  })

  it('spawns nothing for props — a tree is not a combatant', () => {
    const s = createSession(
      makeLevel({
        avatars: [{ x: 2, y: 7 }],
        enemies: [],
        props: [
          { x: 9, y: 9, type: 'tree' },
          { x: 4, y: 4, type: 'shrub' },
        ],
      }),
    )
    expect(s.world.entityCount).toBe(1)
  })

  it('copes with a level that has no enemies', () => {
    const s = createSession(makeLevel({ enemies: [] }))
    expect(s.world.entities.every((e) => e.team === 'player')).toBe(true)
  })

  it('copes with a level that has no spawns at all', () => {
    const s = createSession(makeLevel({ avatars: [], enemies: [] }))
    expect(s.world.entityCount).toBe(0)
    expect(() => {
      s.advance(1 / 60)
    }).not.toThrow()
  })

  it('assigns the same ids to the same units on every build', () => {
    const level = makeLevel()
    const a = createSession(level).world.entities.map((e) => e.id)
    const b = createSession(level).world.entities.map((e) => e.id)
    expect(a).toEqual(b)
  })
})

describe('createSession — the selection handed to the pointer', () => {
  it('is every living player unit', () => {
    const level = makeLevel({
      avatars: [
        { x: 2, y: 7 },
        { x: 3, y: 7 },
      ],
      enemies: [{ x: 16, y: 7 }],
    })
    const s = createSession(level)
    const players = s.world.entities.filter((e) => e.team === 'player').map((e) => e.id)
    expect([...s.selection()]).toEqual(players)
  })

  it('never includes an enemy', () => {
    // Ordering the enemy squad around would be a memorable bug.
    const s = createSession(makeLevel())
    const enemies = new Set(
      s.world.entities.filter((e) => e.team === 'enemy').map((e) => e.id),
    )
    for (const id of s.selection()) expect(enemies.has(id)).toBe(false)
  })

  it('drops the dead', () => {
    const s = createSession(makeLevel())
    const first = s.selection()[0]!
    s.world.despawn(first)
    expect([...s.selection()]).not.toContain(first)
  })

  it('is empty rather than throwing when the whole squad is gone', () => {
    const s = createSession(makeLevel())
    for (const id of [...s.selection()]) s.world.despawn(id)
    expect([...s.selection()]).toEqual([])
  })
})
