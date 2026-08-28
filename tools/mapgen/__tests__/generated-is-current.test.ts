import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { importLevel } from '../index'

/**
 * Ticket 079 — a shipped level document must be what its own source produces.
 *
 * THE GAP THAT LET TWO LEVELS DRIFT, AND IT WAS PROMISED BUT NEVER WRITTEN.
 * `level2-shoreline.test.ts` opens by calling itself "the test that fails if
 * `npm run import:levels` was not re-run" — and nothing in it checked that. Both
 * levels then drifted in exactly the way it described:
 *
 *   - level 2's map was repainted and `level2.json` rebuilt from it, while the
 *     shoreline test went on asserting the count of scrub in the OLD painting;
 *   - level 3's map was repainted and `level3.json` rebuilt, while the
 *     hand-written `kill_count: 11` in its legend stayed behind — so the mission
 *     declared itself won with three enemies still standing, and a player found
 *     it by playing.
 *
 * Every test in this directory reads the same generated file, so a document that
 * has fallen behind its source is invisible to all of them at once: they agree
 * with each other about a level nobody is playing.
 *
 * THE COMPARISON IS THE WHOLE DOCUMENT, not a summary of it. A count would pass
 * while positions moved; a hash of the source would say nothing about what the
 * importer makes of it. Re-importing and comparing is the only check that means
 * "what ships is what the art says".
 */

const repoRoot = resolve(__dirname, '../../..')
const GENERATED = join(repoRoot, 'public/generated/levels')
const SOURCE = join(repoRoot, 'assets/source/levels')

const manifest = JSON.parse(readFileSync(join(GENERATED, 'levels.manifest.json'), 'utf8')) as {
  levels: readonly string[]
}

describe('every shipped level is what its own source art produces', () => {
  it('and there are levels to check', () => {
    // Non-vacuity: the sweep below is trivially satisfied by an empty manifest,
    // which is how this rots the day the path moves.
    expect(manifest.levels.length).toBeGreaterThan(0)
  })

  for (const name of manifest.levels) {
    it(`${name} is up to date with its map and legend`, () => {
      const shipped = JSON.parse(readFileSync(join(GENERATED, `${name}.json`), 'utf8')) as unknown
      const fresh = importLevel({
        sourceDir: join(SOURCE, name),
        outDir: mkdtempSync(join(tmpdir(), `mapgen-current-${name}-`)),
        name,
      }).level

      /**
       * FIELD BY FIELD RATHER THAN ONE DEEP EQUAL, so a failure says WHICH part
       * of the level went stale — "terrain differs" and "objectives differ" send
       * a reader to completely different places, and the second is the one that
       * shipped a broken mission.
       */
      const doc = shipped as Record<string, unknown>
      const now = fresh as unknown as Record<string, unknown>
      for (const field of ['size', 'terrain', 'walkable', 'spawns', 'objectives'] as const) {
        expect({ name, field, equal: JSON.stringify(doc[field]) === JSON.stringify(now[field]) }).toEqual(
          { name, field, equal: true },
        )
      }
    })
  }
})
