import { describe, it, expect } from 'vitest'
import { createArmoury, RIFLE_ORDNANCE } from '../index'

/**
 * Ticket 016 — the squad's ammunition.
 *
 * ONE POUCH FOR THE WHOLE SQUAD, not one per man. A per-soldier inventory would
 * mean the player has to know which of five men is carrying the last rocket
 * before he right-clicks, and then select that man — which is bookkeeping the
 * original never asked for and which the pointer has no way to express.
 *
 * THE RIFLE IS NOT AMMUNITION. It is unlimited, it is the whole of the game's
 * offensive vocabulary today, and it goes down a different path entirely
 * (`CombatSystem.orderFire`, a standing order). Keeping it in this list as an
 * unlimited entry is what lets the selector cycle back to it; keeping it out of
 * the counting is what stops this ticket from being able to break it.
 */

describe('counts', () => {
  it('starts with what it was given', () => {
    const a = createArmoury({ starting: { grenade: 4, rocket: 2 } })
    expect({ g: a.count('grenade'), r: a.count('rocket') }).toEqual({ g: 4, r: 2 })
  })

  it('reports zero for ordnance it was never given', () => {
    expect(createArmoury({ starting: {} }).count('grenade')).toBe(0)
  })

  it('reports zero for a name nothing has ever heard of', () => {
    expect(createArmoury({ starting: { grenade: 1 } }).count('howitzer')).toBe(0)
  })

  it('spends a round when one is used', () => {
    const a = createArmoury({ starting: { grenade: 4 } })
    expect(a.consume('grenade')).toBe(true)
    expect(a.count('grenade')).toBe(3)
  })

  it('refuses to spend what it does not have', () => {
    // The whole point of finite ammo: the refusal has to be reportable, because
    // a throw that silently does nothing reads as a broken button.
    const a = createArmoury({ starting: { grenade: 1 } })
    expect(a.consume('grenade')).toBe(true)
    expect(a.consume('grenade')).toBe(false)
    expect(a.count('grenade')).toBe(0)
  })

  it('never goes negative, however hard it is pressed', () => {
    const a = createArmoury({ starting: { grenade: 1 } })
    for (let i = 0; i < 10; i += 1) a.consume('grenade')
    expect(a.count('grenade')).toBe(0)
  })

  it('spends from one pouch without touching another', () => {
    const a = createArmoury({ starting: { grenade: 4, rocket: 2 } })
    a.consume('grenade')
    expect({ g: a.count('grenade'), r: a.count('rocket') }).toEqual({ g: 3, r: 2 })
  })

  it('the rifle is unlimited and spending it costs nothing', () => {
    const a = createArmoury({ starting: {} })
    for (let i = 0; i < 100; i += 1) {
      expect({ i, ok: a.consume(RIFLE_ORDNANCE) }).toEqual({ i, ok: true })
    }
  })
})

describe('grant, which is how a chest will replenish it', () => {
  it('adds to what is there', () => {
    // Ticket 017's loot chests call exactly this. The API exists now so that
    // ticket is a caller rather than a redesign.
    const a = createArmoury({ starting: { grenade: 1 } })
    a.grant('grenade', 3)
    expect(a.count('grenade')).toBe(4)
  })

  it('can introduce ordnance the squad had none of', () => {
    const a = createArmoury({ starting: {} })
    a.grant('rocket', 2)
    expect(a.count('rocket')).toBe(2)
  })

  it('ignores a non-positive grant rather than confiscating rounds', () => {
    // A chest with a mis-signed reward must not empty the pouch it was meant
    // to fill.
    const a = createArmoury({ starting: { grenade: 3 } })
    a.grant('grenade', -2)
    a.grant('grenade', 0)
    expect(a.count('grenade')).toBe(3)
  })

  it('ignores a fractional grant rather than banking half a grenade', () => {
    const a = createArmoury({ starting: { grenade: 3 } })
    a.grant('grenade', 1.5)
    expect(Number.isInteger(a.count('grenade'))).toBe(true)
  })
})

describe('hostile starting data, because a level document is hand-authored', () => {
  it('a negative starting count is treated as empty', () => {
    const a = createArmoury({ starting: { grenade: -5 } })
    expect(a.count('grenade')).toBe(0)
    expect(a.consume('grenade')).toBe(false)
  })

  it('a fractional starting count is not a fractional round', () => {
    const a = createArmoury({ starting: { grenade: 2.7 } })
    expect(Number.isInteger(a.count('grenade'))).toBe(true)
  })

  it('a non-finite starting count does not become infinite ammo', () => {
    // `NaN` and `Infinity` both survive a JSON round-trip badly and both would
    // make the count meaningless on the HUD.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const a = createArmoury({ starting: { grenade: bad } })
      expect({ bad: String(bad), finite: Number.isFinite(a.count('grenade')) }).toEqual({
        bad: String(bad),
        finite: true,
      })
    }
  })

  it('no options at all is a valid, empty armoury', () => {
    const a = createArmoury()
    expect(a.count('grenade')).toBe(0)
  })

  it('does not alias the object it was handed', () => {
    // A caller holding the level's own spawn data would otherwise watch its
    // document mutate as the squad threw grenades — and on a restart the level
    // would begin with whatever the last run ended on.
    const starting = { grenade: 4 }
    const a = createArmoury({ starting })
    a.consume('grenade')
    expect(starting.grenade).toBe(4)
    expect(a.count('grenade')).toBe(3)
  })

  it('two armouries built from one document are independent', () => {
    // What a restart does. Ticket 013's `restart()` builds a fresh session, and
    // shared mutable ammo would carry the last run's losses into the new one.
    const starting = { grenade: 4 }
    const a = createArmoury({ starting })
    const b = createArmoury({ starting })
    a.consume('grenade')
    expect(b.count('grenade')).toBe(4)
  })
})
