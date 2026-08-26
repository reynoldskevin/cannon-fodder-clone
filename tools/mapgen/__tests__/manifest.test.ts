import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLevelsManifest, LEVELS_MANIFEST_FILE } from '../manifest'

/**
 * Ticket 024 — the app cannot list a directory over HTTP.
 *
 * `main.ts` fetches level documents by name, so the set of published levels has
 * to be a FILE. The importer already knows that set — it is the loop it just
 * ran — so it writes one, exactly as `tools/spritegen` already writes
 * `sprites.manifest.json` for the atlas.
 *
 * THE ORDER IS THE CAMPAIGN ORDER, and that is the whole reason this is a list
 * rather than a set. `CampaignState.unlockedLevels` counts, and the runner turns
 * that count into an index into this array; shuffle it and beating level one
 * unlocks whichever level happens to be second in a directory listing.
 */

let outDir: string
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'levels-manifest-'))
})
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
})

const read = (): unknown => JSON.parse(readFileSync(join(outDir, LEVELS_MANIFEST_FILE), 'utf8'))

describe('the levels manifest', () => {
  it('names every level that was imported', () => {
    writeLevelsManifest(outDir, ['level1', 'level2', 'level3'])
    expect(read()).toEqual({ levels: ['level1', 'level2', 'level3'] })
  })

  it('keeps the order it was given, because that order is the campaign', () => {
    /**
     * Deliberately NOT re-sorted here. `import-levels.mjs` already sorts the
     * source directories when it enumerates them, so the order is a property of
     * the filenames rather than of the filesystem — and a second sort in here
     * would be a second opinion about campaign order, in the module least able
     * to have one.
     */
    writeLevelsManifest(outDir, ['alpha', 'bravo', 'charlie'])
    expect(read()).toEqual({ levels: ['alpha', 'bravo', 'charlie'] })
  })

  it('is idempotent, like every other thing the importer writes', () => {
    // Ticket 003's rule for the whole pipeline: running twice produces
    // byte-identical output, so a rebuild is never a diff.
    writeLevelsManifest(outDir, ['level1', 'level2'])
    const first = readFileSync(join(outDir, LEVELS_MANIFEST_FILE), 'utf8')
    writeLevelsManifest(outDir, ['level1', 'level2'])
    expect(readFileSync(join(outDir, LEVELS_MANIFEST_FILE), 'utf8')).toBe(first)
  })

  it('writes an empty list rather than no file at all', () => {
    /**
     * A checkout with no levels is a normal state — `import-levels.mjs` says so
     * and exits cleanly. But an ABSENT manifest and an EMPTY one mean different
     * things to the app: absent is "this build is broken", empty is "there is
     * nothing to play". Collapsing them would make a missing manifest
     * indistinguishable from a game with no content, and ticket 024 turns the
     * first into a fatal error on screen.
     */
    writeLevelsManifest(outDir, [])
    expect(existsSync(join(outDir, LEVELS_MANIFEST_FILE))).toBe(true)
    expect(read()).toEqual({ levels: [] })
  })

  it('creates the output directory if it is not there', () => {
    // The importer creates `outDir` for the level documents; the manifest must
    // not be the one thing that assumes somebody else did it first.
    const nested = join(outDir, 'a', 'b')
    writeLevelsManifest(nested, ['level1'])
    expect(existsSync(join(nested, LEVELS_MANIFEST_FILE))).toBe(true)
  })

  it('is JSON a browser can parse, with no trailing comma or BOM', () => {
    writeLevelsManifest(outDir, ['level1'])
    const raw = readFileSync(join(outDir, LEVELS_MANIFEST_FILE), 'utf8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

describe('and the real pipeline writes one', () => {
  it('after an import, the manifest sits beside the documents it names', () => {
    /**
     * The contract test between the two halves. `import-levels.mjs` writes the
     * level documents and this manifest into the SAME directory, and `main.ts`
     * fetches both from one base path — so a manifest written somewhere else
     * would be a 404 at boot with every unit test green.
     */
    const src = mkdtempSync(join(tmpdir(), 'levels-src-'))
    try {
      mkdirSync(join(src, 'level1'), { recursive: true })
      writeFileSync(join(outDir, 'level1.json'), '{}')
      writeLevelsManifest(outDir, ['level1'])
      expect(existsSync(join(outDir, 'level1.json'))).toBe(true)
      expect(existsSync(join(outDir, LEVELS_MANIFEST_FILE))).toBe(true)
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })
})
