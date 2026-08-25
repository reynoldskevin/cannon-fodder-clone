import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Ticket 008 — what `PointerController` is allowed to know about `core/`.
 *
 * The acceptance criterion is "imports nothing from `core/` except the command
 * types and the queue", and that is a rule about DIRECTION OF DEPENDENCY that no
 * type system will enforce for us: `src/input/` may legally import anything, so
 * nothing breaks the day someone reaches for `World` here to check whether a
 * unit is alive before queueing. It compiles, it passes, and the single input
 * path into the simulation has quietly become two.
 *
 * ESLint already polices the reverse direction (`core/` must not import
 * `input/`) in `eslint.config.js`. This is the same idea applied to the one
 * forward edge this ticket cares about, asserted on the source text because that
 * is what the rule is actually about.
 */

const SOURCE = new URL('../pointer-controller.ts', import.meta.url).pathname

/** Every module specifier this file imports from, static or dynamic. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const specifiers: string[] = []
  const patterns = [
    /import\s[^'"]*from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) specifiers.push(match[1]!)
  }
  return specifiers
}

describe('PointerController imports', () => {
  const specifiers = importsOf(SOURCE)

  it('finds the imports at all, so the assertions below are not vacuous', () => {
    expect(specifiers.length).toBeGreaterThan(0)
  })

  it('reaches into core/ only for the command module', () => {
    const core = specifiers.filter((s) => s.includes('core/'))
    expect(core.length).toBeGreaterThan(0)
    for (const specifier of core) {
      expect({ specifier, ok: /(^|\/)core\/command(\/index)?$/.test(specifier) }).toEqual({
        specifier,
        ok: true,
      })
    }
  })

  it('does not import the World', () => {
    for (const specifier of specifiers) {
      expect({ specifier, world: /core\/world/.test(specifier) }).toEqual({
        specifier,
        world: false,
      })
    }
  })

  it('does not import any simulation system', () => {
    for (const specifier of specifiers) {
      const system = /core\/(squad|combat|pathing|session)/.test(specifier)
      expect({ specifier, system }).toEqual({ specifier, system: false })
    }
  })

  it('does not reach sideways into render, app, ui or audio', () => {
    // The rig and the renderer are handed IN; this file must not go and get them.
    // (`three` itself is fine — `src/input/` is not engine-free.)
    for (const specifier of specifiers) {
      const sideways = /(^|\/)(render|app|ui|audio)\//.test(specifier)
      expect({ specifier, sideways }).toEqual({ specifier, sideways: false })
    }
  })
})
