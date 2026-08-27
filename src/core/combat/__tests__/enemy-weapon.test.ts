import { describe, it, expect } from 'vitest'
import {
  WEAPONS,
  WEAPON_BY_KIND,
  RIFLE,
  ENEMY_RIFLE,
  ENEMY_RANGE_FRACTION,
  weaponFor,
  weaponForKind,
  type WeaponSpec,
} from '../index'

/**
 * Ticket 036 — the two sides stop holding the same rifle.
 *
 * `world.ts` spawns avatars and enemies alike as `kind: 'rifleman'`, and
 * `WEAPON_BY_KIND` is keyed by kind, so before this ticket there was no seam at
 * all through which an enemy could be given a worse weapon. Every number below
 * exists because the game was measured as unbeatable with the two sides
 * identical: three enemies at six tiles killed a four-man squad in 1.7 seconds.
 */

const spec = (name: keyof typeof WEAPONS): WeaponSpec => {
  const found = WEAPONS[name]
  if (found === undefined) throw new Error(`no weapon ${String(name)}`)
  return found
}

const player = (): WeaponSpec => spec(RIFLE)
const enemy = (): WeaponSpec => spec(ENEMY_RIFLE)

describe('the enemy carries a weapon of his own', () => {
  it('resolves a different spec for the two teams of the SAME kind', () => {
    // The whole ticket in one assertion. Both sides are `rifleman`; nothing but
    // the team can tell them apart, which is why the team is what arms them.
    const mine = weaponFor('rifleman', 'player')
    const theirs = weaponFor('rifleman', 'enemy')
    expect(mine).not.toBeNull()
    expect(theirs).not.toBeNull()
    expect(mine?.name).toBe(RIFLE)
    expect(theirs?.name).toBe(ENEMY_RIFLE)
    expect(theirs).not.toEqual(mine)
  })

  it('and arms the sniper from the same team rule, so no kind is forgotten', () => {
    /**
     * `archetypes.ts` has a standing rule that every archetype must name a kind
     * `weaponForKind` can arm, with a test enforcing it — a soldier who patrols,
     * sees, alerts, pursues and then cannot fire is the failure it prevents.
     * Splitting by team creates a second way to forget: an override table that
     * lists `rifleman` and not `sniper` would leave enemy snipers holding the
     * PLAYER'S rifle, outranging everything and shooting faster than the line
     * infantry beside them.
     */
    expect(weaponFor('sniper', 'enemy')?.name).toBe(ENEMY_RIFLE)
    expect(weaponFor('sniper', 'player')?.name).toBe(RIFLE)
  })
})

describe('his range is 80% of the squad`s', () => {
  it('is DERIVED from the player rifle rather than typed as a second number', () => {
    // The relation, not the value: a retune of the squad's rifle must carry the
    // enemy's with it. A hardcoded 6.4 beside an 8 is two numbers that agree
    // today and nothing that makes them agree tomorrow.
    expect(enemy().rangeTiles).toBe(player().rangeTiles * ENEMY_RANGE_FRACTION)
  })

  it('and BOTH the fraction and the resulting distance are pinned literally', () => {
    /**
     * THE RELATION ABOVE IS NOT ENOUGH ON ITS OWN, and this project has already
     * shipped that mistake once: ticket 034's tint test computed its expectation
     * with the same expression production used, so swapping two rows left the
     * suite green while rendering the map wrong.
     *
     * `ENEMY_RANGE_FRACTION = 1` satisfies the derivation test perfectly and
     * un-does the entire ticket. These two lines are what make that a failure.
     */
    expect(ENEMY_RANGE_FRACTION).toBe(0.8)
    expect(player().rangeTiles).toBe(8)
    expect(enemy().rangeTiles).toBe(6.4)
  })

  it('leaving a band in which the squad can shoot and he cannot', () => {
    // The difficulty lever this ticket actually pulls, stated as a property
    // rather than left implicit in two constants.
    expect(player().rangeTiles).toBeGreaterThan(enemy().rangeTiles)
  })
})

describe('and he fires more slowly', () => {
  it('with a strictly longer cooldown than the squad`s rifle', () => {
    expect(enemy().cooldownTicks).toBeGreaterThan(player().cooldownTicks)
    expect(player().cooldownTicks).toBe(32)
    expect(enemy().cooldownTicks).toBe(52)
  })

  it('and a cooldown that does not divide 3600, which is not a style point', () => {
    /**
     * `weapons.ts` documents it and `resolution.test.ts` is the reason: the rate
     * assertion is `floor(3600 / cooldownTicks) + 1`, which overcounts by one for
     * any value dividing 3600 exactly. 48 and 50 — the two obvious choices
     * either side of 52 — both divide it. A designer who tries one deserves to
     * meet this test rather than a baffling off-by-one in another file.
     */
    expect(3600 % enemy().cooldownTicks).not.toBe(0)
    expect(3600 % player().cooldownTicks).not.toBe(0)
  })

  it('measurably slower: he lands fewer rounds a minute at his own maximum range', () => {
    // Guards the pair of changes together, which neither constant does alone —
    // a shorter range with an unchanged cooldown, or the reverse, both leave the
    // firefight far closer to the one that was reported as unbeatable.
    const roundsPerMinute = (s: WeaponSpec): number => 3600 / s.cooldownTicks
    expect(roundsPerMinute(enemy())).toBeLessThan(roundsPerMinute(player()) * 0.7)
  })
})

describe('the accuracy curve is deliberately untouched', () => {
  it('so the shorter range is the only thing that moved', () => {
    // Two changes explaining one outcome would leave the ticket unable to say
    // which produced it. The endpoints are relative to each weapon's OWN range,
    // so shortening the range already steepens the falloff in real terms.
    expect(enemy().accuracy).toEqual(player().accuracy)
    expect(player().accuracy).toEqual({ pointBlank: 0.9, maxRange: 0.25 })
  })
})

describe('both rows are still plain data', () => {
  it('surviving a JSON round-trip unchanged', () => {
    /**
     * The rule `weapons.ts` states at the top, and the reason this ticket may
     * derive the range: the multiplication happens once at construction and what
     * lands in the table is a number. A getter would vanish here and take the
     * enemy's range with it.
     */
    for (const s of [player(), enemy()]) {
      expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    }
  })

  it('with no function-valued fields anywhere in either row', () => {
    for (const s of [player(), enemy()]) {
      for (const value of Object.values(s)) {
        expect(typeof value).not.toBe('function')
      }
    }
  })
})

describe('nothing that worked before stops working', () => {
  it('`weaponForKind` still answers, and still answers the player rifle', () => {
    // Kept because `archetypes.ts` names it in a standing cross-table assertion,
    // and because "what does this kind carry by default" is still a real
    // question with an unchanged answer.
    expect(weaponForKind('rifleman')?.name).toBe(RIFLE)
    expect(WEAPON_BY_KIND['rifleman']).toBe(RIFLE)
  })

  it('and an unarmed kind is null on BOTH teams', () => {
    // The default that keeps a parked jeep from returning fire. A per-team
    // override table that fell through to something rather than to nothing would
    // arm every piece of scenery on one side of the map.
    expect(weaponFor('jeep', 'enemy')).toBeNull()
    expect(weaponFor('jeep', 'player')).toBeNull()
    expect(weaponForKind('jeep')).toBeNull()
  })
})
