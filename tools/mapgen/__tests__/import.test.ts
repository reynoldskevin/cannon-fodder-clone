import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLevel, MapgenError } from '../index'
import { canvas, encodePng, drawCrosshair, drawLabel, fillRect, type RGB } from './helpers/png'

/**
 * Ticket 003 — tools/mapgen.
 *
 * Fixtures are built here with an independent PNG encoder, so every case is a real
 * encode -> import round-trip. The annotation convention mirrors the real asset:
 * a ~25x25 crosshair glyph, with a wide-and-short text label beside it that the
 * importer must discard.
 */

const BLUE: RGB = [60, 160, 255]
const RED: RGB = [255, 60, 60]
const YELLOW: RGB = [255, 220, 0]
const GRASS: RGB = [90, 130, 40]
const CANOPY: RGB = [20, 40, 15]

const TILE = 16

/** A legend matching the real level-1 convention. */
function legend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tileSize: TILE,
    colourTolerance: 40,
    markerColours: {
      '60,160,255': 'avatars',
      '255,60,60': 'enemies',
      '255,220,0': 'props',
    },
    labels: [],
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapgen-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a level source directory and import it. */
function makeLevel(
  width: number, height: number,
  draw: (data: Buffer, w: number) => void,
  legendObj: Record<string, unknown> = legend(),
  extra: { walkableMask?: Buffer } = {},
): { outPath: string; result: ReturnType<typeof importLevel> } {
  const src = join(dir, 'levels', 'test-level')
  mkdirSync(src, { recursive: true })
  const data = canvas(width, height, GRASS)
  draw(data, width)
  writeFileSync(join(src, 'map.png'), encodePng(width, height, data))
  writeFileSync(join(src, 'legend.json'), JSON.stringify(legendObj, null, 2))
  if (extra.walkableMask) {
    writeFileSync(join(src, 'walkable.png'), extra.walkableMask)
  }
  const outDir = join(dir, 'out')
  const result = importLevel({ sourceDir: src, outDir, name: 'test-level' })
  return { outPath: join(outDir, 'test-level.json'), result }
}

describe('marker detection', () => {
  it('detects one spawn per crosshair glyph, in the right category', () => {
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, BLUE)
      drawCrosshair(d, w, 100, 40, RED)
      drawCrosshair(d, w, 40, 100, YELLOW)
    })
    expect(result.level.spawns.avatars).toHaveLength(1)
    expect(result.level.spawns.enemies).toHaveLength(1)
    expect(result.level.spawns.props).toHaveLength(1)
  })

  it('converts glyph centroids from pixels to tile coordinates', () => {
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 72, BLUE)
    })
    // 40/16 = 2, 72/16 = 4
    expect(result.level.spawns.avatars[0]).toMatchObject({ x: 2, y: 4 })
  })

  it('detects several markers of the same category', () => {
    const { result } = makeLevel(320, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, RED)
      drawCrosshair(d, w, 140, 40, RED)
      drawCrosshair(d, w, 240, 40, RED)
    })
    expect(result.level.spawns.enemies).toHaveLength(3)
  })

  it('finds no spawns in an unannotated image', () => {
    const { result } = makeLevel(160, 160, () => {})
    expect(result.level.spawns.avatars).toEqual([])
    expect(result.level.spawns.enemies).toEqual([])
    expect(result.level.spawns.props).toEqual([])
  })

  it('tolerates anti-aliased marker colours within the legend tolerance', () => {
    const NEAR_RED: RGB = [250, 70, 55]
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, NEAR_RED)
    })
    expect(result.level.spawns.enemies).toHaveLength(1)
  })

  it('does not match a colour outside the tolerance', () => {
    const FAR: RGB = [255, 160, 160]
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, FAR)
    })
    expect(result.level.spawns.enemies).toEqual([])
  })
})

