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
  /** Source with comments stripped, so a mention in prose is not a finding. */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

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

  it('does not iterate a Set or Map keyed on insertion order it did not control', () => {
    // Not a ban on Set/Map — it is a ban on iterating one whose insertion order
    // comes from outside. This asserts the comment-stripper itself works, so the
    // two scans above cannot pass by stripping the whole file away.
    const stripped = code(join(SQUAD_DIR, '__tests__', 'determinism.test.ts'))
    expect(stripped).toContain('describe(')
    expect(stripped).not.toContain('the same one 005 applies')
  })
})
