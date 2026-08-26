import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadLevel } from '../index'
import { CURRENT_SCHEMA_VERSION } from '../types'

/**
 * Ticket 018 — archetype and patrol fields ride the schema's existing extension
 * point.
 *
 * THE CLAIM `core/level/types.ts` MAKES IN ITS OWN HEADER is that the document
 * is "deliberately *open* at its extension points", that adding an enemy
 * archetype "must never require a `schemaVersion` bump", and that unknown fields
 * are preserved verbatim rather than dropped. This ticket is the second time
 * that promise has been cashed — ticket 017's chest `reward` was the first — and
 * a promise nobody tests is a promise that quietly stops being true.
 *
 * IF THIS TICKET HAD NEEDED A BUMP, the schema's whole design would have been
 * worth less than it claims: every level authored before today would have had to
 * be rewritten to add an enemy type.
 */

const LEVEL_1 = 'public/generated/levels/level1.json'

/** The real shipped document, not a fixture. */
function level1(): unknown {
  return JSON.parse(readFileSync(LEVEL_1, 'utf8'))
}

describe('level 1 is untouched by this ticket', () => {
  it('still validates', () => {
    // THE REGRESSION THAT WOULD MATTER MOST: the one level the game actually
    // ships failing to load.
    expect(() => loadLevel(level1())).not.toThrow()
  })

  it('still declares the current schema version', () => {
    const parsed = loadLevel(level1())
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('still has its enemies, none of which name an archetype or a route', () => {
    // Which is exactly why the fallback path matters more than the table: every
    // enemy in the shipped game takes it.
    const parsed = loadLevel(level1())
    expect(parsed.spawns.enemies.length).toBeGreaterThan(0)
    for (const spawn of parsed.spawns.enemies) {
      expect({ patrol: spawn['patrol'] }).toEqual({ patrol: undefined })
    }
  })
})

describe('a patrol route survives the loader', () => {
  const withRoute = (patrol: unknown): unknown => {
    const doc = level1() as { spawns: { enemies: unknown[] } }
    doc.spawns.enemies = [{ x: 4, y: 4, type: 'jungle-scout', patrol }]
    return doc
  }

  it('is preserved verbatim, not dropped', () => {
    const route = [
      { x: 4, y: 4 },
      { x: 9, y: 4 },
    ]
    const parsed = loadLevel(withRoute(route))
    expect(parsed.spawns.enemies[0]?.['patrol']).toEqual(route)
  })

  it('is deep-copied, so the loaded level cannot be edited through the document', () => {
    /**
     * `core/level` promises a deep copy. A route shared with the caller's JSON
     * would let a mapgen run, or a second `loadLevel` of the same object, edit
     * a level already in play — and ticket 017 found the same aliasing one level
     * down in a chest's reward, so this is not hypothetical.
     */
    const route = [{ x: 4, y: 4 }]
    const doc = withRoute(route) as { spawns: { enemies: { patrol: { x: number }[] }[] } }
    const parsed = loadLevel(doc)
    doc.spawns.enemies[0]!.patrol[0]!.x = 999
    expect((parsed.spawns.enemies[0]?.['patrol'] as { x: number }[])[0]?.x).toBe(4)
  })

  it('needs no schemaVersion bump to carry one', () => {
    const parsed = loadLevel(withRoute([{ x: 1, y: 1 }]))
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('an enemy naming an archetype the build has never heard of still loads', () => {
    // Archetype `type` is an open enum by decision. A level from a newer mapgen
    // must load and fall back, not refuse to start.
    const doc = level1() as { spawns: { enemies: unknown[] } }
    doc.spawns.enemies = [{ x: 4, y: 4, type: 'space-marine' }]
    const parsed = loadLevel(doc)
    expect(parsed.spawns.enemies[0]?.type).toBe('space-marine')
  })
})
