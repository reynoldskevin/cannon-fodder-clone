import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { TERRAIN } from '../../level'
import { RIFLE_ORDNANCE } from '../../armoury'
import { tileToWorld } from '../../view/projection'
// BORROWED FROM THE SQUAD FIXTURE rather than rewritten. Fractional world->tile
// is THE conversion this project has paid for twice — `floor(worldX + w/2)` is
// right and `floor(worldX + (w-1)/2)` is wrong, and at a tile centre both floor
// to the same tile, so a second copy would look correct in every test that put a
// man on a centre. One spelling, shared.
import { worldToTileFractional } from '../../squad/__tests__/fixture'
import type { LevelData } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 007b — the crossing, through the whole game.
 *
 * The unit suites pin the two rules against a squad system and a combat system
 * driven directly. This asks the question neither can: does a man ordered
 * across a river in a real mission actually swim slowly and silently, and fight
 * normally once he is out?
 *
 * IT MATTERS THAT THIS IS A `Session`. The speed multiplier and the fire gate
 * are read by two different systems on two different passes of the same tick,
 * and a change that worked when each was driven alone but not when they ran in
 * `systemOrder` together would be invisible to both other files.
 */

/** `makeLevel`, with columns `from`..`to` flooded across the full height. */
function flooded(from: number, to: number, options: Parameters<typeof makeLevel>[0] = {}): LevelData {
  const base = makeLevel(options)
  const terrain = base.terrain.map((row, y) =>
    row.map((id, x) => (x >= from && x < to && base.walkable[y]?.[x] === true ? TERRAIN.WATER : id)),
  )
  return { ...base, terrain }
}

/** Where this entity stands, in fractional tiles. For measuring DISTANCE. */
function tileOf(session: ReturnType<typeof createSession>, id: number): { x: number; y: number } {
  const e = session.world.get(id)
  if (e === undefined) throw new Error('no entity')
  return worldToTileFractional(e.x, e.z, session.world.level.size)
}

/**
 * The terrain id of the tile this entity is STANDING IN.
 *
 * NOT `floor(worldToTileFractional(...))`, AND THE DIFFERENCE IS HALF A TILE.
 * The two conversions in this codebase answer different questions:
 *
 *   - `worldToTileFractional` is `wx + (w - 1) / 2` — CENTRE-indexed, so an
 *     integer names a tile's middle and 11.52 means "just past the centre of
 *     tile 11". It is the right tool for measuring a distance in tiles.
 *   - `worldToTileAxis`, which combat uses, is `wx + w / 2` — CORNER-indexed,
 *     and its floor is the tile that CONTAINS the point.
 *
 * A first draft of this file flooring the fractional one reported a man at world
 * x 2.02 as standing in tile 11 (water) when combat had him in tile 12 (dry),
 * and duly accused the fire gate of leaking one shot. AT A TILE CENTRE THE TWO
 * FLOOR IDENTICALLY, which is why only an off-centre man — one mid-stride, which
 * is every man who is walking — can tell them apart. This is the same convention
 * that has cost this project two review cycles in `worldToTile`.
 */
function terrainUnder(session: ReturnType<typeof createSession>, id: number): number | undefined {
  const e = session.world.get(id)
  if (e === undefined) return undefined
  const { w, h } = session.world.level.size
  return session.world.level.terrain[Math.floor(e.z + h / 2)]?.[Math.floor(e.x + w / 2)]
}

/** Is he in the river right now, by the same reckoning combat uses? */
const inWater = (session: ReturnType<typeof createSession>, id: number): boolean =>
  terrainUnder(session, id) === TERRAIN.WATER

/**
 * One man on the west bank, ordered east across whatever is between. NOBODY
 * ELSE IN THE WORLD.
 *
 * NO TARGET, AND THAT COST TWO PROBES TO SETTLE. The first fixture put an armed
 * rifleman on the far bank; he engaged across the river and killed our man
 * mid-crossing, so the cases were measuring a duel he loses. Replacing him with
 * an unarmed one did not help: anything on the enemy team is commanded by the
 * AI, which sees our man at twelve tiles and marches WEST to meet him — into the
 * water, where the squad system's separation push exactly cancels his seek and
 * the pair lock at a fixed point mid-stream from frame ~300 onward. Measured at
 * x 9.7 against 10.2, both on terrain 4, unchanged through frame 1800 and
 * identical at a multiplier of 0.99, so it was not a tuning problem.
 *
 * The crossing is therefore tested with an empty map, and the one case that
 * needs something to shoot spawns it AFTER he is out of the river.
 */
