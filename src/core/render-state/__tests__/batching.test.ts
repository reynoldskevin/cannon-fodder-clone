import { describe, it, expect } from 'vitest'
import { batchKey, groupIntoBatches } from '../batching'
import type { DrawItem } from '../batching'

/**
 * Ticket 010 — instanced batching.
 *
 * ARCHITECTURE.md requires a full squad plus dozens of enemies in a handful of
 * draw calls, not one per entity. Everything sharing a (unit, animation,
 * direction, frame) shares an atlas rect, so it can be one instanced draw.
 */

const item = (over: Partial<DrawItem> = {}): DrawItem => ({
  id: 1, unit: 'soldier', animation: 'walk', direction: 'N', frame: 0,
  x: 0, z: 0, ...over,
})

describe('batchKey', () => {
  it('is equal for entities sharing unit, animation, direction and frame', () => {
    expect(batchKey(item({ id: 1, x: 5 }))).toBe(batchKey(item({ id: 2, x: 9 })))
  })

  it('differs on a different frame', () => {
    expect(batchKey(item({ frame: 0 }))).not.toBe(batchKey(item({ frame: 1 })))
  })

  it('differs on a different direction', () => {
    expect(batchKey(item({ direction: 'N' }))).not.toBe(batchKey(item({ direction: 'S' })))
  })

  it('differs on a different animation', () => {
    expect(batchKey(item({ animation: 'walk' }))).not.toBe(batchKey(item({ animation: 'die' })))
  })

  it('differs on a different unit type', () => {
    expect(batchKey(item({ unit: 'soldier' }))).not.toBe(batchKey(item({ unit: 'tree1' })))
  })

  it('does not depend on position or id', () => {
    expect(batchKey(item({ id: 7, x: -3, z: 88 }))).toBe(batchKey(item({ id: 8, x: 100, z: -2 })))
  })
})

describe('groupIntoBatches', () => {
  it('puts identical items in one batch', () => {
    const batches = groupIntoBatches([item({ id: 1 }), item({ id: 2 }), item({ id: 3 })])
    expect(batches).toHaveLength(1)
    expect(batches[0]!.items).toHaveLength(3)
  })

  it('separates items that differ', () => {
    const batches = groupIntoBatches([item({ id: 1 }), item({ id: 2, frame: 2 })])
    expect(batches).toHaveLength(2)
  })

  it('keeps a realistic squad-plus-enemies mix in a handful of draws', () => {
    // 4 squad walking N, 30 enemies spread over 8 directions and 4 frames.
    const items: DrawItem[] = []
    for (let i = 0; i < 4; i++) items.push(item({ id: i, direction: 'N', frame: i % 4 }))
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
    for (let i = 0; i < 30; i++) {
      items.push(item({ id: 100 + i, direction: dirs[i % 8]!, frame: i % 4 }))
    }
    const batches = groupIntoBatches(items)
    // Worst case is 8 directions x 4 frames = 32 distinct rects; the point is
    // that it is bounded by the atlas, not by the 34 entities.
    expect(batches.length).toBeLessThanOrEqual(32)
    expect(batches.reduce((n, b) => n + b.items.length, 0)).toBe(34)
  })

  it('collapses a synchronised squad into a single draw', () => {
    const items = Array.from({ length: 20 }, (_, i) => item({ id: i }))
    expect(groupIntoBatches(items)).toHaveLength(1)
  })

  it('returns no batches for no items', () => {
    expect(groupIntoBatches([])).toEqual([])
  })

  it('releases slots when entities vanish — batches reflect only what is passed', () => {
    const before = groupIntoBatches([item({ id: 1 }), item({ id: 2, frame: 1 })])
    expect(before.reduce((n, b) => n + b.items.length, 0)).toBe(2)
    const after = groupIntoBatches([item({ id: 1 })])
    expect(after.reduce((n, b) => n + b.items.length, 0)).toBe(1)
    expect(after).toHaveLength(1)
  })

  it('orders batches deterministically regardless of input order', () => {
    const items = [item({ id: 1, frame: 2 }), item({ id: 2, frame: 0 }), item({ id: 3, frame: 1 })]
    const a = groupIntoBatches(items).map((b) => b.key)
    const b = groupIntoBatches([...items].reverse()).map((k) => k.key)
    expect(b).toEqual(a)
  })

  it('preserves every item exactly once', () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ id: i, frame: i % 4, direction: i % 2 ? 'N' : 'S' }))
    const seen = groupIntoBatches(items).flatMap((b) => b.items.map((i) => i.id))
    expect(seen.sort((x, y) => x - y)).toEqual(items.map((i) => i.id).sort((x, y) => x - y))
  })
})
