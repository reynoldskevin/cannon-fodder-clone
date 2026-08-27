#!/usr/bin/env node
/**
 * tools/build-models — the offline sprite pipeline (ticket 004).
 *
 * Reads `assets/source/sprites/` (the soldier sheets, the props and the three
 * tileable ground textures) and writes `public/generated/sprites/{atlas.png,
 * floor.png, water.png, bridge.png, sprites.manifest.json}`. The game loads
 * only those; it never slices a sheet at runtime.
 *
 * The name is historical: the plan specced voxelisation here. The sprites are
 * drawn at the camera's own 55° angle and the camera never rotates, so a
 * camera-aligned quad is pixel-exact from the only viewpoint that exists, and
 * an atlas is both cheaper and more faithful than rebuilt volume.
 *
 * Nothing to build is not an error — the sprite source tree is authored assets,
 * and a checkout without any is a perfectly normal state.
 *
 * This script — like everything under `tools/` — stays free of `three`.
 */

import { existsSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node strips TypeScript types but does not guess extensions. This hook — owned
// by tools/, applied only to this process — teaches it to.
register('./ts-resolve-hooks.mjs', import.meta.url)

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const sourceDir = join(root, 'assets/source/sprites')
const outDir = join(root, 'public/generated/sprites')

if (!existsSync(sourceDir)) {
  console.log(`build:models — nothing to build: ${sourceDir} does not exist.`)
  process.exit(0)
}

// Imported lazily so a checkout with no sprite art never pays for (or fails on)
// the pipeline's dependencies.
const { buildSprites, SpritegenError, DIRECTIONS } = await import('./spritegen/index.ts')

const kb = (path) => `${(statSync(path).size / 1024).toFixed(0)} KB`

try {
  const { manifest, atlasPath, manifestPath, groundPaths, matteDecisions } = buildSprites({
    sourceDir,
    outDir,
  })

  let frames = 0
  for (const anim of Object.values(manifest.units.soldier.animations)) {
    for (const dir of DIRECTIONS) frames += anim.directions[dir].frames.length
  }

  console.log(
    `build:models — atlas ${manifest.atlas.width}x${manifest.atlas.height} ` +
      `at scale ${manifest.scale} (${kb(atlasPath)})`,
  )
  console.log(
    `  ${frames} soldier frames (${Object.keys(manifest.units.soldier.animations).length} ` +
      `animations x ${DIRECTIONS.length} directions), ` +
      `${Object.keys(manifest.props).length} props`,
  )
  for (const [name, entry] of Object.entries(manifest.ground)) {
    console.log(
      `  ground/${name} ${entry.width}x${entry.height} kept out of the atlas so it ` +
        `still tiles (${kb(groundPaths[name])})`,
    )
  }
  console.log(`  manifest ${kb(manifestPath)} -> ${manifestPath} (rects are ${manifest.origin} origin, y-down)`)

  // The de-matte heuristic decides per image whether to bleed opaque colour
  // into the antialiased rim. It is a heuristic, so it prints its working:
  // a wrong call here shows up in game as a white halo (missed) or a flattened
  // soft gradient (over-applied), and neither is obvious from the atlas alone.
  // Override any line with `matte: { 'prop/bush': false }` in BuildOptions.
  console.log('  light-matte pass:')
  for (const d of matteDecisions) {
    const how = d.reason === 'override' ? ' (BuildOptions override)' : ''
    console.log(
      `    ${d.bled ? 'bled  ' : 'kept  '} ${d.id.padEnd(14)} near-white rim fraction ` +
        `${d.score.toFixed(4)}${how}`,
    )
  }
} catch (err) {
  if (err instanceof SpritegenError) {
    console.error(`build:models — ${err.message}`)
    process.exit(1)
  }
  throw err
}
