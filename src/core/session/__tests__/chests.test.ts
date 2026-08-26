import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import type { LevelData, SpawnPoint } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 017 — chests, through a whole session.
 *
 * THE POINT OF DOING IT AT THIS LEVEL is that the two ends of this feature were
 * built three tickets apart and have never met. `ObjectiveSystem.collectChest`
 * has existed since ticket 013 with a docstring admitting nothing calls it;
 * `Armoury.grant` has existed since 016 for exactly this caller. A unit test of
 * the pickup system can satisfy both with spies and still leave a
 * `collect_chests` mission unwinnable in the actual game — which is the state
 * the game has been in since 013 and which nobody would notice, because the
 * mission simply never ends.
 */

/** A level whose squad must walk to the chests. */
function levelWithChests(chests: readonly SpawnPoint[]): LevelData {
  const base = makeLevel({
    avatars: [
      { x: 2, y: 7 },
      { x: 3, y: 7 },
    ],
    enemies: [],
    objectives: [{ type: 'collect_chests' }],
  })
  return { ...base, spawns: { ...base.spawns, chests } }
}

function play(s: ReturnType<typeof createSession>, frames: number): SimEvent[] {
  const seen: SimEvent[] = []
  for (let f = 0; f < frames; f += 1) {
    s.advance(1 / 60)
    seen.push(...s.events())
  }
  return seen
}

describe('a squad marched onto a chest collects it', () => {
  it('the chest is on the map before they set off', () => {
    // Non-vacuity: everything below is satisfied by a level with no chests.
    const s = createSession(levelWithChests([{ x: 12, y: 7, reward: { grenade: 2 } }]))
    expect(s.pickups.remaining()).toHaveLength(1)
  })

  it('marching to it takes it, and the pouch gains the rounds', () => {
    const s = createSession(levelWithChests([{ x: 12, y: 7, reward: { grenade: 2 } }]))
    const before = s.armoury.count('grenade')
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
    const events = play(s, 900)
    expect(events.filter((e) => e.type === 'ChestCollected')).toHaveLength(1)
    expect(s.armoury.count('grenade')).toBe(before + 2)
    expect(s.pickups.remaining()).toHaveLength(0)
  })

  it('standing still never reaches it', () => {
    // The control. Without it, a system that collected every chest on tick 1
    // would pass the case above.
    const s = createSession(levelWithChests([{ x: 12, y: 7, reward: { grenade: 2 } }]))
    const events = play(s, 900)
    expect(events.filter((e) => e.type === 'ChestCollected')).toHaveLength(0)
    expect(s.pickups.remaining()).toHaveLength(1)
  })
})

describe('a collect_chests mission becomes winnable', () => {
  it('is still playing while a chest is out there', () => {
    const s = createSession(levelWithChests([{ x: 12, y: 7 }]))
    play(s, 30)
    expect(s.outcome()).toBe('playing')
  })

  it('is won once the last one is taken', () => {
    /**
     * THE WHOLE POINT OF THE TICKET, and the thing that has been quietly broken
     * since 013: a `collect_chests` level could be authored, would load, would
     * report honest partial progress, and could never be finished — because
     * nothing in the game called `collectChest`. A mission that cannot end is
     * not a hard mission, it is a hung one.
     */
    const s = createSession(levelWithChests([{ x: 12, y: 7 }]))
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
    play(s, 900)
    expect(s.outcome()).toBe('complete')
  })

  it('needs every chest, not just the first', () => {
    const s = createSession(
      levelWithChests([
        { x: 12, y: 7 },
        { x: 12, y: 12 },
      ]),
    )
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
    play(s, 600)
    expect({ after: s.outcome(), left: s.pickups.remaining().length }).toEqual({
      after: 'playing',
      left: 1,
    })
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 12 } })
    play(s, 900)
    expect(s.outcome()).toBe('complete')
  })

  it('reports progress on the way, so the HUD can count them', () => {
    const s = createSession(
      levelWithChests([
        { x: 12, y: 7 },
        { x: 12, y: 12 },
      ]),
    )
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
    play(s, 600)
    const line = s.objectives.progress().find((p) => p.type === 'collect_chests')
    expect(line).toBeDefined()
    expect({ done: line?.done, total: line?.total }).toEqual({ done: 1, total: 2 })
  })
})

describe('the system is wired in like every other one', () => {
  it('appears in the declared system order', () => {
    expect(createSession(levelWithChests([])).systemOrder).toContain('pickups')
  })

  it('a mission with no chests is unaffected', () => {
    // Level 1 is exactly this today: `chests: []` and a `kill_all` objective.
    const s = createSession(makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] }))
    expect(() => play(s, 120)).not.toThrow()
    expect(s.pickups.remaining()).toEqual([])
  })

  it('restarting a mission puts the chests back', () => {
    /**
     * Ticket 013 already shipped one bug through `restart()` — the renderer's
     * clock was not reset, so every death animation after a restart pinned to
     * its final frame. Chests are the same shape of state: collected in run one,
     * they must be on the map again in run two, or a replayed mission is
     * unwinnable.
     */
    const level = levelWithChests([{ x: 12, y: 7 }])
    const first = createSession(level)
    first.queue.push({ type: 'move', unitIds: [...first.selection()], target: { x: 12, y: 7 } })
    play(first, 900)
    expect(first.pickups.remaining()).toHaveLength(0)

    const second = createSession(level)
    expect(second.pickups.remaining()).toHaveLength(1)
  })

  it('does not mutate the level document it was built from', () => {
    // Two sessions from one document is what a restart is. A pickup system that
    // spliced collected chests out of `level.spawns.chests` would make the
    // second run start with a map the first one emptied.
    const level = levelWithChests([{ x: 12, y: 7, reward: { grenade: 1 } }])
    const s = createSession(level)
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
    play(s, 900)
    expect(level.spawns.chests).toHaveLength(1)
  })
})

describe('determinism', () => {
  it('two identical missions collect identically', () => {
    const mission = () => {
      const s = createSession(levelWithChests([{ x: 12, y: 7, reward: { grenade: 2 } }]), {
        seed: 9,
      })
      s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 12, y: 7 } })
      const events = play(s, 900)
      return JSON.stringify({ events, hash: s.world.stateHash() })
    }
    expect(mission()).toBe(mission())
  })
})
