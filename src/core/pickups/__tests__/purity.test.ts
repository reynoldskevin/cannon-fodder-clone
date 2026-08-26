import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ticket 017 — `src/core/pickups` obeys the same rules as the rest of `src/core`.
 *
 * BALLISTICS IS EXACTLY WHERE THESE RULES GET BROKEN, which is why they are
 * asserted rather than assumed — the same argument ticket 014 made for the debug
 * layer, and it lands harder here. Every temptation points the wrong way: a
 * spread cone wants `Math.random`, a smoke trail wants a frame time, a grenade
 * arc wants a `Vector3` out of `three`, and a damage roll wants a die. Each is a
 * small, reasonable-looking edit, and each would put non-determinism inside the
 * one layer the replay contract depends on being free of it.
 *
 * Randomness is not forbidden in the simulation — `World` carries a seeded `Rng`
 * for exactly this. What is forbidden is an UNSEEDED one, and `Math.random` is
 * the only way to get it. A designer who wants scatter takes `world.rng`.
 *
 * ESLint enforces the import half of this too. Asserted again here because a
 * lint rule is a file somebody can edit — and on ticket 008 an implementer did
 * try to edit one rather than change a line of its own code.
 */

const PICKUPS_DIR = new URL('..', import.meta.url).pathname

/**
 * Comments removed, so a mention of `Math.random` in prose is not a finding.
 *
 * A pure string function, kept separate from the file read so the guard below
 * can exercise it on a literal. Pointing it at THIS file instead is the obvious
 * move and it is a trap: any phrase the assertion names as a needle is also a
 * string literal here, and `strip` removes comments, not literals, so the needle
 * would survive its own strip and the guard could never pass.
 */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const code = (file: string): string => strip(readFileSync(file, 'utf8'))

const sources = readdirSync(PICKUPS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(PICKUPS_DIR, f))

describe('src/core/pickups is engine-free and clock-free', () => {
  it('has sources to scan', () => {
    // Without this every assertion below is vacuously true on an empty list,
    // which is how a purity suite goes green after the directory it guards has
    // been renamed out from under it.
    expect(sources.length).toBeGreaterThan(0)
  })

  it('imports no engine', () => {
    for (const file of sources) {
      expect({
        file,
        found: /from\s+['"]three['"]|require\(\s*['"]three['"]/.test(code(file)),
      }).toEqual({ file, found: false })
    }
  })

  it('touches no DOM', () => {
    for (const file of sources) {
      expect({
        file,
        found: /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bnavigator\b/.test(code(file)),
      }).toEqual({ file, found: false })
    }
  })

  it('reads no wall clock', () => {
    // A respawning crate, if one ever arrives, is measured in TICKS. In
    // milliseconds it would return at a different point in the simulation on a
    // machine that dropped a frame — a diverged mission from one dropped frame.
    for (const file of sources) {
      expect({
        file,
        found: /Date\s*\.\s*now|new\s+Date\b|performance\s*\.\s*now/.test(code(file)),
      }).toEqual({ file, found: false })
    }
  })

  it('draws no unseeded random number', () => {
    for (const file of sources) {
      expect({ file, found: /Math\s*\.\s*random/.test(code(file)) }).toEqual({ file, found: false })
    }
  })

  it('reaches into no sibling presentation layer', () => {
    for (const file of sources) {
      expect({
        file,
        found: /from\s+['"][^'"]*\.\.\/(render|app|ui|input|audio)\//.test(code(file)),
      }).toEqual({ file, found: false })
    }
  })

  it('uses no dynamic import', () => {
    for (const file of sources) {
      expect({ file, found: /\bimport\s*\(/.test(code(file)) }).toEqual({ file, found: false })
    }
  })

  it('strips comments without eating the code around them', () => {
    // Every scan above is only as good as this. A stripper that returned '' would
    // pass all of them against any source whatsoever, which is the failure mode
    // that makes a green purity suite worthless.
    const sample = [
      '/** Math.random and performance.now in a block comment. */',
      "const kept = 'Math' // document.body in a line comment",
      '/* multi',
      '   line three import */',
      "const url = 'https://example.com/not-a-comment'",
    ].join('\n')
    const out = strip(sample)
    expect(out).not.toMatch(/Math\s*\.\s*random/)
    expect(out).not.toMatch(/performance\s*\.\s*now/)
    expect(out).not.toMatch(/\bdocument\b/)
    expect(out).toContain('const kept')
    expect(out).toContain('https://example.com/not-a-comment')
  })
})
