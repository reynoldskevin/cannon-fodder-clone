import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { bakeNavGrid } from '../navgrid'
import { INFANTRY, VEHICLE } from '../traversal-mask'
import { loadLevel } from '../../level'
import { TERRAIN } from '../../level/terrain'

/**
 * Ticket 033 — level 2's bridge, on the level 2 that is actually shipped.
 *
 * EVERY OTHER TEST IN THIS TICKET RUNS ON A FIXTURE, and a fixture cannot catch
 * the failure that produced the ticket: the importer was correct about the
 * colours it was given and the ARTWORK said jungle. So this reads the committed
 * `level2.json` — the file the browser fetches — and asserts the crossing is
 * there.
 *
 * It is also the test that fails if `npm run import:levels` is not re-run. That
 * is deliberate. A declaration nobody imported is a legend entry with no effect
 * on the game, and ticket 024's manifest test learned the same lesson the hard
 * way: a contract test that never invokes the real pipeline is a fake.
 */

const LEVEL_2 = new URL('../../../../public/generated/levels/level2.json', import.meta.url).pathname

const level = loadLevel(JSON.parse(readFileSync(LEVEL_2, 'utf8')))

/** Every tile of a given terrain id, in raster order. */
const tilesOf = (id: number): { x: number; y: number }[] => {
  const found: { x: number; y: number }[] = []
  for (let y = 0; y < level.size.h; y += 1) {
    for (let x = 0; x < level.size.w; x += 1) {
      if (level.terrain[y]?.[x] === id) found.push({ x, y })
    }
  }
  return found
}

/**
 * Tiles reachable from `start` by a unit of `mask`, over the baked nav grid.
 *
 * Four-connected, matching how the flow field expands — a diagonal-connected
 * flood would call two tiles that touch only at a corner a crossing, which is
 * not a crossing anybody can walk.
 */
function reachable(start: { x: number; y: number }, mask: number): Set<number> {
  const grid = bakeNavGrid(level)
  const { w } = level.size
  const seen = new Set<number>()
  if (!grid.passable(start.x, start.y, mask)) return seen
  const queue = [start]
  seen.add(start.y * w + start.x)
  while (queue.length > 0) {
    const at = queue.pop()
    if (at === undefined) break
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = at.x + dx
      const ny = at.y + dy
      const key = ny * w + nx
      if (seen.has(key)) continue
      if (!grid.passable(nx, ny, mask)) continue
      seen.add(key)
      queue.push({ x: nx, y: ny })
    }
  }
  return seen
}

describe('the committed level 2 has a bridge', () => {
  it('emits bridge tiles at all, which is what says the import was re-run', () => {
    /**
     * The artist marked 26 tiles. Asserted as a floor rather than an exact
     * count: the deck's fringe tiles average between the deck colour and the
     * river, so which of them fall inside the legend's tolerance is a property
     * of the anti-aliasing, and pinning it exactly would make a re-export of the
     * artwork a test failure. Zero, though, means the declaration never ran.
     */
    expect(tilesOf(TERRAIN.BRIDGE).length).toBeGreaterThanOrEqual(20)
  })

  it('and every one of them is walkable', () => {
    const notWalkable = tilesOf(TERRAIN.BRIDGE).filter(
      (t) => level.walkable[t.y]?.[t.x] !== true,
    )
    expect(notWalkable).toEqual([])
  })

  it('in one connected run, not scattered specks', () => {
    // A bridge is a thing you cross. Twenty-six tiles spread over the map would
    // satisfy the count above and be no crossing at all.
    const deck = tilesOf(TERRAIN.BRIDGE)
    const { w } = level.size
    const all = new Set(deck.map((t) => t.y * w + t.x))
    const first = deck[0]
    expect(first).toBeDefined()
    const seen = new Set<number>([(first?.y ?? 0) * w + (first?.x ?? 0)])
    const queue = [first!]
    while (queue.length > 0) {
      const at = queue.pop()!
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const key = (at.y + dy) * w + (at.x + dx)
        if (!all.has(key) || seen.has(key)) continue
        seen.add(key)
        queue.push({ x: at.x + dx, y: at.y + dy })
      }
    }
    expect(seen.size).toBe(deck.length)
  })
})

