import { describe, it, expect } from 'vitest'
import { scene } from './fixture'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ticket 007 — determinism.
 *
 * Ticket 005 bought the fixed timestep and the seeded PRNG so that a mission
 * replays identically; a movement system that reaches for `Math.random` to
 * scatter its formation spends that guarantee for a cosmetic wobble. The source
 * scan below is the same one 005 applies to `core/`, narrowed to this module —
 * duplicated deliberately, because a scan that lives only in 005's suite is a
 * scan that stops covering new directories the moment someone adds one.
 */

const SQUAD_DIR = new URL('..', import.meta.url).pathname

const OPEN = `
  ..................
  ..................
  ..................
  ..................
  ..................
  ..................
  ..................
  ..................
`

const OPTS = { speedTilesPerSecond: 3, separationRadius: 0.6 } as const

/** Build the same scene twice and march it, returning every unit's final tile. */
function march(ticks: number): { x: number; y: number }[] {
  const s = scene(OPEN, OPTS)
  const ids = [s.spawn(2, 4), s.spawn(2, 5), s.spawn(2, 3), s.spawn(3, 4), s.spawn(3, 5)].map(
    (e) => e.id,
  )
  s.squad.order(ids, { x: 15, y: 4 })
  s.run(ticks)
  return ids.map((id) => s.tileOf(id))
}

describe('determinism', () => {
  it('two identical squads end in identical positions', () => {
    expect(march(400)).toEqual(march(400))
  })

  it('stays identical at every checkpoint, not just the end', () => {
    // An end-state comparison can pass on two runs that diverged and reconverged
    // at a wall. Sampling the whole march is what rules that out.
    for (const ticks of [1, 7, 30, 111, 250, 400]) {
      expect({ ticks, at: march(ticks) }).toEqual({ ticks, at: march(ticks) })
    }
  })

  it('is not vacuous — the squad genuinely moved and spread', () => {
    const end = march(400)
    expect(end[0]!.x).toBeGreaterThan(12)
    const ys = new Set(end.map((p) => p.y.toFixed(4)))
    expect(ys.size).toBeGreaterThan(1)
  })

  it('produces identical results after a death mid-march', () => {
    const run = (): { x: number; y: number }[] => {
      const s = scene(OPEN, OPTS)
      const ids = [s.spawn(2, 4), s.spawn(2, 5), s.spawn(2, 3), s.spawn(3, 4)].map((e) => e.id)
      s.squad.order(ids, { x: 15, y: 4 })
      s.run(60)
      s.world.despawn(ids[0]!)
      s.run(240)
      return ids.slice(1).map((id) => s.tileOf(id))
    }
    expect(run()).toEqual(run())
  })

  it('produces identical results after a mid-march split', () => {
    const run = (): { x: number; y: number }[] => {
      const s = scene(OPEN, OPTS)
      const ids = [s.spawn(2, 4), s.spawn(2, 5), s.spawn(2, 3), s.spawn(3, 4)].map((e) => e.id)
      s.squad.order(ids, { x: 15, y: 4 })
      s.run(60)
      s.squad.order([ids[2]!, ids[3]!], { x: 2, y: 7 })
      s.run(240)
      return ids.map((id) => s.tileOf(id))
    }
    expect(run()).toEqual(run())
  })
})

describe('no non-determinism at the source level', () => {
  /**
   * Comments removed, so a mention of `Math.random` in prose is not a finding.
   *
   * A pure string function, separate from the file read, so the guard below can
   * exercise it on a literal input. Pointing it at THIS file instead is the
   * obvious move and it is a trap: any phrase the assertion names as a needle is
   * also a string literal in this file, and `strip` removes comments, not
   * literals — so the needle survives its own strip and the guard can never
   * pass. Two earlier versions of this test failed exactly that way.
   */
  function strip(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  const code = (file: string): string => strip(readFileSync(file, 'utf8'))

  const sources = readdirSync(SQUAD_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SQUAD_DIR, f))

  it('has sources to scan', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('calls no Math.random', () => {
    for (const file of sources) {
      expect({ file, found: /Math\s*\.\s*random/.test(code(file)) }).toEqual({ file, found: false })
    }
  })

  it('calls no wall clock', () => {
    for (const file of sources) {
      const src = code(file)
      expect({ file, found: /Date\s*\.\s*now|new\s+Date\b|performance\s*\.\s*now/.test(src) }).toEqual(
        { file, found: false },
      )
    }
  })

  it('strips comments without eating the code around them', () => {
    // The two scans above are only as good as this. A stripper that returned ''
    // would pass them both on any source whatsoever, which is the failure mode
    // that makes a green determinism suite worthless.
    const sample = [
      '/** Math.random in a block comment. */',
      "const kept = 'Math' // Math.random in a line comment",
      '/* multi',
      '   line Math.random */',
      "const url = 'https://example.com/not-a-comment'",
    ].join('\n')
    const out = strip(sample)
    expect(out).not.toMatch(/Math\s*\.\s*random/)
    expect(out).toContain('const kept')
    expect(out).toContain('const url')
    // `//` inside a URL is preceded by `:`, which is why the line regex excludes
    // it — without that carve-out this would truncate the assignment.
    expect(out).toContain('https://example.com/not-a-comment')
  })
})
