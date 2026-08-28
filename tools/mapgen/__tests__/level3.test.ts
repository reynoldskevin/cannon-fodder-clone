import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { importLevel } from '../index'
import { loadLevel } from '../../../src/core/level/index'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * Ticket 070 — level 3 joins the campaign.
 *
 * `map.png` has been on disk with no `legend.json` beside it, so
 * `import:levels` skipped it silently and the campaign stayed two missions long.
 * The importer knows nothing about which colour means what — that is the whole
 * design — so the legend is the entire deliverable.
 *
 * EVERY EXPECTED VALUE BELOW WAS MEASURED FROM THE IMAGE BEFORE THE LEGEND
 * EXISTED, by decoding `map.png` and running strict 8-connected components over
 * the three annotation colours at tolerance 40 — the same method `level1.test.ts`
 * records for its own numbers, and deliberately NOT a transcription of whatever
 * the importer happens to emit. The map is 1472x1088; at 16px tiles that is a
 * 92x68 grid, and a glyph's tile is `floor(centroid / 16)`.
 *
 * ONE OF THESE WAS RE-MEASURED. The enemy near the middle of the map has its
 * centroid at y=335.93, which floors to tile 20 — a hair above the 336 boundary
 * that would have put it in 21. The first pass through this list read the
 * centroid ROUNDED for display (336) and derived the tile from that, which is a
 * different calculation from the importer's and disagreed by one tile on the one
 * marker that sits within a pixel of a tile edge. The unrounded centroid is the
 * ground truth.
 *
 * The glyphs are ~17x17 with 53-61 opaque pixels, where level 1's are 25x25.
 * That is well inside the default `minSide: 15 / maxSide: 40 / minPixels: 40`
 * envelope, so no `glyph` override is needed — but it is the reason the default
 * was checked rather than assumed.
 *
 * READS THE LEVEL'S OWN LEGEND FROM DISK rather than defining one inline. Level
 * 1's test writes its legend into a temp directory, which pins the IMPORTER but
 * says nothing about whether the shipped `legend.json` is right — and for this
 * ticket the shipped legend IS the deliverable.
 */

const repoRoot = resolve(__dirname, '../../..')
const SOURCE = join(repoRoot, 'assets/source/levels/level3')

/**
 * Measured tiles. Sorted comparisons throughout — detection order is an
 * implementation detail of the component walk.
 */
const EXPECTED = {
  size: { w: 92, h: 68 },
  avatars: [
    { x: 78, y: 7 },
    { x: 77, y: 8 },
    { x: 76, y: 8 },
  ],
  enemies: [
    { x: 8, y: 2 },
    { x: 59, y: 2 },
    { x: 29, y: 7 },
    { x: 27, y: 7 },
    { x: 2, y: 13 },
    { x: 66, y: 13 },
    { x: 57, y: 20 },
    { x: 24, y: 29 },
    { x: 14, y: 33 },
    { x: 54, y: 34 },
    { x: 51, y: 48 },
    { x: 23, y: 48 },
    { x: 62, y: 57 },
    { x: 40, y: 63 },
    { x: 6, y: 65 },
    { x: 8, y: 66 },
  ],
  props: [
    { x: 10, y: 3 },
    { x: 15, y: 5 },
    { x: 18, y: 7 },
    { x: 15, y: 9 },
    { x: 11, y: 12 },
    { x: 81, y: 40 },
    { x: 54, y: 40 },
    { x: 44, y: 44 },
    { x: 81, y: 56 },
    { x: 81, y: 60 },
    { x: 86, y: 61 },
  ],
}

let result: ReturnType<typeof importLevel>

beforeAll(() => {
  result = importLevel({
    sourceDir: SOURCE,
    outDir: mkdtempSync(join(tmpdir(), 'mapgen-level3-')),
    name: 'level3',
  })
})

const sortPoints = (pts: readonly { x: number; y: number }[]) =>
  [...pts].map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.y - b.y || a.x - b.x)

