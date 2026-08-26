import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { RIFLE_ORDNANCE } from '../../armoury'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 016 — ordnance in the player's hands.
 *
 * THE RIFLE MUST COME THROUGH THIS UNCHANGED. It is a STANDING order — right
 * click down orders fire, right click up cancels it, and it never runs out —
 * and it is the whole of the game's offensive vocabulary today. Ordnance is a
 * SINGLE round per press, rate-limited by its own cooldown and paid for out of
 * a finite pouch. Those are two different verbs down two different paths, and
 * the routing between them is what this ticket adds.
 *
 * The failure being guarded against is a `fire` case that got cleverer and took
 * the rifle down the ordnance path with it: a squad that can no longer suppress,
 * because its ammunition ran out after four shots.
 */

const alone = () => makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [] })

/** Runs `frames` at the fixed step, collecting every event. */
function play(s: ReturnType<typeof createSession>, frames: number): SimEvent[] {
  const seen: SimEvent[] = []
  for (let f = 0; f < frames; f += 1) {
    s.advance(1 / 60)
    seen.push(...s.events())
  }
  return seen
}

describe('the rifle is untouched', () => {
  it('is what the squad starts holding', () => {
    expect(createSession(alone()).armoury.selected).toBe(RIFLE_ORDNANCE)
  })

  it('still fires as a standing order, round after round', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    const shots = play(s, 240).filter((e) => e.type === 'ShotFired')
    expect(shots.length).toBeGreaterThan(3)
  })

  it('is still cleared by ceaseFire', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    play(s, 60)
    s.queue.push({ type: 'ceaseFire', unitIds: [id] })
    play(s, 5)
    const after = play(s, 180).filter((e) => e.type === 'ShotFired')
    expect(after).toHaveLength(0)
  })

  it('never runs out, however long the trigger is held', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    const events = play(s, 600)
    expect(events.filter((e) => e.type === 'FireRejected')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'ShotFired').length).toBeGreaterThan(10)
  })

  it('spends not one round of anything, however long it fires', () => {
    /**
     * THE ACCEPTANCE CRITERION, ACTUALLY ASSERTED. Every other rifle case here
     * counts `ShotFired`, `Explosion` and `FireRejected` — and a rifle branch
     * that quietly called `consume('grenade')` on every order would leave all
     * three counts untouched and the whole suite green. Adversarial review made
     * exactly that change and nothing failed.
     *
     * A squad that suppresses for ten seconds and finds its grenades gone is a
     * bug the player would experience as the pouch leaking.
     */
    const s = createSession(alone())
    const id = s.selection()[0]!
    const before = { grenade: s.armoury.count('grenade'), rocket: s.armoury.count('rocket') }
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    play(s, 600)
    expect({ grenade: s.armoury.count('grenade'), rocket: s.armoury.count('rocket') }).toEqual(
      before,
    )
  })

  it('reports itself as unlimited rather than as empty', () => {
    // `count` is the documented way to ask, and answering 0 for the rifle would
    // make any caller that checks before firing refuse the one weapon that can
    // never run out.
    expect(createSession(alone()).armoury.count(RIFLE_ORDNANCE)).toBe(Number.POSITIVE_INFINITY)
  })

  it('throws no ordnance while it is what is selected', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    expect(play(s, 120).filter((e) => e.type === 'Explosion')).toHaveLength(0)
  })
})

describe('a grenade is a single round, and it reaches the world', () => {
  it('leaves the hand and explodes', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    expect(play(s, 300).filter((e) => e.type === 'Explosion')).toHaveLength(1)
  })

  it('explodes where it was aimed', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    const boom = play(s, 300).find((e) => e.type === 'Explosion')
    if (boom?.type !== 'Explosion') throw new Error('no explosion')
    expect({ ordnance: boom.ordnance, source: boom.sourceId }).toEqual({
      ordnance: 'grenade',
      source: id,
    })
  })

  it('kills what it lands on', () => {
    const level = makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [{ x: 14, y: 14 }] })
    const s = createSession(level)
    const id = s.selection()[0]!
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 14, y: 14 } })
    play(s, 400)
    expect(s.world.isAlive(enemy)).toBe(false)
  })

  it('spends exactly one round from the pouch', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    const before = s.armoury.count('grenade')
    expect(before).toBeGreaterThan(0)
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    play(s, 10)
    expect(s.armoury.count('grenade')).toBe(before - 1)
  })

  it('a held trigger does not empty the pouch in one frame', () => {
    /**
     * The failure that makes finite ammo unplayable. A `fire` command arrives
     * every frame the button is down — that is how ticket 011a's standing order
     * works — so if each one spent a grenade, a single press would cost the
     * whole squad's supply before the player let go.
     *
     * The ordnance cooldown from ticket 015 is what bounds it.
     *
     * ORDERED WITH THE WHOLE SQUAD, WHICH IS WHAT A CLICK ACTUALLY SENDS. The
     * first version of this case named a single man, and so could not see the
     * bug it was written for: an implementation that walked the selection until
     * it found somebody off cooldown empties a five-man squad's supply in five
     * frames of one press, and with one man named there is nobody to walk to.
     * Adversarial review made that change and this test stayed green.
     */
    const level = makeLevel({
      avatars: [
        { x: 4, y: 7 },
        { x: 5, y: 7 },
        { x: 6, y: 7 },
        { x: 4, y: 8 },
        { x: 5, y: 8 },
      ],
      enemies: [],
    })
    const s = createSession(level)
    const squad = [...s.selection()]
    expect(squad.length).toBe(5)
    const before = s.armoury.count('grenade')
    for (let f = 0; f < 30; f += 1) {
      s.queue.push({ type: 'fire', unitIds: squad, ordnance: 'grenade', target: { x: 12, y: 7 } })
      s.advance(1 / 60)
    }
    expect(s.armoury.count('grenade')).toBe(before - 1)
  })

  it('and reports no rejection while the weapon is merely reloading', () => {
    // A cooldown refusal happens sixty times a second while the button is held
    // and the weapon is working exactly as designed. On the bus that is noise,
    // and it would train the HUD to cry empty at a full pouch.
    const s = createSession(alone())
    const id = s.selection()[0]!
    const events: SimEvent[] = []
    for (let f = 0; f < 60; f += 1) {
      s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
      s.advance(1 / 60)
      events.push(...s.events())
    }
    expect(events.filter((e) => e.type === 'FireRejected')).toHaveLength(0)
  })

  it('does not put the man on a standing order he then has to cancel', () => {
    // Ordnance is a press, not a latch. One command, one grenade, and no
    // `ceaseFire` needed — a latched grenade would keep throwing until the
    // pouch was empty.
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    play(s, 5)
    expect(s.combat.isFiring(id)).toBe(false)
  })
})

