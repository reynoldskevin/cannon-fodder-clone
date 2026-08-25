import { describe, it, expect } from 'vitest'
import { createRng } from '../prng'

/**
 * Ticket 005 — the seeded PRNG.
 *
 * `ARCHITECTURE.md` ("Determinism"): no `Math.random()` in `core/`, a seeded
 * generator passed into `World` instead. Everything downstream — combat spread,
 * AI hesitation, ordnance scatter — draws from this, so if it is not exactly
 * reproducible then nothing above it is either, and the determinism guarantee
 * that makes this whole layer testable evaporates.
 *
 * These tests deliberately do NOT pin an algorithm. They pin the properties the
 * simulation depends on: reproducibility, independence, range, and the ability
 * to snapshot and restore a stream.
 */

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(12345)
    const b = createRng(12345)
    const seqA = Array.from({ length: 200 }, () => a.next())
    const seqB = Array.from({ length: 200 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('produces a different sequence for a different seed', () => {
    const x = createRng(1)
    const y = createRng(2)
    const seqX = Array.from({ length: 50 }, () => x.next())
    const seqY = Array.from({ length: 50 }, () => y.next())
    expect(seqX).not.toEqual(seqY)
  })

  it('gives adjacent seeds unrelated streams', () => {
    // A weak generator seeded by a counter can emit near-identical first draws
    // for seeds 1,2,3... Enemy squads seeded by index would then all behave the
    // same way, which reads as a bug in the AI rather than in the RNG.
    const firsts = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => createRng(s).next())
    for (let i = 1; i < firsts.length; i++) {
      expect(Math.abs(firsts[i]! - firsts[i - 1]!)).toBeGreaterThan(0.001)
    }
  })

  it('two instances do not share hidden state', () => {
    const a = createRng(7)
    const b = createRng(7)
    a.next()
    a.next()
    a.next()
    // b must be untouched by a's draws.
    expect(b.next()).toBe(createRng(7).next())
  })

  describe('next', () => {
    it('stays within [0, 1)', () => {
      const r = createRng(99)
      for (let i = 0; i < 10000; i++) {
        const v = r.next()
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    })

    it('is roughly uniform across the unit interval', () => {
      const r = createRng(4242)
      const buckets = new Array<number>(10).fill(0)
      const n = 100000
      for (let i = 0; i < n; i++) buckets[Math.floor(r.next() * 10)]! += 1
      for (const b of buckets) {
        expect(b).toBeGreaterThan(n / 10 - n / 100)
        expect(b).toBeLessThan(n / 10 + n / 100)
      }
    })

    it('does not repeat itself over a mission-length run', () => {
      // 60 Hz x 5 minutes = 18000 ticks, several draws each. A short period
      // would make enemy behaviour visibly cyclic.
      const r = createRng(5)
      const seen = new Set<number>()
      for (let i = 0; i < 50000; i++) seen.add(r.next())
      expect(seen.size).toBeGreaterThan(49000)
    })

    it('always returns a finite number', () => {
      const r = createRng(0)
      for (let i = 0; i < 1000; i++) expect(Number.isFinite(r.next())).toBe(true)
    })
  })

  describe('int', () => {
    it('returns integers in [0, maxExclusive)', () => {
      const r = createRng(3)
      for (let i = 0; i < 5000; i++) {
        const v = r.int(8)
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(8)
      }
    })

    it('covers every value in the range', () => {
      const r = createRng(11)
      const seen = new Set<number>()
      for (let i = 0; i < 2000; i++) seen.add(r.int(6))
      expect(seen.size).toBe(6)
    })

    it('is uniform enough not to bias a dice roll', () => {
      const r = createRng(808)
      const counts = new Array<number>(6).fill(0)
      const n = 60000
      for (let i = 0; i < n; i++) counts[r.int(6)]! += 1
      for (const c of counts) {
        expect(c).toBeGreaterThan(n / 6 - n / 60)
        expect(c).toBeLessThan(n / 6 + n / 60)
      }
    })

    it('returns 0 for a degenerate range rather than NaN', () => {
      const r = createRng(1)
      expect(r.int(1)).toBe(0)
      expect(r.int(0)).toBe(0)
      expect(r.int(-5)).toBe(0)
    })
  })

  describe('range', () => {
    it('stays within [min, max)', () => {
      const r = createRng(66)
      for (let i = 0; i < 5000; i++) {
        const v = r.range(-2.5, 7.5)
        expect(v).toBeGreaterThanOrEqual(-2.5)
        expect(v).toBeLessThan(7.5)
      }
    })

    it('spans most of the interval', () => {
      const r = createRng(67)
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < 5000; i++) {
        const v = r.range(10, 20)
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      expect(lo).toBeLessThan(10.2)
      expect(hi).toBeGreaterThan(19.8)
    })

    it('handles an inverted or empty range without producing NaN', () => {
      const r = createRng(2)
      expect(Number.isFinite(r.range(5, 5))).toBe(true)
      expect(Number.isFinite(r.range(9, 1))).toBe(true)
    })
  })

  describe('pick', () => {
    it('returns an element of the array', () => {
      const r = createRng(21)
      const items = ['a', 'b', 'c', 'd'] as const
      for (let i = 0; i < 500; i++) expect(items).toContain(r.pick(items))
    })

    it('eventually returns every element', () => {
      const r = createRng(22)
      const items = ['a', 'b', 'c', 'd'] as const
      const seen = new Set<string>()
      for (let i = 0; i < 500; i++) seen.add(r.pick(items)!)
      expect(seen.size).toBe(4)
    })

    it('returns undefined for an empty array rather than throwing', () => {
      expect(createRng(1).pick([])).toBeUndefined()
    })
  })

  describe('fork', () => {
    it('produces an independent stream', () => {
      const parent = createRng(500)
      const child = parent.fork()
      const parentSeq = Array.from({ length: 50 }, () => parent.next())
      const childSeq = Array.from({ length: 50 }, () => child.next())
      expect(parentSeq).not.toEqual(childSeq)
    })

    it('is deterministic — the same parent history forks the same child', () => {
      const makeChild = () => {
        const p = createRng(77)
        p.next()
        p.next()
        return p.fork()
      }
      const a = makeChild()
      const b = makeChild()
      expect(Array.from({ length: 30 }, () => a.next())).toEqual(
        Array.from({ length: 30 }, () => b.next()),
      )
    })

    it('does not let the child advance the parent', () => {
      const p = createRng(31)
      const child = p.fork()
      const expected = (() => {
        const q = createRng(31)
        q.fork()
        return Array.from({ length: 20 }, () => q.next())
      })()
      for (let i = 0; i < 100; i++) child.next()
      expect(Array.from({ length: 20 }, () => p.next())).toEqual(expected)
    })
  })

  describe('getState / setState', () => {
    it('restores an exact position in the stream', () => {
      const r = createRng(909)
      for (let i = 0; i < 37; i++) r.next()
      const snapshot = r.getState()
      const after = Array.from({ length: 40 }, () => r.next())
      r.setState(snapshot)
      expect(Array.from({ length: 40 }, () => r.next())).toEqual(after)
    })

    it('transplants a stream position into another instance', () => {
      // A world restored from a snapshot gets a fresh Rng object that must
      // continue the ORIGINAL stream, not its own construction seed.
      const a = createRng(1)
      const b = createRng(2)
      for (let i = 0; i < 10; i++) a.next()
      b.setState(a.getState())
      const fromA = Array.from({ length: 20 }, () => a.next())
      b.setState(b.getState()) // no-op round-trip must not disturb b
      const fromB = Array.from({ length: 20 }, () => b.next())
      expect(fromB).toEqual(fromA)
    })

    it('reports a finite, serialisable state', () => {
      const r = createRng(64)
      r.next()
      const s = r.getState()
      expect(Number.isFinite(s)).toBe(true)
      expect(JSON.parse(JSON.stringify({ s })).s).toBe(s)
    })
  })
})
