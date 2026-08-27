import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'
import { TERRAIN } from '../../level'
import { tileToWorld } from '../../view/projection'
import type { LevelData } from '../../level/types'

/**
 * Ticket 044 — `RenderEntity.firing` is the one fact behind the picture and the
 * sound.
 *
 * The fire animation and the sustained gunfire voice both read this flag. They
 * are deliberately NOT two functions that happen to agree: ticket 042 shipped
 * exactly that split — a wading man played the fire clip while the water gate
 * refused every round — and 025 and 041 each shipped a version of it before
 * that.
 *
 * So every case here asserts the flag AND the animation together. A fix that
 * moved one without the other is the defect this file exists to catch.
 */

function flooded(from: number, to: number, options: Parameters<typeof makeLevel>[0] = {}): LevelData {
  const base = makeLevel(options)
  const terrain = base.terrain.map((row, y) =>
    row.map((id, x) => (x >= from && x < to && base.walkable[y]?.[x] === true ? TERRAIN.WATER : id)),
  )
  return { ...base, terrain }
}

const DRY = 3
const WET = 9

/** One avatar, held at `standAt`, with a standing fire order across the map. */
function holdingTheTrigger(standAt: { x: number; y: number }, level: LevelData) {
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
  s.queue.push({
    type: 'fire',
    unitIds: [id],
    ordnance: 'rifle',
    target: { x: standAt.x + 5, y: standAt.y },
  })
  return {
    s,
    id,
    run(frames: number): void {
      for (let f = 0; f < frames; f += 1) {
        s.advance(1 / 60)
        put()
        s.events()
      }
    },
    drawn() {
      const r = s.renderEntities(FLAT).find((e) => e.id === id)
      if (r === undefined) throw new Error('not drawn')
      return r
    },
  }
}

const RIVER = () => flooded(8, 12, { avatars: [{ x: 3, y: 7 }], enemies: [] })

describe('a man with the trigger held on dry ground', () => {
  it('reports firing', () => {
    const r = holdingTheTrigger({ x: DRY, y: 7 }, RIVER())
    r.run(120)
    expect(r.drawn().firing).toBe(true)
  })

  it('and is drawn firing, which is the same fact', () => {
    const r = holdingTheTrigger({ x: DRY, y: 7 }, RIVER())
    r.run(120)
    expect(r.drawn().animation).toBe('fire')
  })
})

describe('and when the trigger is released', () => {
  it('he stops reporting firing', () => {
    /**
     * THE BUG THE TICKET IS NAMED FOR, at the source. The sound used to run to
     * the end of a 1.5-second buffer after release because it was started by an
     * event; it is now gated on this flag, so this going false IS the sound
     * stopping.
     */
    const r = holdingTheTrigger({ x: DRY, y: 7 }, RIVER())
    r.run(120)
    expect(r.drawn().firing).toBe(true)
    r.s.queue.push({ type: 'ceaseFire', unitIds: [r.id] })
    // Long enough to outrun the post-shot window as well as the order.
    r.run(60)
    expect(r.drawn().firing).toBe(false)
  })

  it('and stops being drawn firing at the same moment', () => {
    const r = holdingTheTrigger({ x: DRY, y: 7 }, RIVER())
    r.run(120)
    r.s.queue.push({ type: 'ceaseFire', unitIds: [r.id] })
    r.run(60)
    expect(r.drawn().animation).not.toBe('fire')
  })
})

describe('a man in the river is neither heard nor seen firing', () => {
  it('reports NOT firing, though he still holds the order', () => {
    // Ticket 042's rule, now covering the sound. `isFiring` stays true — 007b
    // keeps the order across a crossing on purpose — and this is what says he
    // is not actually shooting.
    const r = holdingTheTrigger({ x: WET, y: 7 }, RIVER())
    r.run(120)
    expect(r.s.combat.isFiring(r.id)).toBe(true)
    expect(r.drawn().firing).toBe(false)
  })

  it('and the animation agrees with the flag', () => {
    const r = holdingTheTrigger({ x: WET, y: 7 }, RIVER())
    r.run(120)
    const drawn = r.drawn()
    expect({ firing: drawn.firing, fire: drawn.animation === 'fire' }).toEqual({
      firing: false,
      fire: false,
    })
  })

  it('and he really is in the water, or the fixture proves nothing', () => {
    const r = holdingTheTrigger({ x: WET, y: 7 }, RIVER())
    r.run(1)
    expect(r.drawn().submersion).toBeGreaterThan(0)
  })
})

describe('a man doing nothing', () => {
  it('does not report firing', () => {
    // The control that stops `firing: true` for everybody passing this suite.
    const s = createSession(makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [] }))
    s.advance(1 / 60)
    expect(s.renderEntities(FLAT)[0]!.firing).toBe(false)
  })
})

describe('a man shooting without holding an order', () => {
  it('still reports firing, off the post-shot window', () => {
    /**
     * THE ARM THAT IS EASY TO DROP, AND IT IS REACHABLE — MEASURED, NOT ASSUMED.
     *
     * A first draft of this case asserted only "an enemy reports firing" and
     * explained it with "nobody issues an enemy a fire order". That explanation
     * was FALSE: `ai/system.ts:1216` calls `combat.orderFire`, so an engaging
     * enemy usually does hold one — and the case passed with the post-shot arm
     * deleted, proving nothing.
     *
     * The real path is `autoEngageTeams`, which `createSession` defaults to
     * `['enemy']`: combat fires an enemy in range whether or not the AI has got
     * round to ordering him, and the AI holds fire for a 45-tick beat after
     * entering engage (ticket 012a). So there is a real window in every
     * firefight where a man is shooting with an EMPTY order slot. A probe over
     * this exact fixture found one at frame 98.
     *
     * Built on the standing order alone, `firing` would leave him silent and
     * still while he shot, and the player's squad would be the only audible
     * thing in the mission.
     */
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 11, y: 7 }] })
    const s = createSession(level)
    let sawFiringWithoutOrder = false
    for (let f = 0; f < 400 && !sawFiringWithoutOrder; f += 1) {
      s.advance(1 / 60)
      s.events()
      sawFiringWithoutOrder = s
        .renderEntities(FLAT)
        .some((e) => e.firing === true && !s.combat.isFiring(e.id))
    }
    expect(sawFiringWithoutOrder).toBe(true)
  })
})
