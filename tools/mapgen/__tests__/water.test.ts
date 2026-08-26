import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLevel } from '../index'
import { TILE } from '../terrain'
import { canvas, encodePng, drawCrosshair, fillRect, type RGB } from './helpers/png'

/**
 * Ticket 003a — water is passable.
 *
 * THE CLASSIFIER WAS ALWAYS RIGHT; PASSABILITY WAS NOT. `classifyTile` has
 * emitted `TILE.WATER` for blue-dominant tiles since ticket 003, and on the real
 * level-2 artwork it finds 685 water tiles against 671 counted independently off
 * the source pixels — the difference being despeckling. What decides
 * `walkable`, though, is `buildWalkable`, which asks only whether a tile is
 * bright enough to be open ground. Water is dark. So the river came out solid,
 * the map came out cut in two, and the squad could reach 7 of 15 enemies.
 *
 * The fix is not a second luminance threshold for blue. It is that the
 * classifier has already decided what the tile IS, and passability should follow
 * from that rather than from a brightness test that was never about water.
 */

const BLUE: RGB = [60, 160, 255]
const RED: RGB = [255, 60, 60]
const GRASS: RGB = [90, 130, 40]
/** Dark green: dense canopy. Below the luminance threshold, and NOT water. */
const CANOPY: RGB = [20, 40, 15]
/** The real river's colour, straight off level 2's artwork. */
const WATER: RGB = [0, 32, 80]
const ROCK: RGB = [120, 100, 80]

const TS = 16

function legend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tileSize: TS,
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
let outDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapgen-water-'))
  outDir = mkdtempSync(join(tmpdir(), 'mapgen-water-out-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

/**
 * A map `w` x `h` TILES of grass, with a band of `terrain` painted across a
 * range of tile columns, and one avatar and one enemy marker on dry ground.
 *
 * The markers exist because the importer needs spawns to import at all; they are
 * placed well clear of the band so no case below is measuring a marker.
 */
function build(terrain: RGB, bandFrom: number, bandTo: number, w = 12, h = 6): void {
  const px = canvas(w * TS, h * TS, GRASS)
  fillRect(px, w * TS, bandFrom * TS, 0, (bandTo - bandFrom) * TS, h * TS, terrain)
  drawCrosshair(px, w * TS, 1 * TS + TS / 2, 2 * TS + TS / 2, BLUE)
  drawCrosshair(px, w * TS, 10 * TS + TS / 2, 2 * TS + TS / 2, RED)
  writeFileSync(join(dir, 'map.png'), encodePng(w * TS, h * TS, px))
  writeFileSync(join(dir, 'legend.json'), JSON.stringify(legend()))
}

/** Import what `build` wrote. */
const imported = () => importLevel({ sourceDir: dir, outDir, name: 'water-test' })

/** The terrain id and walkability of the tile at (x, y). */
function tileAt(level: ReturnType<typeof importLevel>['level'], x: number, y: number) {
  return { terrain: level.terrain[y]?.[x], walkable: level.walkable[y]?.[x] }
}

describe('a water tile is passable', () => {
  it('is classified as water AND marked walkable', () => {
    build(WATER, 4, 8)
    const { level } = imported()
    expect(tileAt(level, 6, 3)).toEqual({ terrain: TILE.WATER, walkable: true })
  })

  it('which is what makes a map with a river across it one connected map', () => {
    /**
     * The failure this ticket exists to remove, in miniature: a band of water
     * from edge to edge with dry ground either side. Before, the band was solid
     * and the two banks were separate maps.
     */
    build(WATER, 4, 8)
    const { level } = imported()
    const w = level.size.w
    const h = level.size.h
    const seen = new Set<number>()
    const q: [number, number][] = [[0, 0]]
    seen.add(0)
    while (q.length > 0) {
      const next = q.pop()
      if (next === undefined) break
      const [x, y] = next
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const k = ny * w + nx
        if (seen.has(k) || level.walkable[ny]?.[nx] !== true) continue
        seen.add(k)
        q.push([nx, ny])
      }
    }
    // Every tile of this fixture is grass or water, so a connected map is the
    // whole of it. Stated as the full count rather than "the far bank is
    // reachable", which a single lucky diagonal would satisfy.
    expect(seen.size).toBe(w * h)
  })
})

describe('the luminance rule is untouched for everything else', () => {
  it('canopy is still blocked, and it is darker than water', () => {
    /**
     * THE CASE THAT RULES OUT THE LAZY FIX. Water is dark, so "let dark tiles
     * through" would make this pass too — and would open every canopy tile on
     * every level in the game. Canopy is deliberately DARKER than the river
     * colour here, so a threshold moved down far enough to admit water would
     * admit this as well.
     */
    build(CANOPY, 4, 8)
    const { level } = imported()
    expect(tileAt(level, 6, 3)).toEqual({ terrain: TILE.CANOPY, walkable: false })
  })

  it('grass is still walkable', () => {
    build(GRASS, 4, 8)
    const { level } = imported()
    expect(tileAt(level, 6, 3)).toEqual({ terrain: TILE.GRASS, walkable: true })
  })

  it('and rock is decided by its brightness exactly as before', () => {
    build(ROCK, 4, 8)
    const { level } = imported()
    const cell = tileAt(level, 6, 3)
    expect(cell.terrain).toBe(TILE.ROCK)
    expect(cell.walkable).toBe(true)
  })
})

describe('an authored mask still outranks all of it', () => {
  it('a walkable.png that paints the river black blocks the river', () => {
    /**
     * The contract that predates this ticket: "the hand-painted mask always
     * outranks the guess." An author who paints a stretch of river black has
     * decided it is impassable — a waterfall, a torrent, a minefield — and this
     * ticket must not overrule them. "Water is walkable" and "the mask decides"
     * look like they conflict until you know which runs last.
     */
    build(WATER, 4, 8)
    const w = 12
    const h = 6
    const mask = canvas(w * TS, h * TS, [255, 255, 255])
    fillRect(mask, w * TS, 4 * TS, 0, 4 * TS, h * TS, [0, 0, 0])
    writeFileSync(join(dir, 'walkable.png'), encodePng(w * TS, h * TS, mask))
    const { level } = imported()
    // Still water — the mask decides passability, never classification.
    expect(tileAt(level, 6, 3)).toEqual({ terrain: TILE.WATER, walkable: false })
    expect(level.walkableSource).toBe('mask')
  })

  it('and a mask that paints canopy white opens it', () => {
    // The other direction, so the case above is not passing merely because the
    // mask is ignored and the river happens to be blocked by something else.
    build(CANOPY, 4, 8)
    const w = 12
    const h = 6
    const mask = canvas(w * TS, h * TS, [255, 255, 255])
    writeFileSync(join(dir, 'walkable.png'), encodePng(w * TS, h * TS, mask))
    const { level } = imported()
    expect(tileAt(level, 6, 3)).toEqual({ terrain: TILE.CANOPY, walkable: true })
  })
})
