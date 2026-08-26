import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ticket 020 — `src/core/flow` obeys the same rules as the rest of `src/core`.
 *
 * A SCREEN FLOW IS WHERE THIS RULE LOOKS SILLIEST AND MATTERS MOST. Everything
 * this module decides ends up on a `div`, so the pull toward reaching for one
 * from here is constant: a transition that also hides a panel, an entry state
 * read straight off `window.location`, a Debrief that stamps the date. Each
 * would be one line, and each would make the whole machine untestable under
 * Node — which is the state `src/ui` is already in, permanently, and the reason
 * every decision in this ticket was pulled out of a screen and into a value.
 *
 * The URL is the sharpest case. `resolveEntry` exists to validate a deep link
 * (`?demo=1&level=N`), and the obvious way to write it is to read
 * `location.search` here. It takes an argument instead, so `src/app` does the
 * reading and this stays a function of its input.
 */

const FLOW_DIR = new URL('..', import.meta.url).pathname

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

const sources = readdirSync(FLOW_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(FLOW_DIR, f))

describe('src/core/flow is engine-free and clock-free', () => {
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
    // A Debrief wants to say how long the mission took, and the sim's own tick
    // count already answers that exactly (`ObjectiveSystem.elapsedTicks`). A
    // wall clock would answer differently on a machine that dropped frames.
    for (const file of sources) {
      expect({
        file,
        found: /Date\s*\.\s*now|new\s+Date\b|performance\s*\.\s*now/.test(code(file)),
      }).toEqual({ file, found: false })
    }
  })

  it('never reads the URL itself', () => {
    // THE ONE THIS DIRECTORY IS MOST LIKELY TO BREAK. `resolveEntry` validates a
    // deep link, and reading `location.search` here is the obvious way to write
    // it — which moves a decision this suite can check into a place it cannot.
    for (const file of sources) {
      expect({
        file,
        found: /\blocation\b|URLSearchParams|localStorage|sessionStorage/.test(code(file)),
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