describe('level 3 imports from its own shipped legend', () => {
  it('derives the 92x68 grid a 1472x1088 map gives at 16px tiles', () => {
    expect(result.level.size).toEqual(EXPECTED.size)
    expect(result.level.terrain).toHaveLength(68)
    expect(result.level.terrain[0]).toHaveLength(92)
    expect(result.level.walkable).toHaveLength(68)
  })

  it('finds exactly three player spawns, at the measured tiles', () => {
    expect(result.level.spawns.avatars).toHaveLength(3)
    expect(sortPoints(result.level.spawns.avatars)).toEqual(sortPoints(EXPECTED.avatars))
  })

  it('finds exactly sixteen enemy spawns, at the measured tiles', () => {
    /**
     * SIXTEEN, and the count is as load-bearing as the positions. The jungle on
     * this map carries dark red foliage all over it — the same trap level 1's
     * test names — and the banks are outlined in near-pure red. A tolerance that
     * over-matched would turn scenery into a garrison; one that under-matched
     * would quietly leave a corner of the map undefended.
     */
    expect(result.level.spawns.enemies).toHaveLength(16)
    expect(sortPoints(result.level.spawns.enemies)).toEqual(sortPoints(EXPECTED.enemies))
  })

  it('finds exactly eleven props, at the measured tiles', () => {
    expect(result.level.spawns.props).toHaveLength(11)
    expect(sortPoints(result.level.spawns.props)).toEqual(sortPoints(EXPECTED.props))
  })

  it('and throws away the text label drawn beside every glyph', () => {
    /**
     * Each marker on this map has its number and name written next to it —
     * "16.Enemy", "20.Floating_Dead_Soldier" — in the SAME ink as the glyph. The
     * detector rejects those clusters on shape, and there are far more of them
     * than there are markers.
     */
    const spawns =
      result.level.spawns.avatars.length +
      result.level.spawns.enemies.length +
      result.level.spawns.props.length
    expect(spawns).toBe(30)
    expect(result.report.discardedClusters.length).toBeGreaterThan(30)
  })
})

describe('and the legend describes the map completely', () => {
  it('leaves no ink unaccounted for', () => {
    // A crosshair in a colour the legend does not declare is a marker the author
    // drew and the game will never place.
    expect(result.report.unknownMarkers).toEqual([])
  })

  it('and every label finds the glyph it names', () => {
    /**
     * AN UNMATCHED LABEL IS A STALE COORDINATE, and it fails quietly: the prop
     * still spawns, just with no type, so it silently draws nothing — which on
     * this map is indistinguishable from the ten props that correctly draw
     * nothing. This is the only thing that would catch a typo'd label position.
     */
    expect(result.report.unmatchedLabels).toEqual([])
  })

  it('and names every prop the author annotated', () => {
    const types = result.level.spawns.props.map((p) => p.type ?? '(none)').sort()
    expect(types).toEqual(
      [
        'bird_left',
        'bird_right',
        'bird_right',
        'bird_right',
        'bird_right',
        'bird_right',
        'building_door',
        'building_roof',
        'grenade_box',
        'floating_dead_soldier',
        'tree',
      ].sort(),
    )
  })

  it('and not one of them is left untyped', () => {
    // The non-vacuity check for the list above: `(none)` sorts among real names
    // and a single missing type would be easy to read past.
    for (const prop of result.level.spawns.props) {
      expect({ at: `${String(prop.x)},${String(prop.y)}`, typed: typeof prop.type }).toEqual({
        at: `${String(prop.x)},${String(prop.y)}`,
        typed: 'string',
      })
    }
  })
})

