import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Ticket 083 — the pictures the screens import are small, present and committed.
 *
 * WHY IMAGES AND WHY NOW. After ticket 082 took the sound from 10.19 MB to
 * 0.31 MB, a measured playthrough of the live site pulled 14.49 MB — of which
 * 14.17 MB was pictures, 0.18 MB JavaScript and 0.11 MB sound. Images are no
 * longer part of the payload; they ARE the payload.
 *
 * READ AS SOURCE TEXT, like `samples.test.ts` and for the same reason: `menu.ts`
 * and its neighbours build DOM on their first lines and this suite runs on
 * `environment: 'node'`, so the modules cannot be imported here. Parse the import
 * lines, then ask the filesystem about what they name.
 */

const UI_DIR = new URL('../', import.meta.url)
const REPO_ROOT = new URL('../../../', import.meta.url)

/**
 * Every `?url` image import across `src/ui`, as (module, path) pairs.
 *
 * FONTS ARE EXCLUDED BY DIRECTORY, not by extension. `display-font.ts` imports
 * `assets/source/fonts/font.woff2` through the same `?url` mechanism, and it is
 * neither a picture nor compressible by anything in this ticket — WOFF2 is
 * already Brotli inside. Excluding it by folder rather than by suffix keeps this
 * file's one rule intact: never decide what a file is from what it is called.
 */
const imports: readonly { readonly module: string; readonly path: string }[] = readdirSync(
  UI_DIR,
)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .flatMap((name) => {
    const source = readFileSync(new URL(name, UI_DIR), 'utf8')
    return [
      ...source.matchAll(/^import\s+\w+\s+from\s+'([^']*\/assets\/[^']*?)\?url'/gm),
    ].map((m) => ({ module: name, path: m[1] as string }))
  })
  .filter((i) => !i.path.includes('/fonts/'))

const resolve = (p: string): string => fileURLToPath(new URL(p, UI_DIR))

/** The first bytes of a file, for asking what it really is. */
const magic = (p: string): string => {
  const head = Buffer.alloc(8)
  const fd = readFileSync(resolve(p))
  fd.copy(head, 0, 0, Math.min(8, fd.length))
  return head.toString('hex')
}

const isPngRaster = (p: string): boolean => magic(p).startsWith('89504e47')

describe('the screens import real pictures', () => {
  it('and there are some to check', () => {
    /**
     * NON-VACUITY. Everything below sweeps `imports`, so a change of import style
     * — a barrel module, a rename of `assets/` — would empty the list and leave
     * every case passing while checking nothing. Thirteen is what `src/ui` names
     * today across six modules.
     */
    expect(imports.length).toBe(13)
    expect(new Set(imports.map((i) => i.module)).size).toBe(6)
  })

  it('naming files that are actually there', () => {
    const missing = imports.filter((i) => !existsSync(resolve(i.path)))
    expect(missing).toEqual([])
  })

  it('and committed, so a clean clone can build', () => {
    /**
     * THE GUARD TICKET 082 ADDED FOR SOUND, APPLIED HERE. Nine untracked `.wav`
     * files made the repository unbuildable from a clean clone while every test
     * passed, because every test ran on the one machine that had them. Newly
     * generated `.webp` files are exactly the same hazard.
     */
    const absolute = imports.map((i) => resolve(i.path))
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--', ...absolute], {
        cwd: fileURLToPath(REPO_ROOT),
        encoding: 'utf8',
      })
        .split('\0')
        .filter((line) => line !== '')
        .map((line) => fileURLToPath(new URL(line, REPO_ROOT))),
    )
    expect(absolute.filter((p) => !tracked.has(p))).toEqual([])
  })
})

describe('none of them is a lossless PNG any more', () => {
  it('judged by magic bytes, not by the name of the file', () => {
    /**
     * THE WHOLE REASON THIS IS BYTE-LEVEL. `jungle-background.png` is not a PNG:
     * it opens `ffd8ffe0` and is a JPEG someone named `.png`, which works only
     * because browsers sniff content instead of trusting extensions. A test that
     * asserted "every import ends in `.webp`" would have demanded that file be
     * converted — making it BIGGER (224 kB against 191 kB) and adding a second
     * generation of loss — on the strength of a filename that was lying.
     *
     * So the question asked is the real one: is this still an UNCOMPRESSED
     * raster? PNG magic means bytes are being spent that q92 would not spend.
     */
    const stillPng = imports.filter((i) => isPngRaster(i.path)).map((i) => i.path)
    expect(stillPng).toEqual([])
  })

  it('and the one JPEG is left as it is, on purpose', () => {
    /**
     * PINNED RATHER THAN LEFT TO THE SWEEP ABOVE, which passes for a JPEG whether
     * that was a decision or an oversight. It was a decision: already lossy, and
     * bigger every way it was re-encoded.
     */
    const jpegs = imports.filter((i) => magic(i.path).startsWith('ffd8ff'))
    expect(jpegs.map((i) => i.path.split('/').pop())).toEqual(['jungle-background.png'])
  })
})

describe('the pictures fit in a sensible budget', () => {
  it('the whole set under 1.2 MB, down from 6.53 MB', () => {
    /**
     * A TOTAL, because the menu alone pulled 2.58 MB of it before a mission
     * started. The cap leaves room for another screen's art without leaving room
     * to slip a lossless master back in — the single largest file here was 980 kB
     * on its own.
     */
    const total = imports.reduce((sum, i) => sum + statSync(resolve(i.path)).size, 0)
    expect(total).toBeLessThan(1_200_000)
    // Not zero-length placeholders, which would satisfy every check above.
    expect(total).toBeGreaterThan(400_000)
  })

  it('with no single picture over a quarter of a megabyte', () => {
    const heavy = imports
      .map((i) => ({ name: i.path.split('/').pop(), bytes: statSync(resolve(i.path)).size }))
      .filter((f) => f.bytes > 256_000)
    expect(heavy).toEqual([])
  })
})

describe('every screen still has the art it draws', () => {
  it('each module importing exactly what it did before', () => {
    /**
     * THE SILENT-LOSS RISK, and it is the image twin of ticket 082's cue table: a
     * dropped import is a `<img>` with no `src`, which renders as nothing and
     * throws nothing. Counted per module so a picture cannot quietly move from
     * the memorial to the menu and still total thirteen.
     */
    const perModule: Record<string, number> = {}
    for (const i of imports) perModule[i.module] = (perModule[i.module] ?? 0) + 1
    expect(perModule).toEqual({
      'boot-hill.ts': 2,
      'controls-card.ts': 1,
      'lost-in-service.ts': 1,
      'menu.ts': 5,
      'ordnance-icons.ts': 3,
      'rank-insignia.ts': 1,
    })
  })
})
