import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSprites, DIRECTIONS } from '../index'

/**
 * Ticket 004 — the REAL assets, end to end.
 *
 * Expected counts and dimensions were measured from the supplied sheets before
 * any pipeline code existed, so they are independent ground truth:
 *   3 sheets, each 1920x1920 RGBA, 4 columns x 8 rows, cell 480x240.
 */

const repoRoot = resolve(__dirname, '../../..')
const SOURCE = join(repoRoot, 'assets/source/sprites')

const ANIMATIONS = ['walk', 'fire', 'die'] as const
const PROPS = ['tree1', 'tree2', 'tree3', 'bush'] as const

let out: ReturnType<typeof buildSprites>
let manifest: Record<string, unknown>

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'spritegen-'))
  out = buildSprites({ sourceDir: SOURCE, outDir: dir })
  manifest = JSON.parse(readFileSync(join(dir, 'sprites.manifest.json'), 'utf8'))
})

describe('soldier frames', () => {
  it('emits 3 animations x 8 directions x 4 frames = 96 frames', () => {
    let count = 0
    for (const anim of ANIMATIONS) {
      for (const dir of DIRECTIONS) {
        count += out.manifest.units.soldier.animations[anim].directions[dir].frames.length
      }
    }
    expect(count).toBe(96)
  })

  it('has all three animations', () => {
    expect(Object.keys(out.manifest.units.soldier.animations).sort())
      .toEqual([...ANIMATIONS].sort())
  })

  it('has all eight compass directions for every animation', () => {
    for (const anim of ANIMATIONS) {
      expect(Object.keys(out.manifest.units.soldier.animations[anim].directions).sort())
        .toEqual([...DIRECTIONS].sort())
    }
  })

  it('has exactly 4 frames per direction', () => {
    for (const anim of ANIMATIONS) {
      for (const dir of DIRECTIONS) {
        expect(out.manifest.units.soldier.animations[anim].directions[dir].frames).toHaveLength(4)
      }
    }
  })

  it('declares a positive fps per animation', () => {
    for (const anim of ANIMATIONS) {
      expect(out.manifest.units.soldier.animations[anim].fps).toBeGreaterThan(0)
    }
  })
})

describe('frame geometry', () => {
  it('gives every frame a non-empty rect inside the atlas', () => {
    for (const anim of ANIMATIONS) {
      for (const dir of DIRECTIONS) {
        for (const f of out.manifest.units.soldier.animations[anim].directions[dir].frames) {
          expect(f.rect.width).toBeGreaterThan(0)
          expect(f.rect.height).toBeGreaterThan(0)
          expect(f.rect.x + f.rect.width).toBeLessThanOrEqual(out.manifest.atlas.width)
          expect(f.rect.y + f.rect.height).toBeLessThanOrEqual(out.manifest.atlas.height)
        }
      }
    }
  })

  it('keeps the anchor constant across the frames of an animation', () => {
    // `die` shrinks 199px -> 110px of content; a per-frame anchor would slide
    // the body up the screen as the soldier falls.
    for (const anim of ANIMATIONS) {
      for (const dir of DIRECTIONS) {
        const frames = out.manifest.units.soldier.animations[anim].directions[dir].frames
        const first = frames[0]!.anchor
        for (const f of frames) expect(f.anchor).toEqual(first)
      }
    }
  })

  it('records a trim offset so the original cell position is recoverable', () => {
    const frames = out.manifest.units.soldier.animations.die.directions.N.frames
    const offsets = frames.map((f) => f.offset.y)
    // The die frames do NOT all start at the same y — proof they were not
    // re-centred on their own content.
    expect(new Set(offsets).size).toBeGreaterThan(1)
  })

  it('trims frames smaller than the 480x240 source cell', () => {
    const f = out.manifest.units.soldier.animations.walk.directions.N.frames[0]!
    expect(f.rect.width).toBeLessThan(480)
    expect(f.rect.height).toBeLessThan(240)
  })
})

describe('props and floor', () => {
  it('emits every prop', () => {
    for (const p of PROPS) expect(out.manifest.props[p]).toBeDefined()
  })

  it('gives each prop a rect and an anchor', () => {
    for (const p of PROPS) {
      expect(out.manifest.props[p]!.rect.width).toBeGreaterThan(0)
      expect(out.manifest.props[p]!.anchor).toBeDefined()
    }
  })

  it('emits the tileable floor texture', () => {
    expect(out.manifest.floor).toBeDefined()
  })
})

describe('output contract', () => {
  it('writes both the atlas and the manifest', () => {
    expect(existsSync(out.atlasPath)).toBe(true)
    expect(existsSync(out.manifestPath)).toBe(true)
  })

  it('writes a manifest that parses and matches the returned one', () => {
    expect(manifest).toEqual(JSON.parse(JSON.stringify(out.manifest)))
  })

  it('keeps the atlas within 4096x4096', () => {
    expect(out.manifest.atlas.width).toBeLessThanOrEqual(4096)
    expect(out.manifest.atlas.height).toBeLessThanOrEqual(4096)
  })

  it('is idempotent — a second run is byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spritegen-idem-'))
    const a = buildSprites({ sourceDir: SOURCE, outDir: dir })
    const atlasA = readFileSync(a.atlasPath)
    const manA = readFileSync(a.manifestPath)
    buildSprites({ sourceDir: SOURCE, outDir: dir })
    expect(readFileSync(a.atlasPath).equals(atlasA)).toBe(true)
    expect(readFileSync(a.manifestPath).equals(manA)).toBe(true)
  })

  it('reports the downscale factor it applied', () => {
    expect(out.manifest.scale).toBeGreaterThan(0)
    expect(out.manifest.scale).toBeLessThanOrEqual(1)
  })
})

describe('failure handling', () => {
  it('throws a named error when the source directory is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spritegen-missing-'))
    expect(() => buildSprites({ sourceDir: join(dir, 'nope'), outDir: dir })).toThrow()
  })
})
