import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'
import { TERRAIN } from '../../level'
import { tileToWorld } from '../../view/projection'
import type { LevelData } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 042 — a man who cannot fire is not drawn firing.
 *
 * The water gate has worked since ticket 007b and ticket 041 drew the man 70%
 * under. What neither did was tell the ANIMATION. `animationFor` asks
 * `combat.isFiring`, which answers "does he HOLD a standing order" — a question
 * that coincided with "is he shooting" everywhere until the river separated
 * them. So a soldier wading with the button held emitted no round, no tracer,
 * no muzzle flash and no sound, and played the fire clip the whole way across.
 *
 * MEASURED ON THE SHIPPED `level2.json` BEFORE ANY CODE, not on this fixture:
 * avatar on tile {x:10,y:29}, standing order four columns east, 120 ticks —
 * `shots: 0`, `isFiring: true`, `submersion: 0.7`, `animation: 'fire'`.
 *
 * THE SIMULATION IS NOT WHAT THIS SUITE GUARDS. Every "fires nothing" claim
 * below is a CONTROL restating what `no-fire-from-water.test.ts` already pins;
 * it is here so a fix that bought the animation by breaking the gate cannot
 * pass. The subject is the picture.
 */

/** `makeLevel`, with columns `from`..`to` flooded across the full height. */
function flooded(from: number, to: number, options: Parameters<typeof makeLevel>[0] = {}): LevelData {
  const base = makeLevel(options)
  const terrain = base.terrain.map((row, y) =>
    row.map((id, x) => (x >= from && x < to && base.walkable[y]?.[x] === true ? TERRAIN.WATER : id)),
  )
  return { ...base, terrain }
}

/** The same, with one column of the river decked over (ticket 033). */
function bridged(from: number, to: number, deckX: number): LevelData {
  const base = flooded(from, to, { avatars: [{ x: 3, y: 7 }], enemies: [] })
  const terrain = base.terrain.map((row, y) =>
    row.map((id, x) => (x === deckX && base.walkable[y]?.[x] === true ? TERRAIN.BRIDGE : id)),
  )
  return { ...base, terrain }
}

/** Columns 8..11 are river; 3 and 15 are dry bank. */
const WET = 9
const DRY = 3
const RIVER_FROM = 8
const RIVER_TO = 12

/**
 * One avatar, a standing fire order aimed across the river, and him held at
 * `standAt` for the whole run.
 *
 * HE IS PINNED IN PLACE EVERY FRAME rather than walked there. The subject is
 * the animation on a man standing on a given terrain id, and letting the squad
 * system carry him would make every assertion depend on pathing speed as well —
 * which is how the 007b suite's first draft moved a man from one water tile to
 * another and then asserted he fired.
 */
function wadingWithTheButtonHeld(standAt: { x: number; y: number }, level: LevelData) {
  const s = createSession(level)
  const id = s.selection()[0]!
  const p = tileToWorld(standAt.x, standAt.y, level.size)
  const put = (): void => {
    const man = s.world.get(id)
    if (man === undefined) throw new Error('lost the avatar')
    man.x = p.x
    man.z = p.z
  }
  put()
  s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: standAt.x + 5, y: standAt.y } })
  const shots: SimEvent[] = []
  const run = (frames: number): void => {
    for (let f = 0; f < frames; f += 1) {
      s.advance(1 / 60)
      put()
      for (const e of s.events()) if (e.type === 'ShotFired' && e.shooterId === id) shots.push(e)
    }
  }
  const drawn = () => {
    const r = s.renderEntities(FLAT).find((e) => e.id === id)
    if (r === undefined) throw new Error('not drawn')
    return r
  }
  return { s, id, run, drawn, shots }
}

const RIVER_LEVEL = () => flooded(RIVER_FROM, RIVER_TO, { avatars: [{ x: 3, y: 7 }], enemies: [] })