describe('and it is the crossing, not merely decoration', () => {
  /**
   * The banks, taken from the deck itself rather than hardcoded: the tile a few
   * rows above the top of the deck and a few below the bottom of it, which is
   * the north and south bank of a river the deck runs across.
   */
  const deck = tilesOf(TERRAIN.BRIDGE)

  /** The column carrying the most deck, so the walk below runs along it rather than off its edge. */
  const column = (() => {
    const perColumn = new Map<number, number>()
    for (const t of deck) perColumn.set(t.x, (perColumn.get(t.x) ?? 0) + 1)
    let best = deck[0]?.x ?? 0
    let most = 0
    // Lower x wins a tie, so this never depends on Map iteration order.
    for (const x of [...perColumn.keys()].sort((a, b) => a - b)) {
      const count = perColumn.get(x) ?? 0
      if (count > most) {
        most = count
        best = x
      }
    }
    return best
  })()

  /**
   * Walk off the end of the deck until dry, walkable ground.
   *
   * NOT `minY - 2`, which is what this first said and which is a fixture sitting
   * on a convenient value: how far the deck's declared tiles run depends on
   * where the anti-aliased fringe falls inside the legend's tolerance, so a
   * fixed offset lands on canopy the day the artwork is re-exported. Walking
   * makes the test say what it means — "the bank on either side".
   */
  const bankFrom = (startY: number, step: number): { x: number; y: number } => {
    for (let y = startY; y >= 0 && y < level.size.h; y += step) {
      const id = level.terrain[y]?.[column]
      if (id === TERRAIN.BRIDGE || id === TERRAIN.WATER) continue
      if (level.walkable[y]?.[column] === true) return { x: column, y }
    }
    return { x: column, y: startY }
  }

  const onColumn = deck.filter((t) => t.x === column).map((t) => t.y)
  const northBank = bankFrom(Math.min(...onColumn) - 1, -1)
  const southBank = bankFrom(Math.max(...onColumn) + 1, 1)

  it('the fixture assumption holds: the banks are dry land on opposite sides', () => {
    // Without this the two assertions below could both pass on a pair of tiles
    // that happen to be the same puddle.
    for (const bank of [northBank, southBank]) {
      expect({ bank, terrain: level.terrain[bank.y]?.[bank.x] }).not.toEqual({
        bank,
        terrain: TERRAIN.WATER,
      })
      expect({ bank, walkable: level.walkable[bank.y]?.[bank.x] }).toEqual({ bank, walkable: true })
    }
  })

  it('a VEHICLE can cross it, and the river refuses one', () => {
    /**
     * THE ASSERTION THAT ONLY THE BRIDGE CAN SATISFY. Nothing in the game spawns
     * a vehicle, and that is what makes this the sharp test: water is
     * `INFANTRY`-only, so a vehicle's reachable set cannot contain a single
     * river tile. If the north bank reaches the south one under a `VEHICLE`
     * mask, it got there over dry land — and the only dry land across that river
     * is the deck.
     */
    const seen = reachable(northBank, VEHICLE)
    expect(seen.has(southBank.y * level.size.w + southBank.x)).toBe(true)

    const wetCrossings = [...seen].filter(
      (key) =>
        level.terrain[Math.floor(key / level.size.w)]?.[key % level.size.w] === TERRAIN.WATER,
    )
    expect(wetCrossings).toEqual([])
  })

  it('and infantry can still swim, so 003a is not undone', () => {
    // The bridge is a choice, not a replacement. A man may still wade.
    const seen = reachable(northBank, INFANTRY)
    expect(seen.has(southBank.y * level.size.w + southBank.x)).toBe(true)
    const wet = [...seen].some(
      (key) =>
        level.terrain[Math.floor(key / level.size.w)]?.[key % level.size.w] === TERRAIN.WATER,
    )
    expect(wet).toBe(true)
  })
})
