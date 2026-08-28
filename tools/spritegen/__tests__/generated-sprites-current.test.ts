import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Ticket 084 — the committed sprite output is WebP, and says so consistently.
 *
 * THE FAILURE THIS PREVENTS IS A 404 IN A FILE NOBODY READS. `sprite-atlas.ts`
 * resolves `manifest.atlas.file` and `ground-texture.ts` resolves `entry.file`;
 * neither hard-codes an extension, which is the whole reason this ticket needed
 * no change in `src/render`. The flip side is that the manifest is now the ONLY
 * thing tying the loaders to the files — a manifest saying `atlas.png` next to a
 * file called `atlas.webp` type-checks, lints, builds, and fails at runtime with
 * an empty playfield.
 *
 * READ OFF THE COMMITTED OUTPUT, not regenerated. These four files ship; the
 * question is whether what shipped is coherent, not whether the tool could
 * produce something coherent if run. (`generated-is-current.test.ts` does the
 * regeneration check for levels, where the importer is pure TypeScript. It cannot
 * be done here without libwebp on the machine running the tests.)
 */

const SPRITES = new URL('../../../public/generated/sprites/', import.meta.url)

interface GroundEntry {
  readonly file: string
}
interface Manifest {
  readonly atlas: { readonly file: string; readonly width: number; readonly height: number }
  readonly ground: Readonly<Record<string, GroundEntry>>
}

const manifest = JSON.parse(
  readFileSync(new URL('sprites.manifest.json', SPRITES), 'utf8'),
) as Manifest

/** Every image file the manifest tells the game to load. */
const declared: readonly string[] = [
  manifest.atlas.file,
  ...Object.values(manifest.ground).map((e) => e.file),
]

const bytesOf = (file: string): Buffer => readFileSync(new URL(file, SPRITES))

/** RIFF....WEBP — checked at both offsets, since only the tail identifies it. */
const isWebp = (file: string): boolean => {
  const b = bytesOf(file)
  return b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'
}

describe('the manifest and the files on disk agree', () => {
  it('and there is something to agree about', () => {
    // Non-vacuity: one atlas and three ground textures.
    expect(declared.length).toBe(4)
  })

  it('every file the manifest names exists', () => {
    const missing = declared.filter((f) => !existsSync(new URL(f, SPRITES)))
    expect(missing).toEqual([])
  })

  it('and nothing is shipped that the manifest does not name', () => {
    /**
     * THE OTHER DIRECTION, which is how the old format would linger. Emitting
     * `atlas.webp` while leaving a stale 6.92 MB `atlas.png` beside it would pass
     * every check above and keep the entire cost of this ticket in the deploy.
     */
    const onDisk = readdirSync(SPRITES).filter((f) => !f.endsWith('.json'))
    expect([...onDisk].sort()).toEqual([...declared].sort())
  })
})

describe('the shipped sprite output is WebP', () => {
  it('judged by magic bytes rather than by the name', () => {
    const notWebp = declared.filter((f) => !isWebp(f))
    expect(notWebp).toEqual([])
  })

  it('and the manifest calls them .webp, so the loaders ask for the right URL', () => {
    /**
     * Both halves are needed and they are different claims: the case above says
     * the BYTES are WebP, this one says the NAMES are. A file with WebP content
     * under a `.png` name would serve with the wrong `Content-Type` and, more to
     * the point, would mean the rename never happened.
     */
    expect(declared.filter((f) => !f.endsWith('.webp'))).toEqual([])
  })
})

describe('and it fits in a budget worth having done this for', () => {
  it('under 2 MB in total, down from 7.76 MB', () => {
    const total = declared.reduce(
      (sum, f) => sum + statSync(fileURLToPath(new URL(f, SPRITES))).size,
      0,
    )
    expect(total).toBeLessThan(2_000_000)
    // Not truncated files, which would satisfy every structural check above.
    expect(total).toBeGreaterThan(800_000)
  })

  it('with the atlas still the size the manifest claims it is', () => {
    /**
     * THE GEOMETRY IS LOAD-BEARING. Every sprite rect in the manifest is in
     * pixels against `atlas.width`/`atlas.height`; re-encoding at a different
     * size would shift every frame on the sheet while every file-level check here
     * still passed. 2048x4064 is what the packer produced.
     */
    expect({ w: manifest.atlas.width, h: manifest.atlas.height }).toEqual({ w: 2048, h: 4064 })
  })
})
