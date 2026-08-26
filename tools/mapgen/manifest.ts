/**
 * The levels manifest (ticket 024) — the list of published levels, on disk.
 *
 * THE APP CANNOT LIST A DIRECTORY OVER HTTP. `main.ts` fetches level documents
 * by name, so the set of published levels has to be a FILE; the importer already
 * knows that set, because it is the loop it just ran. This is the same move
 * `tools/spritegen` makes when it writes `sprites.manifest.json` for the atlas.
 *
 * THE ORDER IS THE CAMPAIGN ORDER, and that is why this is a list rather than a
 * set: `CampaignState.unlockedLevels` counts, and the runner turns that count
 * into an index into this array. It is written EXACTLY as given and is never
 * re-sorted here — `import-levels.mjs` sorts the source directories when it
 * enumerates them, so the order is a property of the filenames rather than of
 * the filesystem, and a second sort in this module would be a second opinion
 * about campaign order in the module least able to have one.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEVELS_MANIFEST_FILE } from '../../src/core/level/index'
import { stableStringify } from './json'

// Re-exported so a caller writing the manifest and a caller naming it read the
// same constant. It is DEFINED in `src/core/level` because the game fetches it
// and cannot import anything under `tools/` — see the note there.
export { LEVELS_MANIFEST_FILE }

/**
 * Write `{ "levels": [...] }` into `outDir`.
 *
 * IDEMPOTENT, like everything else the pipeline emits (ticket 003): the same
 * names produce a byte-identical file, so a rebuild is never a diff.
 *
 * AN EMPTY LIST IS STILL A FILE. An ABSENT manifest and an EMPTY one mean
 * different things to the app — absent is "this build is broken", empty is
 * "there is nothing to play" — and collapsing them would make a missing manifest
 * indistinguishable from a game with no content, which is the fatal error ticket
 * 024 puts on screen.
 *
 * IT CREATES `outDir` ITSELF. The importer creates that directory for the level
 * documents, and the manifest must not be the one thing that assumes somebody
 * else did it first: written into a directory that does not exist, the write
 * throws and the run fails after every level has already been imported.
 */
export function writeLevelsManifest(outDir: string, names: readonly string[]): void {
  mkdirSync(outDir, { recursive: true })
  // Copied rather than handed straight to the serialiser, so a caller that goes
  // on mutating the array it passed cannot change what was written.
  writeFileSync(join(outDir, LEVELS_MANIFEST_FILE), stableStringify({ levels: [...names] }))
}
