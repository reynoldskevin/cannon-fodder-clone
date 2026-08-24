import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { importLevel } from '../index'
import { loadLevel } from '../../../src/core/level/index'

/**
 * Ticket 003, final acceptance criterion — the importer must work on the REAL
 * asset, not just synthetic fixtures.
 *
 * The expected values below were measured directly from
 * `assets/source/level1.png` (912x720, 16px tiles => 57x45 grid) before any
 * importer code existed, so they are an independent ground truth rather than a
 * transcription of whatever the implementation happens to produce.
 *
 * Measured with STRICT 8-connected components (no dilation): every crosshair
 * glyph is exactly 25x25, and each text label is a separate 3-5 x 8 cluster.
 * Glyph centroids in pixels — avatars (465,639) (511,660); enemies (684,108)
 * (291,147) (211,210); props (795,438) (148,585) (720,591).
 *
 * Positions come from GLYPH GEOMETRY ONLY. The legend supplies prop *identity*,
 * never position — a legend that could move a spawn would let hand-authored
 * coordinates silently diverge from the map art.
 */

const repoRoot = resolve(__dirname, '../../..')
const LEVEL1 = join(repoRoot, 'assets/source/levels/level1/map.png')

const EXPECTED = {
  size: { w: 57, h: 45 },
  avatars: [{ x: 29, y: 39 }, { x: 31, y: 41 }],
  enemies: [{ x: 42, y: 6 }, { x: 18, y: 9 }, { x: 13, y: 13 }],
  props: [{ x: 49, y: 27 }, { x: 9, y: 36 }, { x: 45, y: 36 }],
}

const LEGEND = {
  tileSize: 16,
  colourTolerance: 40,
  markerColours: {
    '60,160,255': 'avatars',
    '255,60,60': 'enemies',
    '255,220,0': 'props',
  },
  labels: [
    { at: [804, 437], type: 'bird_left' },
    { at: [154, 584], type: 'shrub' },
    { at: [720, 591], type: 'tree' },
  ],
}

let result: ReturnType<typeof importLevel>

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'mapgen-level1-'))
  const src = join(dir, 'level1')
  mkdirSync(src, { recursive: true })
  copyFileSync(LEVEL1, join(src, 'map.png'))
  writeFileSync(join(src, 'legend.json'), JSON.stringify(LEGEND, null, 2))
  result = importLevel({ sourceDir: src, outDir: join(dir, 'out'), name: 'level1' })
})

/** Compare ignoring order — detection order is an implementation detail. */
function sortPoints(pts: readonly { x: number; y: number }[]) {
  return [...pts].map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.y - b.y || a.x - b.x)
}

describe('level1.png imports correctly', () => {
  it('derives the 57x45 tile grid', () => {
    expect(result.level.size).toEqual(EXPECTED.size)
    expect(result.level.terrain).toHaveLength(45)
    expect(result.level.terrain[0]).toHaveLength(57)
    expect(result.level.walkable).toHaveLength(45)
  })

  it('finds exactly 2 player spawns at the measured tiles', () => {
    expect(result.level.spawns.avatars).toHaveLength(2)
    expect(sortPoints(result.level.spawns.avatars)).toEqual(sortPoints(EXPECTED.avatars))
  })

  it('finds exactly 3 enemy spawns at the measured tiles', () => {
    expect(result.level.spawns.enemies).toHaveLength(3)
    expect(sortPoints(result.level.spawns.enemies)).toEqual(sortPoints(EXPECTED.enemies))
  })

  it('finds exactly 3 scenery props at the measured tiles', () => {
    expect(result.level.spawns.props).toHaveLength(3)
    expect(sortPoints(result.level.spawns.props)).toEqual(sortPoints(EXPECTED.props))
  })

  it('assigns the prop identities supplied by the legend', () => {
    const types = result.level.spawns.props.map((p) => p.type).sort()
    expect(types).toEqual(['bird_left', 'shrub', 'tree'])
  })

  it('does not mistake the red terrain flowers for enemy markers', () => {
    // The jungle contains dark red/orange foliage (~178,64,0). Only the three
    // true crosshairs are pure 255,60,60 — a sloppy tolerance would over-match.
    expect(result.level.spawns.enemies).toHaveLength(3)
  })

  it('discards the "Player"/"Enemy"/prop text labels beside each glyph', () => {
    const totalSpawns =
      result.level.spawns.avatars.length +
      result.level.spawns.enemies.length +
      result.level.spawns.props.length
    expect(totalSpawns).toBe(8)
    expect(result.report.discardedClusters.length).toBeGreaterThanOrEqual(8)
  })

  it('reports no unknown markers for a fully-described legend', () => {
    expect(result.report.unknownMarkers).toEqual([])
  })

  it('matches every legend label to a detected marker', () => {
    expect(result.report.unmatchedLabels).toEqual([])
  })

  it('produces output that passes the ticket-002 loader', () => {
    expect(result.validated).toBe(true)
    const reloaded = loadLevel(JSON.parse(JSON.stringify(result.level)))
    expect(reloaded.spawns.avatars).toHaveLength(2)
    expect(reloaded.spawns.enemies).toHaveLength(3)
  })

  it('marks a meaningful mix of walkable and blocked terrain', () => {
    // A heuristic that called everything walkable (or nothing) would be useless.
    const cells = result.level.walkable.flat()
    const walkable = cells.filter(Boolean).length
    expect(walkable).toBeGreaterThan(cells.length * 0.15)
    expect(walkable).toBeLessThan(cells.length * 0.95)
  })

  it('spawns every unit on a tile inside the grid', () => {
    const all = [
      ...result.level.spawns.avatars,
      ...result.level.spawns.enemies,
      ...result.level.spawns.props,
    ]
    for (const s of all) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThan(EXPECTED.size.w)
      expect(s.y).toBeLessThan(EXPECTED.size.h)
    }
  })
})