function crossing(level: LevelData, seed = 1) {
  const session = createSession(level, { seed })
  const me = session.world.entities.filter((e) => e.team === 'player')[0]
  if (me === undefined) throw new Error('fixture did not spawn')
  session.queue.push({ type: 'move', unitIds: [me.id], target: { x: 17, y: 7 } })
  return { session, me }
}

/** The level 2 shape in miniature: one man west, a river between him and the far bank. */
const RIVER = (): LevelData => flooded(7, 12, { avatars: [{ x: 2, y: 7 }], enemies: [] })
const DRY = (): LevelData => makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })

describe('crossing a river in a real mission', () => {
  it('takes longer than crossing the same ground dry', () => {
    /**
     * Measured as ground covered in a fixed number of frames, so neither man is
     * measured arriving. The enemy is far enough east that neither is engaged
     * during the stretch being timed.
     */
    const wet = crossing(RIVER())
    const dry = crossing(DRY())
    for (let f = 0; f < 180; f += 1) {
      wet.session.advance(1 / 60)
      dry.session.advance(1 / 60)
    }
    expect(tileOf(wet.session, wet.me.id).x).toBeLessThan(tileOf(dry.session, dry.me.id).x)
  })

  it('and he is silent while he is in it', () => {
    /**
     * Ordered to fire at the enemy on the far bank the whole way across. While
     * he is in the water there must be no `ShotFired` from him at all — no
     * tracer, no report, nothing for the garrison to hear.
     */
    const { session, me } = crossing(RIVER())
    const shots: SimEvent[] = []
    let firedWhileWet = 0
    for (let f = 0; f < 600; f += 1) {
      session.queue.push({
        type: 'fire',
        unitIds: [me.id],
        ordnance: RIFLE_ORDNANCE,
        target: { x: 17, y: 7 },
      })
      session.advance(1 / 60)
      const wet = inWater(session, me.id)
      for (const e of session.events()) {
        if (e.type !== 'ShotFired' || e.shooterId !== me.id) continue
        shots.push(e)
        if (wet) firedWhileWet += 1
      }
      if (!session.world.isAlive(me.id)) break
    }
    expect(firedWhileWet).toBe(0)
    // And he DID fire at some point, or "silent while wet" is satisfied by a man
    // who never fired at all — which is the control this claim needs.
    expect(shots.length).toBeGreaterThan(0)
  })

  it('and he was genuinely in the water at some point, not merely near it', () => {
    // The other precondition. A man who never entered the river would satisfy
    // "fired nothing while wet" without the rule existing.
    const { session, me } = crossing(RIVER())
    let wetTicks = 0
    for (let f = 0; f < 600; f += 1) {
      session.advance(1 / 60)
      if (inWater(session, me.id)) wetTicks += 1
    }
    expect(wetTicks).toBeGreaterThan(10)
  })
})

describe('and on the far bank he is a soldier again', () => {
  it('a man who has crossed can kill', () => {
    /**
     * The target appears only once he is OUT of the river, so the AI never has
     * the chance to walk it in after him — see the note on `crossing`.
     *
     * That is not a dodge: the claim is about a man who has finished swimming,
     * and everything before that moment is already covered by the three cases
     * above. What this adds is that the fire gate LIFTS — through the real
     * session, with the squad system and combat running in `systemOrder` on the
     * same tick.
     */
    const { session, me } = crossing(RIVER())
    let guard = 0
    while (guard < 2000) {
      session.advance(1 / 60)
      if (!inWater(session, me.id) && tileOf(session, me.id).x > 12) break
      guard += 1
    }
    expect(tileOf(session, me.id).x).toBeGreaterThan(12)
    expect(inWater(session, me.id)).toBe(false)

    const at = tileToWorld(17, 7, session.world.level.size)
    const enemy = session.world.spawn({ kind: 'sandbag', team: 'enemy', x: at.x, z: at.z })
    for (let f = 0; f < 600; f += 1) {
      session.queue.push({
        type: 'fire',
        unitIds: [me.id],
        ordnance: RIFLE_ORDNANCE,
        target: { x: 17, y: 7 },
      })
      session.advance(1 / 60)
      if (!session.world.isAlive(enemy.id)) break
    }
    expect(session.world.isAlive(enemy.id)).toBe(false)
  })
})

describe('a crossing still replays exactly', () => {
  it('the same seed twice is the same mission', () => {
    // Both rules are table lookups — no rng, no clock — so ticket 005's
    // guarantee is untouched.
    const run = (): string => {
      const { session } = crossing(RIVER(), 12)
      for (let f = 0; f < 600; f += 1) session.advance(1 / 60)
      return String(session.world.stateHash())
    }
    expect(run()).toBe(run())
  })
})
