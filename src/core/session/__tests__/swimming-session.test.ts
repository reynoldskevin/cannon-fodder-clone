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

/** Where this entity stands, in fractional tiles. */
function tileOf(session: ReturnType<typeof createSession>, id: number): { x: number; y: number } {
  const e = session.world.get(id)
  if (e === undefined) throw new Error('no entity')
  return worldToTileFractional(e.x, e.z, session.world.level.size)
}

/**
 * One man on the west bank, ordered east across whatever is between, with an
 * UNARMED target waiting on the far side.
 *
 * NO ARMED ENEMY, AND THAT COST A PROBE TO FIND. The first fixture put a
 * rifleman on the far bank; he engaged across the river and killed our man
 * mid-crossing, so every case below was measuring a duel our man loses rather
 * than a swim. The target is a kind `WEAPON_BY_KIND` has never heard of — it
 * can be shot and killed and never fires back — spawned in after the session so
 * the level itself carries no enemy at all.
 */
function crossing(level: LevelData, seed = 1) {
  const session = createSession(level, { seed })
  const me = session.world.entities.filter((e) => e.team === 'player')[0]
  if (me === undefined) throw new Error('fixture did not spawn')
  const at = tileToWorld(17, 7, session.world.level.size)
  const target = session.world.spawn({ kind: 'sandbag', team: 'enemy', x: at.x, z: at.z })
  session.queue.push({ type: 'move', unitIds: [me.id], target: { x: 17, y: 7 } })
  return { session, me, target }
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
      const at = tileOf(session, me.id)
      const wet = session.world.level.terrain[Math.floor(at.y)]?.[Math.floor(at.x)] === TERRAIN.WATER
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
      const at = tileOf(session, me.id)
      if (session.world.level.terrain[Math.floor(at.y)]?.[Math.floor(at.x)] === TERRAIN.WATER) {
        wetTicks += 1
      }
    }
    expect(wetTicks).toBeGreaterThan(10)
  })
})

describe('and on the far bank he is a soldier again', () => {
  it('a man who has crossed can kill', () => {
    const { session, me, target: enemy } = crossing(RIVER())
    for (let f = 0; f < 1200; f += 1) {
      session.queue.push({
        type: 'fire',
        unitIds: [me.id],
        ordnance: RIFLE_ORDNANCE,
        target: { x: 17, y: 7 },
      })
      session.advance(1 / 60)
      if (!session.world.isAlive(enemy.id)) break
      if (!session.world.isAlive(me.id)) break
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