describe('running out is reported, not swallowed', () => {
  it('refuses to throw what the squad does not have', () => {
    const s = createSession(alone(), { ammo: { grenade: 1 } })
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    play(s, 200)
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    const after = play(s, 200)
    expect(after.filter((e) => e.type === 'Explosion')).toHaveLength(0)
  })

  it('says so, so the HUD and audio can tell the player', () => {
    /**
     * SILENCE IS THE BUG. Ticket 011a's design note put it exactly: "a
     * right-click that produces silence reads as a broken control". An empty
     * pouch has to be distinguishable from a dead button, and the only channel
     * from sim to presentation is the event bus.
     */
    const s = createSession(alone(), { ammo: { grenade: 0 } })
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
    const rejected = play(s, 10).find((e) => e.type === 'FireRejected')
    if (rejected?.type !== 'FireRejected') throw new Error('no rejection reported')
    expect(rejected.ordnance).toBe('grenade')
    expect(rejected.reason.length).toBeGreaterThan(0)
  })

  it('an empty pouch does not stop the rifle working', () => {
    // The regression that would make this ticket a net loss.
    const s = createSession(alone(), { ammo: { grenade: 0, rocket: 0 } })
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: RIFLE_ORDNANCE, target: { x: 12, y: 7 } })
    expect(play(s, 240).filter((e) => e.type === 'ShotFired').length).toBeGreaterThan(3)
  })
})

describe('selection', () => {
  it('a selectOrdnance command changes what is held', () => {
    const s = createSession(alone())
    s.queue.push({ type: 'selectOrdnance', ordnance: 'rocket' })
    s.advance(1 / 60)
    expect(s.armoury.selected).toBe('rocket')
  })

  it('a selectOrdnance naming nothing real leaves the selection alone', () => {
    const s = createSession(alone())
    s.queue.push({ type: 'selectOrdnance', ordnance: 'howitzer' })
    s.advance(1 / 60)
    expect(s.armoury.selected).toBe(RIFLE_ORDNANCE)
  })

  it('a rocket flies flat where a grenade arcs', () => {
    // The two rows differ in `arc`, and this is the session-level proof that the
    // difference survives the whole path from command to detonation. A wall
    // between the thrower and the target is cleared by one and not the other.
    const blocked = new Set<string>()
    for (let y = 0; y < 15; y += 1) blocked.add(`8,${y}`)
    const level = makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [], blocked })

    const grenade = createSession(level)
    const gid = grenade.selection()[0]!
    grenade.queue.push({ type: 'fire', unitIds: [gid], ordnance: 'grenade', target: { x: 13, y: 7 } })
    const gBoom = play(grenade, 400).find((e) => e.type === 'Explosion')

    const rocket = createSession(level)
    const rid = rocket.selection()[0]!
    rocket.queue.push({ type: 'fire', unitIds: [rid], ordnance: 'rocket', target: { x: 13, y: 7 } })
    const rBoom = play(rocket, 400).find((e) => e.type === 'Explosion')

    if (gBoom?.type !== 'Explosion' || rBoom?.type !== 'Explosion') {
      throw new Error('both weapons must go off')
    }
    // The grenade arcs over the wall and lands beyond it; the rocket stops short.
    expect(gBoom.x).toBeGreaterThan(rBoom.x)
  })
})

describe('determinism survives it', () => {
  it('two identical missions with ordnance thrown are identical', () => {
    const mission = () => {
      const s = createSession(alone(), { seed: 5 })
      const id = s.selection()[0]!
      s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target: { x: 10, y: 7 } })
      const events = play(s, 400)
      return JSON.stringify({ events, hash: s.world.stateHash() })
    }
    expect(mission()).toBe(mission())
  })

  it('the ordnance system runs in a declared place in the order', () => {
    // `systemOrder` is the documented contract for when each system sees the
    // world. A new system that did not appear in it would be invisible to every
    // test that reasons about ordering.
    expect(createSession(alone()).systemOrder).toContain('ordnance')
  })
})
