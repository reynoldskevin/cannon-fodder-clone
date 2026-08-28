#!/usr/bin/env node
/**
 * tools/build-models — the offline sprite pipeline (ticket 004).
 *
 * Reads `assets/source/sprites/` (the soldier sheets, the props and the three
 * tileable ground textures) and writes `public/generated/sprites/{atlas.webp,
 * floor.webp, water.webp, bridge.webp, sprites.manifest.json}`. The game loads
 * only those; it never slices a sheet at runtime.
 *
 * WEBP SINCE TICKET 084, AND THIS SCRIPT IS WHERE THAT LIVES. `atlas.png` was
 * 6.92 MB — on its own more than everything else the page loaded put together —
 * and the four files together were 7.76 MB against 1.70 MB re-encoded. The
 * encoder is `cwebp`, a binary, so `buildSprites` takes an `ImageWriter` rather
 * than shelling out itself: that keeps `tools/spritegen`'s tests able to exercise
 * rect packing without libwebp installed, and puts the one impure step in the
 * script that already exists to be impure.
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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
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
const { encodePng } = await import('./spritegen/image.ts')

const kb = (path) => `${(statSync(path).size / 1024).toFixed(0)} KB`

/**
 * The WebP writer (ticket 084).
 *
 * VIA A TEMPORARY PNG because `cwebp` reads a file, not a pipe, and there is no
 * WebP encoder in this project's dependency tree. It runs four times per build of
 * a script that is run by hand, so the extra write is not worth avoiding.
 *
 * THE FLAGS, EACH OF WHICH WAS MEASURED:
 *
 * - `-alpha_q 100` keeps the alpha channel LOSSLESS. Verified: 0 of 8,323,072
 *   alpha values changed. A sprite sheet is mostly cut-out edges, and softening
 *   those would be the one visible thing lossy compression could do here.
 *
 * - `-exact` preserves colour under fully transparent pixels, which is not the
 *   pedantry it looks like. `bleedOpaqueColour` and `extrudeEdges` put deliberate
 *   colour in exactly that space so mipmap averaging does not drag halos into
 *   sprite edges; without `-exact` the encoder rewrote 12.9% of those pixels by
 *   up to 255. With it: 6.4%, capped at 78 — and it is SMALLER as well (1.618 MB
 *   against 1.637 MB), so it costs nothing.
 *
 * - `-q 92` rather than lower. The saving is already 78% here and the curve is
 *   flat below it; the 16px gutter from `pack.ts` is far wider than any WebP
 *   block, so artefacts cannot cross between sprites. A mission frame rendered
 *   from PNG and from this is indistinguishable.
 *
 * REPRODUCIBILITY IS WEAKER THAN IT WAS, and it should be said plainly:
 * `encodePng` pins its deflate settings so the committed atlas is byte-identical
 * across machines. `cwebp` is deterministic for given input and flags, but its
 * output may differ between libwebp versions, so that guarantee now depends on
 * the encoder version too. What protects the build is
 * `generated-sprites-current.test.ts` — the manifest and the files agreeing —
 * rather than the bytes themselves.
 */
const webpWriter = {
  extension: '.webp',
  encode(image) {
    const dir = mkdtempSync(join(tmpdir(), 'spritegen-webp-'))
    try {
      const png = join(dir, 'in.png')
      const webp = join(dir, 'out.webp')
      writeFileSync(png, encodePng(image))
      execFileSync(
        'cwebp',
        ['-quiet', '-q', '92', '-alpha_q', '100', '-exact', png, '-o', webp],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      )
      return readFileSync(webp)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
}

try {
  const { manifest, atlasPath, manifestPath, groundPaths, matteDecisions } = buildSprites({
    sourceDir,
    outDir,
    writer: webpWriter,
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