describe('glyph vs text-label discrimination', () => {
  it('discards the wide-and-short text label beside a glyph', () => {
    const { result } = makeLevel(200, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, RED)
      drawLabel(d, w, 60, 40, RED) // "Enemy" label to the right
    })
    expect(result.level.spawns.enemies).toHaveLength(1)
  })

  it('keeps the glyph centroid, not the label, as the spawn position', () => {
    const { result } = makeLevel(200, 160, (d, w) => {
      drawCrosshair(d, w, 40, 72, BLUE)
      drawLabel(d, w, 60, 72, BLUE)
    })
    expect(result.level.spawns.avatars[0]).toMatchObject({ x: 2, y: 4 })
  })

  it('discards labels for every category at once', () => {
    const { result } = makeLevel(320, 240, (d, w) => {
      drawCrosshair(d, w, 40, 40, BLUE); drawLabel(d, w, 60, 40, BLUE)
      drawCrosshair(d, w, 40, 120, RED); drawLabel(d, w, 60, 120, RED)
      drawCrosshair(d, w, 40, 200, YELLOW); drawLabel(d, w, 60, 200, YELLOW)
    })
    expect(result.level.spawns.avatars).toHaveLength(1)
    expect(result.level.spawns.enemies).toHaveLength(1)
    expect(result.level.spawns.props).toHaveLength(1)
  })

  it('reports discarded label clusters rather than silently dropping them', () => {
    const { result } = makeLevel(200, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, RED)
      drawLabel(d, w, 60, 40, RED)
    })
    expect(result.report.discardedClusters.length).toBeGreaterThan(0)
  })
})

describe('legend-driven prop identity', () => {
  it('assigns a prop type from the legend by nearest position', () => {
    const { result } = makeLevel(320, 240, (d, w) => {
      drawCrosshair(d, w, 40, 40, YELLOW)
      drawCrosshair(d, w, 200, 200, YELLOW)
    }, legend({
      labels: [
        { at: [40, 40], type: 'shrub' },
        { at: [200, 200], type: 'tree' },
      ],
    }))
    const types = result.level.spawns.props.map((p) => p.type)
    expect(types).toContain('shrub')
    expect(types).toContain('tree')
  })

  it('tolerates a legend position that is slightly off the detected centroid', () => {
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, YELLOW)
    }, legend({ labels: [{ at: [44, 37], type: 'bird_left' }] }))
    expect(result.level.spawns.props[0]?.type).toBe('bird_left')
  })

  it('reports a legend label that matches no detected marker', () => {
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, YELLOW)
    }, legend({ labels: [{ at: [140, 140], type: 'orphan' }] }))
    expect(result.report.unmatchedLabels).toContainEqual(
      expect.objectContaining({ type: 'orphan' }),
    )
  })
})

describe('unrecognised markers are reported, never silently dropped', () => {
  it('reports an unknown saturated marker colour with its coordinate', () => {
    const MAGENTA: RGB = [255, 0, 255]
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 72, MAGENTA)
    })
    expect(result.report.unknownMarkers.length).toBeGreaterThan(0)
    const m = result.report.unknownMarkers[0]!
    expect(m).toHaveProperty('x')
    expect(m).toHaveProperty('y')
    expect(m).toHaveProperty('colour')
  })

  it('does not turn an unknown marker into a spawn', () => {
    const MAGENTA: RGB = [255, 0, 255]
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, MAGENTA)
    })
    expect(result.level.spawns.avatars).toEqual([])
    expect(result.level.spawns.enemies).toEqual([])
    expect(result.level.spawns.props).toEqual([])
  })
})

describe('terrain and walkability', () => {
  it('emits a terrain grid sized to image / tileSize', () => {
    const { result } = makeLevel(160, 96, () => {})
    expect(result.level.size).toEqual({ w: 10, h: 6 })
    expect(result.level.terrain).toHaveLength(6)
    expect(result.level.terrain[0]).toHaveLength(10)
  })

  it('derives walkability heuristically when no mask is supplied', () => {
    const { result } = makeLevel(160, 160, (d, w) => {
      fillRect(d, w, 0, 0, 32, 32, CANOPY) // dense canopy blocks
    })
    expect(result.level.walkable[0]?.[0]).toBe(false)
    expect(result.level.walkable[5]?.[5]).toBe(true)
  })

  it('warns when no walkable mask is present, but does not crash', () => {
    const { result } = makeLevel(160, 160, () => {})
    expect(result.report.warnings.join(' ')).toMatch(/walkable/i)
  })

  it('honours a hand-painted walkable mask over the heuristic', () => {
    // Mask: black = blocked, white = walkable. Block the whole left half,
    // which the heuristic would otherwise call walkable grass.
    const mask = canvas(160, 160, [255, 255, 255])
    fillRect(mask, 160, 0, 0, 80, 160, [0, 0, 0])
    const { result } = makeLevel(160, 160, () => {}, legend(), {
      walkableMask: encodePng(160, 160, mask),
    })
    expect(result.level.walkable[0]?.[0]).toBe(false)
    expect(result.level.walkable[0]?.[9]).toBe(true)
  })

  it('does not warn about a missing mask when one is supplied', () => {
    const mask = canvas(160, 160, [255, 255, 255])
    const { result } = makeLevel(160, 160, () => {}, legend(), {
      walkableMask: encodePng(160, 160, mask),
    })
    expect(result.report.warnings.join(' ')).not.toMatch(/no walkable mask/i)
  })

  it('rejects a walkable mask whose dimensions do not match the map', () => {
    const mask = canvas(80, 80, [255, 255, 255])
    expect(() => makeLevel(160, 160, () => {}, legend(), {
      walkableMask: encodePng(80, 80, mask),
    })).toThrow(MapgenError)
  })
})