describe('a man standing in the river with the fire button held', () => {
  it('is NOT drawn playing the fire animation', () => {
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.drawn().animation).not.toBe('fire')
  })

  it('is drawn idle, because he is standing still', () => {
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.drawn().animation).toBe('idle')
  })

  it('and he really is submerged, or the fixture proves nothing', () => {
    // THE FIXTURE'S OWN CONTROL. A level whose "river" was not water would
    // satisfy every assertion above by accident.
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(1)
    expect(r.drawn().submersion).toBeGreaterThan(0)
  })

  it('and still fires nothing at all — the gate is untouched', () => {
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.shots).toEqual([])
  })

  it('still HOLDS the order, so he resumes at the bank', () => {
    // `isFiring` is a truthful answer to its own question and must not be
    // narrowed to buy the animation: ticket 007b keeps the order across the
    // crossing on purpose.
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.s.combat.isFiring(r.id)).toBe(true)
  })

  it('still turns to face the point he is trying to shoot at', () => {
    // He is aiming and unable to fire. A man who did not even look that way
    // would read as having no order at all.
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, RIVER_LEVEL())
    r.run(120)
    const d = r.drawn()
    expect(d.dx).toBeGreaterThan(0)
  })
})

describe('and the controls that make the case above mean something', () => {
  it('the same man on the dry bank IS drawn firing', () => {
    /**
     * WITHOUT THIS THE SUITE PROVES NOTHING. A fix that returned `idle` for
     * every man under every order — or a fixture where the order never took —
     * passes every assertion above perfectly.
     */
    const r = wadingWithTheButtonHeld({ x: DRY, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.drawn().animation).toBe('fire')
  })

  it('and on the dry bank he really does fire', () => {
    const r = wadingWithTheButtonHeld({ x: DRY, y: 7 }, RIVER_LEVEL())
    r.run(120)
    expect(r.shots.length).toBeGreaterThan(0)
  })

  it('a man on the BRIDGE over the same river is drawn firing', () => {
    // The deck is dry, and that is the whole point of the deck (ticket 033).
    // A fix keyed on "is there water at this column" rather than on the tile the
    // man is standing ON would disarm the bridge and undo tickets 033 and 035.
    const level = bridged(RIVER_FROM, RIVER_TO, WET)
    const r = wadingWithTheButtonHeld({ x: WET, y: 7 }, level)
    r.run(120)
    expect(r.drawn().submersion).toBe(0)
    expect(r.drawn().animation).toBe('fire')
  })
})

describe('the recency window does not smuggle the clip in', () => {
  it('a man who fired on the bank is not drawn firing once he is in the water', () => {
    /**
     * `firingTicksAgo` holds the fire clip up for a few ticks after a REAL shot,
     * so a man who fires on the bank and steps into the river would flash the
     * tail of it while chest-deep. Both arms of `animationFor` have to answer to
     * the terrain, not just the one.
     *
     * He is moved by hand on the frame after a confirmed shot, so this measures
     * the animation and not the squad system.
     */
    const level = RIVER_LEVEL()
    const s = createSession(level)
    const id = s.selection()[0]!
    const bank = tileToWorld(DRY, 7, level.size)
    const river = tileToWorld(WET, 7, level.size)
    const man = () => {
      const m = s.world.get(id)
      if (m === undefined) throw new Error('lost him')
      return m
    }
    man().x = bank.x
    man().z = bank.z
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: DRY + 5, y: 7 } })

    let fired = false
    for (let f = 0; f < 200 && !fired; f += 1) {
      s.advance(1 / 60)
      man().x = bank.x
      man().z = bank.z
      fired = s.events().some((e) => e.type === 'ShotFired' && e.shooterId === id)
    }
    expect(fired).toBe(true)
    // He is drawn firing on the bank, which is the precondition this case needs.
    expect(s.renderEntities(FLAT).find((e) => e.id === id)!.animation).toBe('fire')

    // Into the river, on the very next frame, while the window is still open.
    man().x = river.x
    man().z = river.z
    const drawn = s.renderEntities(FLAT).find((e) => e.id === id)!
    expect(drawn.submersion).toBeGreaterThan(0)
    expect(drawn.animation).not.toBe('fire')
  })
})