describe('and what it emits is a level this game can actually load', () => {
  it('passes the game`s own schema, not just the importer`s', () => {
    /**
     * `loadLevel` IS THE RUNTIME'S DOOR. The importer validating its own output
     * proves the importer agrees with itself; this is the other side of the
     * wire — the same function `main.ts` calls on a fetched document.
     */
    const parsed = loadLevel(JSON.parse(JSON.stringify(result.level)))
    expect(parsed.size).toEqual(EXPECTED.size)
  })

  it('and every one of the player`s men lands on ground he can stand on', () => {
    /**
     * NON-NEGOTIABLE FOR THE AVATARS. A crosshair drawn a few pixels into the
     * treeline puts a soldier on a tile he cannot occupy, and the player opens
     * the mission unable to move a man he can see. Nothing else in the pipeline
     * checks it — the importer places a spawn wherever the glyph is.
     */
    const blocked = result.level.spawns.avatars
      .filter((s) => result.level.walkable[s.y]?.[s.x] !== true)
      .map((s) => `${String(s.x)},${String(s.y)}`)
    expect(blocked).toEqual([])
  })

  it('and FIVE of the sixteen enemies do NOT, which is a fact about the map', () => {
    /**
     * MEASURED, NOT ASSUMED, AND IT IS WHY THE OBJECTIVE IS NOT `kill_all`.
     *
     * With the annotation ink excluded from the tile mean — which is what the
     * importer does, precisely so a crosshair cannot lift dark jungle above the
     * walkable cut — these five tiles read luminance 44 to 50 against a cut of
     * 55. They are dense canopy, and the author drew five enemy crosshairs
     * inside the treeline.
     *
     * THOSE FIVE ARE COMPLETELY INERT. `combat/los.ts` opens with
     * `if (!grid.passable(to)) return false`, so a man standing on an impassable
     * tile can neither be seen nor shot — and symmetrically cannot see out. They
     * cannot be reached, killed, or fired upon, and they cannot fight back.
     *
     * SO `kill_all` WOULD BE UNWINNABLE, and the importer says so in as many
     * words. This case pins the count so that the day the map is repainted — or
     * a walkability mask is authored — the objective is revisited deliberately
     * rather than left behind as a mystery.
     */
    const blocked = result.level.spawns.enemies
      .filter((s) => result.level.walkable[s.y]?.[s.x] !== true)
      .map((s) => `${String(s.x)},${String(s.y)}`)
      .sort()
    expect(blocked).toEqual(['23,48', '51,48', '57,20', '62,57', '8,2'].sort())
  })

  it('and the mission it declares can actually be won', () => {
    /**
     * THE PROPERTY THAT MATTERS, checked independently of the importer's own
     * warning: flood-fill the walkable grid from the avatar spawns and count the
     * enemies a soldier could actually walk to. `kill_count` asks for a number,
     * and if fewer than that number can be reached the mission can never end —
     * which is a level that looks completely fine until somebody plays it to the
     * last enemy and finds the objective still open.
     */
    const { w, h } = result.level.size
    const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false))
    const queue: { x: number; y: number }[] = []
    for (const start of result.level.spawns.avatars) {
      if (!seen[start.y]?.[start.x]) {
        const row = seen[start.y]
        if (row) row[start.x] = true
        queue.push(start)
      }
    }
    while (queue.length > 0) {
      const at = queue.pop()
      if (at === undefined) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = at.x + dx
        const ny = at.y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        if (result.level.walkable[ny]?.[nx] !== true) continue
        const row = seen[ny]
        if (row === undefined || row[nx]) continue
        row[nx] = true
        queue.push({ x: nx, y: ny })
      }
    }
    const reachable = result.level.spawns.enemies.filter((e) => seen[e.y]?.[e.x] === true).length
    expect(reachable).toBe(11)

    const objective = result.level.objectives[0] as { type: string; count?: number }
    expect(objective.type).toBe('kill_count')
    // The number asked for must be one the map can actually supply.
    expect(Number(objective.count)).toBeLessThanOrEqual(reachable)
  })

  it('and the map really is the mixed terrain it looks like', () => {
    /**
     * NON-VACUITY FOR THE CHECK ABOVE. If the classifier called every tile grass
     * — which is what a broken walkability rule looks like — the spawn check
     * would pass trivially. Measured naively off the image (tile mean colour, no
     * ink masking): ~1031 water, ~2465 canopy, ~2365 grass of 6256. The bounds
     * are loose because the importer despeckles and applies its shoreline rule
     * afterwards; what they pin is that all three are SUBSTANTIAL.
     */
    const counts = new Map<number, number>()
    for (const row of result.level.terrain) {
      for (const id of row) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const total = EXPECTED.size.w * EXPECTED.size.h
    expect(counts.get(4) ?? 0).toBeGreaterThan(total * 0.1) // water
    expect(counts.get(2) ?? 0).toBeGreaterThan(total * 0.2) // canopy
    expect(counts.get(1) ?? 0).toBeGreaterThan(total * 0.2) // grass
  })

  it('and it is winnable, because something says how', () => {
    // A level with no objective is a mission that can never end.
    expect(result.level.objectives.length).toBeGreaterThan(0)
  })
})

describe('and the shipped legend is the one being tested', () => {
  it('exists on disk beside the map', () => {
    /**
     * THE POINT OF THIS WHOLE TICKET. Without it `import:levels` skips the
     * directory and the campaign silently stays two missions long — no error,
     * no warning, just a level that is not there. Every case above runs the
     * importer against this file, so it is the shipped legend under test rather
     * than one written inline.
     */
    const legend = JSON.parse(readFileSync(join(SOURCE, 'legend.json'), 'utf8')) as {
      tileSize?: number
      markerColours?: Record<string, string>
    }
    expect(legend.tileSize).toBe(16)
    expect(legend.markerColours).toBeDefined()
  })
})

describe('and the campaign can actually reach it', () => {
  it('the shipped manifest lists three levels, in order', () => {
    /**
     * THE LAST LINK, AND IT IS NOT AUTOMATIC FROM THIS SUITE'S POINT OF VIEW.
     * Every case above imports level 3 into a temp directory; none of them
     * regenerates `public/generated/levels/`. `main.ts` fetches level documents
     * by name out of the manifest and `CampaignState.unlockedLevels` indexes
     * that array, so a level that imports perfectly and is missing from this
     * file is a level no player can ever be sent to.
     *
     * ORDER, NOT MEMBERSHIP: the runner turns a count into an index here, so a
     * manifest that listed level 3 second would send a player who beat level 1
     * to the wrong mission.
     */
    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, 'public/generated/levels/levels.manifest.json'),
        'utf8',
      ),
    ) as { levels: string[] }
    expect(manifest.levels).toEqual(['level1', 'level2', 'level3'])
  })

  it('and the document it points at is on disk and loadable', () => {
    // The manifest is a promise that each name can be fetched. A name with no
    // file behind it is a 404 at boot, on the mission the player just unlocked.
    const doc = JSON.parse(
      readFileSync(join(repoRoot, 'public/generated/levels/level3.json'), 'utf8'),
    )
    expect(loadLevel(doc).size).toEqual(EXPECTED.size)
  })
})
