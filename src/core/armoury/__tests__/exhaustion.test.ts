import { describe, it, expect } from 'vitest'
import { createArmoury, RIFLE_ORDNANCE } from '../index'

/**
 * Ticket 069 — the rifle comes back when the pouch runs dry.
 *
 * Spending your last grenade used to leave the squad still HOLDING grenades, and
 * every right-click after it was a refusal: the order went in, `consume` said no,
 * `FireRejected` came back, and nothing happened on screen. The player is left
 * clicking at an enemy with a weapon he no longer owns, and the only way to find
 * out is to read the count in the HUD's selector.
 *
 * THE FALLBACK IS THE ARMOURY'S JOB AND NOT ITS CALLER'S. The invariant is that
 * the pouch never HOLDS what it has none of; enforced in `command/apply.ts`
 * instead, it would hold for the fire command and be forgotten by the next thing
 * that ever spends a round. So it lives in `consume`, which is the only place a
 * count goes down.
 *
 * WHOSE EXHAUSTION COUNTS IS THE PART WORTH PINNING. Only the weapon in your
 * hands disarms you. A rocket running dry while you are holding grenades must
 * leave the grenades exactly where they are — anything else is the game taking a
 * weapon out of the player's hands over something that did not happen to it.
 */

const armoury = () => createArmoury({ starting: { grenade: 2, rocket: 1 } })

describe('the last round of what you are holding', () => {
  it('puts the rifle back in your hands', () => {
    const a = armoury()
    expect(a.select('rocket')).toBe(true)
    expect(a.consume('rocket')).toBe(true)
    expect(a.count('rocket')).toBe(0)
    expect(a.selected).toBe(RIFLE_ORDNANCE)
  })

  it('and the round before it does not', () => {
    /**
     * THE CONTROL. A fallback that fired on every `consume` would satisfy the
     * case above and take the grenades away after the first one — which is the
     * same bug as never falling back, only louder.
     */
    const a = armoury()
    a.select('grenade')
    expect(a.consume('grenade')).toBe(true)
    expect(a.count('grenade')).toBe(1)
    expect(a.selected).toBe('grenade')
  })

  it('and it is the SELECTED weapon’s exhaustion that disarms, nobody else’s', () => {
    /**
     * Firing spends what you are holding, so this is reached through the back
     * door on purpose: whatever else ever calls `consume` — a dud, a misfire, a
     * future weapon that spends two kinds of round — must not be able to take
     * the player's grenades away by emptying something he is not holding.
     */
    const a = armoury()
    a.select('grenade')
    expect(a.consume('rocket')).toBe(true)
    expect(a.count('rocket')).toBe(0)
    expect(a.selected).toBe('grenade')
  })
})

describe('the cases that must not trigger it', () => {
  it('never disarms the rifle, which cannot run out', () => {
    /**
     * `consume(rifle)` returns true forever and spends nothing. A fallback that
     * looked only at "did the count reach zero" would see the rifle's absent
     * count as 0 and re-select the rifle every shot — harmless today, and
     * exactly the kind of thing that is not harmless once anything watches the
     * selection.
     */
    const a = armoury()
    expect(a.selected).toBe(RIFLE_ORDNANCE)
    expect(a.consume(RIFLE_ORDNANCE)).toBe(true)
    expect(a.consume(RIFLE_ORDNANCE)).toBe(true)
    expect(a.selected).toBe(RIFLE_ORDNANCE)
  })

  it('and a refused consume changes nothing at all', () => {
    // Already empty: `consume` returns false and spends nothing, so there is no
    // transition to fall back on. The player is holding an empty weapon because
    // he chose to; see the note on `select` below.
    const a = createArmoury({ starting: { grenade: 0 } })
    a.select('grenade')
    expect(a.consume('grenade')).toBe(false)
    expect(a.count('grenade')).toBe(0)
    expect(a.selected).toBe('grenade')
  })

  it('and an unknown ordnance cannot disarm anybody', () => {
    const a = armoury()
    a.select('grenade')
    expect(a.consume('bazooka')).toBe(false)
    expect(a.selected).toBe('grenade')
  })
})

describe('after the fallback', () => {
  it('a chest refilling the pouch does not silently re-arm it', () => {
    /**
     * `grant` is what ticket 017's chests call. Re-selecting the weapon the
     * player was holding ten seconds ago would change what his next right-click
     * throws, at a moment he was looking at the map and not at the HUD — the
     * game must not arm ordnance behind his back.
     */
    const a = armoury()
    a.select('rocket')
    a.consume('rocket')
    expect(a.selected).toBe(RIFLE_ORDNANCE)
    a.grant('rocket', 3)
    expect(a.count('rocket')).toBe(3)
    expect(a.selected).toBe(RIFLE_ORDNANCE)
  })

  it('and the weapon can be picked up again by hand', () => {
    const a = armoury()
    a.select('rocket')
    a.consume('rocket')
    a.grant('rocket', 1)
    expect(a.select('rocket')).toBe(true)
    expect(a.selected).toBe('rocket')
  })

  it('and selecting an EMPTY weapon is still allowed, which this ticket does not change', () => {
    /**
     * PINNING THE LIMIT, NOT THE FEATURE. Arming something you have none of is
     * how a player is told he is empty — the count is on the icon and the fire
     * is refused — and it is what pressing `2` has always done. If that should
     * change it is a decision about the SELECT path, and it belongs to its own
     * ticket rather than arriving as a side effect of this one.
     */
    const a = armoury()
    a.select('rocket')
    a.consume('rocket')
    expect(a.select('rocket')).toBe(true)
    expect(a.selected).toBe('rocket')
    expect(a.count('rocket')).toBe(0)
  })
})
