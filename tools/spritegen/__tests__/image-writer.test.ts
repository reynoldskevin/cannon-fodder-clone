import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSprites, type ImageWriter } from '../index.ts'
import { encodePng } from '../image.ts'

/**
 * Ticket 084 — the emitted image format is a parameter, not a constant.
 *
 * WHY INJECT RATHER THAN SWITCH THE TOOL OVER. `atlas.png` is 6.92 MB and has to
 * become WebP, but there is no WebP encoder in this project's dependencies and
 * there is not going to be one: the encoder is `cwebp`, a binary. Welding a
 * `child_process` call into `buildSprites` would mean every test in
 * `tools/spritegen` — and any CI that runs them — needs libwebp installed to
 * exercise packing logic that has nothing to do with compression.
 *
 * So the default writer stays PNG and `build-models.mjs`, which already exists
 * to be the side-effectful driver, supplies the WebP one.
 *
 * THE PART THAT MUST NOT COME APART is the extension: the manifest's `file`
 * fields and the filenames on disk are read by `sprite-atlas.ts` and
 * `ground-texture.ts` at runtime, and a manifest naming `atlas.png` beside a file
 * called `atlas.webp` is a 404 nobody sees until the game is open.
 */

const SOURCE = new URL('../../../assets/source/sprites/', import.meta.url).pathname

const outDir = (): string => mkdtempSync(join(tmpdir(), 'spritegen-writer-'))

describe('by default the pipeline still emits PNG', () => {
  it('naming .png in the manifest and writing .png to disk', () => {
    /**
     * THE COMPATIBILITY CLAIM, PINNED. Every other test in this directory calls
     * `buildSprites` with no writer and asserts things about `.png` files. If the
     * default ever flips, those break in a scatter of confusing ways; this one
     * breaks first and says why.
     */
    const dir = outDir()
    const out = buildSprites({ sourceDir: SOURCE, outDir: dir })

    expect(out.manifest.atlas.file).toBe('atlas.png')
    expect(existsSync(join(dir, 'atlas.png'))).toBe(true)
    for (const entry of Object.values(out.manifest.ground)) {
      expect(entry.file.endsWith('.png')).toBe(true)
      expect(existsSync(join(dir, entry.file))).toBe(true)
    }
  })
})

describe('a custom writer controls the extension and the bytes together', () => {
  /**
   * A WRITER THAT IS NOT WEBP ON PURPOSE. Using a fake extension and fake bytes
   * proves the plumbing carries whatever the writer says, rather than proving
   * that `cwebp` happens to be installed on this machine — which is exactly the
   * dependency this design exists to avoid. The real WebP writer is exercised by
   * the committed output, in `generated-sprites-current.test.ts`.
   */
  const marker = Buffer.from('SPRITEGEN-TEST-FORMAT')
  const writer: ImageWriter = {
    extension: '.test',
    encode: (image) => Buffer.concat([marker, encodePng(image)]),
  }

  it('renames the atlas in the manifest and on disk at once', () => {
    const dir = outDir()
    const out = buildSprites({ sourceDir: SOURCE, outDir: dir, writer })

    expect(out.manifest.atlas.file).toBe('atlas.test')
    expect(existsSync(join(dir, 'atlas.test'))).toBe(true)
    expect(existsSync(join(dir, 'atlas.png'))).toBe(false)
  })

  it('and renames every ground texture the same way', () => {
    const dir = outDir()
    const out = buildSprites({ sourceDir: SOURCE, outDir: dir, writer })

    const files = Object.values(out.manifest.ground).map((e) => e.file)
    expect(files.every((f) => f.endsWith('.test'))).toBe(true)
    // The stems are unchanged — only the extension moves. `floor` is emitted
    // from `floor-jungle.png`, so this also pins that the rename did not reach
    // back into the SOURCE name.
    expect([...files].sort()).toEqual(['bridge.test', 'floor.test', 'water.test'])
    for (const file of files) expect(existsSync(join(dir, file))).toBe(true)
  })

  it('writing the writer’s bytes rather than a PNG with a new name', () => {
    /**
     * THE VACUOUS VERSION OF THIS TICKET would rename the files and keep emitting
     * PNG bytes — every extension assertion above would pass, the manifest would
     * agree with the disk, and the atlas would still be 6.92 MB. Reading the
     * bytes back is what makes the rename mean something.
     */
    const dir = outDir()
    const out = buildSprites({ sourceDir: SOURCE, outDir: dir, writer })

    const head = readFileSync(join(dir, out.manifest.atlas.file)).subarray(0, marker.length)
    expect(head.equals(marker)).toBe(true)
  })

  it('and reporting the paths it actually wrote', () => {
    /**
     * `build-models.mjs` prints file sizes from `atlasPath` and `groundPaths`. If
     * those kept the old extension the driver would `statSync` a file that is not
     * there and the build would die after doing all the work.
     */
    const dir = outDir()
    const out = buildSprites({ sourceDir: SOURCE, outDir: dir, writer })

    expect(out.atlasPath).toBe(join(dir, 'atlas.test'))
    expect(existsSync(out.atlasPath)).toBe(true)
    for (const path of Object.values(out.groundPaths)) expect(existsSync(path)).toBe(true)
  })
})
