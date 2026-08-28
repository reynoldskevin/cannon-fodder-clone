import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
 * Ticket 036 — the two sides stop holding the same rifle — as amended by
 * tickets 092 and 093.
 *
 * `world.ts` spawns avatars and enemies alike as `kind: 'rifleman'`, and
 * `WEAPON_BY_KIND` is keyed by kind, so before ticket 036 there was no seam at
 * all through which an enemy could be given a different weapon. Every number in
 * the DEFAULT blocks below exists because the game measured unbeatable with the
 * two sides identical: three enemies at six tiles killed a four-man squad in
 * 1.7 seconds.
 *
 * TICKET 092 REMOVED THAT HANDICAP FOR EVERYBODY, AND 093 PUT IT BACK. What 092
 * built is now the `hard` row — the enemy at the squad's eight tiles and 40
 * ticks — reachable only by a player who asks for it with `?hard=1`. So this
 * file asserts TWO tables: the shipped default, unchanged since 036, and the
 * delta hard mode applies to it.
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

describe('his range is 80% of the squad`s, on the DEFAULT difficulty', () => {
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
     * un-does the whole handicap. These lines are what make that a failure.
     */
    expect(ENEMY_RANGE_FRACTION).toBe(0.8)
    expect(player().rangeTiles).toBe(8)
    expect(enemy().rangeTiles).toBe(6.4)
  })

  it('leaving a band in which the squad can shoot and he cannot', () => {
    expect(player().rangeTiles).toBeGreaterThan(enemy().rangeTiles)
  })
})

describe('and he fires more slowly, on the DEFAULT difficulty', () => {
  it('with a strictly longer cooldown than the squad`s rifle', () => {
    expect(enemy().cooldownTicks).toBeGreaterThan(player().cooldownTicks)
    expect(player().cooldownTicks).toBe(32)
    expect(enemy().cooldownTicks).toBe(46)
  })

  it('measurably slower: he lands fewer rounds a minute at his own maximum range', () => {
    // Guards the pair together, which neither constant does alone — a shorter
    // range with an unchanged cooldown, or the reverse, both leave the firefight
    // far closer to the one that was reported as unbeatable.
    const roundsPerMinute = (s: WeaponSpec): number => 3600 / s.cooldownTicks
    expect(roundsPerMinute(enemy())).toBeLessThan(roundsPerMinute(player()) * 0.7)
  })
})

describe('the accuracy curve is deliberately untouched', () => {
  it('so the shorter range is the only thing that moved', () => {
    // The endpoints are relative to each weapon's OWN range, so shortening the
    // range already steepens the falloff in real terms.
    expect(enemy().accuracy).toEqual(player().accuracy)
    expect(player().accuracy).toEqual({ pointBlank: 0.9, maxRange: 0.25 })
  })
})

/**
 * Ticket 093 — what ticket 092 shipped as the default becomes an opt-in.
 *
 * 092 gave the enemy the squad's eight tiles and dropped him to 40 ticks for
 * EVERY player. That is the `hard` row now, and the blocks above are what
 * anybody who does not type `?hard=1` gets.
 */
describe('hard mode hands him the squad`s reach and a faster rifle', () => {
  const hard = (): WeaponSpec => {
    const found = weaponFor('rifleman', 'enemy', 'hard')
    if (found === null) throw new Error('no hard enemy rifle')
    return found
  }

  it('reaches as far as the squad, from the same constant', () => {
    expect(hard().rangeTiles).toBe(player().rangeTiles)
    expect(hard().rangeTiles).toBe(8)
  })

  it('and fires at 40 ticks — faster than normal, still slower than the squad', () => {
    expect(hard().cooldownTicks).toBe(40)
    expect(hard().cooldownTicks).toBeLessThan(enemy().cooldownTicks)
    expect(hard().cooldownTicks).toBeGreaterThan(player().cooldownTicks)
  })

  it('and 40 divides 3600, which is no longer a reason to avoid it', () => {
    /**
     * `weapons.ts` used to warn against the divisors of 3600 and this file used
     * to assert `3600 % cooldown !== 0`, both because `resolution.test.ts`
     * counted the rate as `floor(3600 / cd) + 1` and overcounted by one for
     * exactly those values. Ticket 092 fixed the arithmetic and that fix is
     * UNCONDITIONAL — it was never about difficulty. Asserted as gone rather
     * than merely unmentioned, because a warning quietly reinstated would send
     * the next designer back around the same loop.
     */
    expect(3600 % hard().cooldownTicks).toBe(0)
    const source = readFileSync(new URL('../weapons.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('3600')
  })

  it('differs from the normal row in reach and rate ALONE', () => {
    /**
     * THE ASSERTION THAT STOPS THE TWO ROWS DRIFTING. A hard row written as four
     * fresh literals would let a later retune of damage or the accuracy curve
     * land on one difficulty and not the other, and nothing would say so — the
     * player would be fighting a different weapon rather than a harder one.
     */
    const exceptReachAndRate = (s: WeaponSpec) => ({
      name: s.name,
      damage: s.damage,
      accuracy: s.accuracy,
    })
    expect(exceptReachAndRate(hard())).toEqual(exceptReachAndRate(enemy()))
  })

  it('and still fires under the SAME identifier, so FX and audio need not know', () => {
    /**
     * `Weapon` is `string` — an open enum. A second identifier for the hard rifle
     * would make every consumer of `ShotFired.weapon` responsible for knowing
     * about difficulty, and nothing would fail to compile when one forgot.
     */
    expect(hard().name).toBe(ENEMY_RIFLE)
    expect(hard().name).toBe(enemy().name)
  })

  it('and leaves the SQUAD`S rifle identical on both difficulties', () => {
    // Hard mode is the enemy getting better, not the player getting worse.
    expect(weaponFor('rifleman', 'player', 'hard')).toEqual(weaponFor('rifleman', 'player'))
    expect(weaponFor('sniper', 'player', 'hard')).toEqual(weaponFor('sniper', 'player'))
  })

  it('and arms the enemy sniper from it too, so no kind is forgotten', () => {
    // The same way to forget that ticket 036 guarded: a difficulty table listing
    // `rifleman` and not `sniper` leaves hard snipers on the normal rifle.
    expect(weaponFor('sniper', 'enemy', 'hard')).toEqual(hard())
  })
})

describe('the difficulty is an ARGUMENT, not module state', () => {
  it('defaults to normal when nobody passes one', () => {
    expect(weaponFor('rifleman', 'enemy')).toEqual(weaponFor('rifleman', 'enemy', 'normal'))
    expect(weaponFor('rifleman', 'enemy')).not.toEqual(weaponFor('rifleman', 'enemy', 'hard'))
  })

  it('so asking for hard does not change what the next normal lookup answers', () => {
    /**
     * A mutable module-level difficulty something set at boot would be global
     * state in the layer whose determinism guarantee is why replays work, and
     * the campaign runner already builds more than one session in a page — two
     * of them would fight over it. This is the assertion that fails if the
     * difficulty is ever stored rather than passed.
     */
    const before = weaponFor('rifleman', 'enemy')
    weaponFor('rifleman', 'enemy', 'hard')
    expect(weaponFor('rifleman', 'enemy')).toEqual(before)
    expect(weaponFor('rifleman', 'enemy')?.rangeTiles).toBe(6.4)
  })

  it('and an unarmed kind is null on every difficulty', () => {
    expect(weaponFor('jeep', 'enemy', 'hard')).toBeNull()
    expect(weaponFor('jeep', 'player', 'hard')).toBeNull()
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