describe('output contract', () => {
  it('writes the level file to the output directory', () => {
    const { outPath } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, BLUE)
    })
    expect(existsSync(outPath)).toBe(true)
  })

  it('writes JSON that parses and carries the current schema version', () => {
    const { outPath, result } = makeLevel(160, 160, () => {})
    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(written.schemaVersion).toBe(result.level.schemaVersion)
    expect(written.size).toEqual({ w: 10, h: 10 })
  })

  it('validates before writing — output always passes loadLevel', () => {
    // importLevel must run its own output through the ticket-002 loader.
    const { result } = makeLevel(160, 160, (d, w) => {
      drawCrosshair(d, w, 40, 40, BLUE)
    })
    expect(result.validated).toBe(true)
  })

  it('is idempotent — a second run produces byte-identical output', () => {
    const src = join(dir, 'levels', 'idem')
    mkdirSync(src, { recursive: true })
    const data = canvas(160, 160, GRASS)
    drawCrosshair(data, 160, 40, 40, BLUE)
    writeFileSync(join(src, 'map.png'), encodePng(160, 160, data))
    writeFileSync(join(src, 'legend.json'), JSON.stringify(legend()))
    const outDir = join(dir, 'out-idem')

    importLevel({ sourceDir: src, outDir, name: 'idem' })
    const first = readFileSync(join(outDir, 'idem.json'))
    importLevel({ sourceDir: src, outDir, name: 'idem' })
    const second = readFileSync(join(outDir, 'idem.json'))

    expect(second.equals(first)).toBe(true)
  })

  it('names the level from the source directory name', () => {
    const { result } = makeLevel(160, 160, () => {})
    expect(result.level.name).toBe('test-level')
  })
})

describe('failure handling', () => {
  it('throws MapgenError when the map image is missing', () => {
    const src = join(dir, 'levels', 'empty')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'legend.json'), JSON.stringify(legend()))
    expect(() => importLevel({ sourceDir: src, outDir: join(dir, 'o'), name: 'empty' }))
      .toThrow(MapgenError)
  })

  it('throws MapgenError when the legend is missing', () => {
    const src = join(dir, 'levels', 'nolegend')
    mkdirSync(src, { recursive: true })
    const data = canvas(32, 32, GRASS)
    writeFileSync(join(src, 'map.png'), encodePng(32, 32, data))
    expect(() => importLevel({ sourceDir: src, outDir: join(dir, 'o'), name: 'nolegend' }))
      .toThrow(MapgenError)
  })

  it('throws MapgenError when the legend is malformed', () => {
    const src = join(dir, 'levels', 'badlegend')
    mkdirSync(src, { recursive: true })
    const data = canvas(32, 32, GRASS)
    writeFileSync(join(src, 'map.png'), encodePng(32, 32, data))
    writeFileSync(join(src, 'legend.json'), '{ not valid json')
    expect(() => importLevel({ sourceDir: src, outDir: join(dir, 'o'), name: 'badlegend' }))
      .toThrow(MapgenError)
  })

  it('throws MapgenError when tileSize does not divide the image evenly', () => {
    expect(() => makeLevel(100, 100, () => {}, legend({ tileSize: 32 })))
      .toThrow(MapgenError)
  })

  it('MapgenError carries a message naming the problem', () => {
    try {
      makeLevel(100, 100, () => {}, legend({ tileSize: 32 }))
      throw new Error('expected MapgenError')
    } catch (err) {
      expect(err).toBeInstanceOf(MapgenError)
      expect((err as MapgenError).message.length).toBeGreaterThan(0)
    }
  })
})
