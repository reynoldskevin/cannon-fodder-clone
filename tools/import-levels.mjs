#!/usr/bin/env node
/**
 * tools/import-levels — the offline level import pipeline (ticket 003).
 *
 * Scans `assets/source/levels/<name>/` for `map.png` + `legend.json` and writes
 * a validated `public/generated/levels/<name>.json` for each. The game never
 * parses an image at runtime; it loads only what this script emits.
 *
 * Nothing to import is not an error — the level source tree is authored assets,
 * and a checkout without any is a perfectly normal state.
 *
 * This script — like everything under `tools/` — stays free of `three`.
 */

import { existsSync, readdirSync } from 'node:fs'
import { register } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node strips TypeScript types but does not guess extensions. This hook — owned
// by tools/, applied only to this process — teaches it to, so neither the game's
// source nor the shared tsconfig has to carry `.ts` specifiers for the sake of
// offline tooling.
register('./ts-resolve-hooks.mjs', import.meta.url)

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const sourceRoot = join(root, 'assets/source/levels')
const outDir = join(root, 'public/generated/levels')

if (!existsSync(sourceRoot)) {
  console.log(`import:levels — nothing to import: ${sourceRoot} does not exist.`)
  process.exit(0)
}

const levels = readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (levels.length === 0) {
  console.log(`import:levels — nothing to import: no level directories in ${sourceRoot}.`)
  process.exit(0)
}

// Imported lazily so a checkout with no levels never pays for (or fails on) the
// importer's dependencies.
const { importLevel, MapgenError, writeLevelsManifest, LEVELS_MANIFEST_FILE } = await import(
  './mapgen/index.ts'
)

let failed = 0
/**
 * The levels that actually reached disk, in the order they were imported —
 * which is `levels`, and so sorted by name.
 *
 * ONLY THE ONES THAT SUCCEEDED. The manifest is a promise that each name can be
 * fetched, so a level that failed validation must not be in it: the game would
 * ask for a document the importer refused to write and die on a 404 at boot.
 */
const imported = []
for (const name of levels) {
  const sourceDir = join(sourceRoot, name)
  try {
    const { level, report } = importLevel({ sourceDir, outDir, name })
    imported.push(name)
    const { avatars, enemies, props, chests } = level.spawns
    console.log(
      `import:levels — ${name}: ${level.size.w}x${level.size.h} tiles, ` +
        `${avatars.length} avatars, ${enemies.length} enemies, ` +
        `${props.length} props, ${chests.length} chests`,
    )
    console.log(`  walkability source: ${level.walkableSource ?? 'unstated'}`)
    for (const warning of report.warnings) console.warn(`  warning: ${warning}`)
    for (const marker of report.unknownMarkers) {
      console.warn(`  unknown marker ${marker.colour} at (${marker.x}, ${marker.y})`)
    }
    for (const label of report.unmatchedLabels) {
      console.warn(`  unmatched legend label "${label.type}" at (${label.at[0]}, ${label.at[1]})`)
    }
    for (const cluster of report.suspiciousClusters) {
      console.warn(
        `  suspicious ${cluster.colour} ${cluster.category} glyph at (${cluster.x}, ${cluster.y}) ` +
          `${cluster.w}x${cluster.h}, ${cluster.pixels}px: ${cluster.reason}`,
      )
    }
    // Discarded ink is where a lost spawn hides, so it is printed, not just
    // returned. Glyph-sized discards get a line each; the swarm of letter-stroke
    // fragments around every text label is summarised, since listing ~90 of them
    // per level would bury the ones that matter.
    //
    // The two summaries are counted over DISJOINT sets and named for what each
    // actually contains. A single "sub-glyph ink fragments" total used to merge
    // the letter strokes of the text labels with the hundreds of small bright
    // clusters found in colours the legend never declared — which on the real
    // asset are jungle foliage, not ink at all — and so described the map itself
    // as annotation.
    const candidates = report.discardedClusters.filter((c) => c.glyphCandidate)
    for (const cluster of candidates) {
      console.warn(
        `  discarded ${cluster.colour} (${cluster.category}) cluster at (${cluster.x}, ${cluster.y}) ` +
          `${cluster.w}x${cluster.h}, ${cluster.pixels}px: ${cluster.reason}`,
      )
    }
    const fragments = report.discardedClusters.filter(
      (c) => !c.glyphCandidate && c.category !== 'unknown',
    ).length
    const terrainLike = report.discardedClusters.filter(
      (c) => !c.glyphCandidate && c.category === 'unknown',
    ).length
    if (fragments > 0) {
      console.log(
        `  ${fragments} sub-glyph clusters in declared marker colours discarded as text ink`,
      )
    }
    if (terrainLike > 0) {
      console.log(
        `  ${terrainLike} sub-glyph clusters in undeclared bright colours left as terrain ` +
          `(foliage highlight, flowers — too small to be markers)`,
      )
    }
  } catch (err) {
    failed += 1
    if (err instanceof MapgenError) console.error(`import:levels — ${name}: ${err.message}`)
    else throw err
  }
}

// INTO THE SAME DIRECTORY AS THE DOCUMENTS (ticket 024). `main.ts` fetches the
// manifest and the levels it names off one base path, so a manifest written
// anywhere else is a 404 at boot with every unit test still green.
//
// WRITTEN BEFORE THE FAILURE EXIT, and listing only what validated: a run with a
// broken level still leaves the manifest agreeing with the documents on disk,
// and still exits non-zero so the failure is not mistaken for a clean build.
writeLevelsManifest(outDir, imported)
console.log(`import:levels — wrote ${LEVELS_MANIFEST_FILE}: ${imported.join(', ') || '(none)'}`)

if (failed > 0) {
  console.error(`import:levels — ${failed} level(s) failed to import.`)
  process.exit(1)
}

console.log(`import:levels — imported ${levels.length} level(s) into ${outDir}.`)
