import { describe, it, expect } from 'vitest'
import { createCommandQueue } from '../index'
import type { Command } from '../index'

/**
 * Ticket 008 — the queue itself.
 *
 * A BUFFER, AND NOTHING ELSE. The queue validates nothing about the world: it
 * does not know which unit ids are alive, where the level ends, or what a
 * `move` means. That belongs to `applyCommand`, and the split is deliberate —
 * a queue that silently discards on `push` is a queue you cannot debug, because
 * the drop happened at a point no test and no breakpoint was watching. Here,
 * everything you put in comes out.
 *
 * FIFO is the whole contract, and it is load-bearing: two move orders in one
 * frame must resolve in the order the player gave them, or the squad obeys the
 * click the player has already changed their mind about.
 */

const move = (unitIds: readonly number[], x: number, y: number): Command => ({
  type: 'move',
  unitIds,
  target: { x, y },
})

describe('createCommandQueue', () => {
  it('starts empty', () => {
    const q = createCommandQueue()
    expect(q.size).toBe(0)
    expect(q.drain()).toEqual([])
  })

  it('drains what was pushed', () => {
    const q = createCommandQueue()
    const c = move([1], 3, 4)
    q.push(c)
    expect(q.drain()).toEqual([c])
  })

  it('drains in FIFO order', () => {
    const q = createCommandQueue()
    const commands = [move([1], 1, 1), move([2], 2, 2), move([3], 3, 3)]
    for (const c of commands) q.push(c)
    expect(q.drain()).toEqual(commands)
  })

  it('preserves order across many pushes', () => {
    const q = createCommandQueue()
    for (let i = 0; i < 500; i++) q.push(move([i], i, 0))
    const drained = q.drain()
    expect(drained).toHaveLength(500)
    expect(drained.map((c) => (c.type === 'move' ? c.target.x : -1))).toEqual(
      Array.from({ length: 500 }, (_, i) => i),
    )
  })

  it('is empty after a drain', () => {
    const q = createCommandQueue()
    q.push(move([1], 1, 1))
    q.drain()
    expect(q.size).toBe(0)
    expect(q.drain()).toEqual([])
  })

  it('reports its size without draining', () => {
    const q = createCommandQueue()
    q.push(move([1], 1, 1))
    q.push(move([2], 2, 2))
    expect(q.size).toBe(2)
    expect(q.size).toBe(2)
    expect(q.drain()).toHaveLength(2)
  })

  it('accepts pushes again after a drain', () => {
    const q = createCommandQueue()
    q.push(move([1], 1, 1))
    q.drain()
    const second = move([2], 2, 2)
    q.push(second)
    expect(q.drain()).toEqual([second])
  })

  it('does not lose a command pushed while its drain is being consumed', () => {
    // The realistic shape of this: a system iterating the drained batch pushes a
    // follow-up command. If `drain` handed back the live internal array and then
    // cleared it, that push would land in the array being iterated and then be
    // wiped — the command vanishes with no error anywhere.
    const q = createCommandQueue()
    const first = move([1], 1, 1)
    const second = move([2], 2, 2)
    q.push(first)
    const batch = q.drain()
    for (const _ of batch) q.push(second)
    expect(batch).toEqual([first])
    expect(q.drain()).toEqual([second])
  })

  it('hands back a batch that is not the queue`s own storage', () => {
    // Mutating a drained batch must not corrupt the queue.
    const q = createCommandQueue()
    q.push(move([1], 1, 1))
    const batch = q.drain() as Command[]
    batch.length = 0
    q.push(move([2], 2, 2))
    expect(q.drain()).toHaveLength(1)
  })

  it('carries every command variant through unchanged', () => {
    const q = createCommandQueue()
    const all: Command[] = [
      { type: 'move', unitIds: [1, 2], target: { x: 4, y: 5 } },
      { type: 'fire', unitIds: [3], ordnance: 'rifle', target: { x: 6, y: 7 } },
      { type: 'selectOrdnance', ordnance: 'grenade' },
    ]
    for (const c of all) q.push(c)
    expect(q.drain()).toEqual(all)
  })
})
