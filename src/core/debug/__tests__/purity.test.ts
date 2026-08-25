import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ticket 014 — `src/core/debug` obeys the same rules as the rest of `src/core`.
 *
 * A DEBUG LAYER IS EXACTLY WHERE THESE RULES GET BROKEN, which is why they are
 * asserted here rather than assumed. Every temptation points the wrong way: a
 * frame-time graph wants `performance.now()`, an arrow colour wants a random
 * jitter, and drawing anything at all wants `three`. Each would be a small,
 * reasonable-looking edit that quietly puts a wall clock inside the layer the
 * whole determinism contract depends on being free of one.
 *
 * The frame-time graph is the interesting case and it is not an exception: it
 * measures the RENDERER, not the simulation, so it belongs in `src/ui` where
 * reading a clock is allowed. Wanting to put it here and finding this test in
 * the way is the rule working, not the rule being inconvenient.
 *
 * ESLint enforces the import half of this too. Asserted again here because a
 * lint rule is a file somebody can edit — and on ticket 008 an implementer did
 * try to edit one rather than change a line of its own code.
 */

const DEBUG_DIR = new URL('..', import.meta.url).pathname

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

const sources = readdirSync(DEBUG_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(DEBUG_DIR, f))

describe('src/core/debug is engine-free and clock-free', () => {
  it('has sources to scan', () => {
    // Without this every assertion below is vacuously true on an empty list,
    // which is how a purity suite goes green after the directory it guards has
    // been renamed out from under it.
    expect(sources.length).toBeGreaterThan(0)
  })

  it('imports no engine', () => {
    for (const file of sources) {
      expect({ file, found: /from\s+['"]three['"]|require\(\s*['"]three['"]/.test(code(file)) }).toEqual(
        { file, found: false },
      )
    }
  })

  it('touches no DOM', () => {
    for (const file of sources) {
      const src = code(file)
      expect({
        file,
        found: /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bnavigator\b/.test(src),
      }).toEqual({ file, found: false })
    }
  })

  it('reads no wall clock', () => {
    for (const file of sources) {
      const src = code(file)
      expect({
        file,
        found: /Date\s*\.\s*now|new\s+Date\b|performance\s*\.\s*now/.test(src),
      }).toEqual({ file, found: false })
    }
  })

  it('draws no random number', () => {
    for (const file of sources) {
      expect({ file, found: /Math\s*\.\s*random/.test(code(file)) }).toEqual({ file, found: false })
    }
  })

  it('reaches into no sibling presentation layer', () => {
    // The seam ESLint guards: `core/` may not import from `render/`, `app/`,
    // `ui/`, `input/` or `audio/`. A debug layer that pulled a colour constant
    // out of `render/` would compile, pass every other test here, and quietly
    // make `src/core` un-runnable under Node.
    for (const file of sources) {
      const src = code(file)
      expect({
        file,
        found: /from\s+['"][^'"]*\.\.\/(render|app|ui|input|audio)\//.test(src),
      }).toEqual({ file, found: false })
    }
  })

  it('uses no dynamic import', () => {
    // The gate for the overlay's code-splitting belongs in `src/app/main.ts`,
    // which is outside this rule. A dynamic import HERE would be a second gate
    // in the layer that is meant to be a pure function of the session.
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
