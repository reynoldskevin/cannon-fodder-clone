import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  WEAPONS,
  WEAPON_BY_KIND,
  RIFLE,
  ENEMY_RIFLE,
  weaponFor,
  weaponForKind,
  type WeaponSpec,
} from '../index'
import * as combat from '../index'

/**
 * Ticket 036 — the two sides stop holding the same rifle — as amended by
 * ticket 092.
 *
 * `world.ts` spawns avatars and enemies alike as `kind: 'rifleman'`, and
 * `WEAPON_BY_KIND` is keyed by kind, so before ticket 036 there was no seam at
 * all through which an enemy could be given a different weapon. THAT SEAM IS
 * WHAT SURVIVES, and it is the part of 036 worth keeping: the per-team override,
 * the sniper row that stops a kind being forgotten, and the unarmed default.
 *
 * WHAT 092 UNDOES IS THE HANDICAP THE SEAM CARRIED. 036 gave the enemy 80% of
 * the squad's reach and a much longer cooldown because the game measured
 * unbeatable with the two sides identical — three enemies at six tiles killed a
 * four-man squad in 1.7 seconds. The reach is now equal again and the cooldown
 * is 40 against 32, so the surviving margin is a fifth of the rate and nothing
 * else. If the 1.7 seconds returns, THIS is the file that says which numbers to
 * look at.
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

describe('his rifle reaches exactly as far as the squad`s (ticket 092)', () => {
  it('is DERIVED from the player rifle rather than typed as a second 8', () => {
    // The relation, not the value. This survives ticket 036's deletion because
    // it is the property that mattered all along: a retune of the squad's rifle
    // must carry the enemy's with it. Two 8s side by side agree today and
    // nothing makes them agree tomorrow.
    expect(enemy().rangeTiles).toBe(player().rangeTiles)
  })

  it('and the derivation is in the SOURCE, not merely an equality that holds today', () => {
    /**
     * THE ASSERTION ABOVE IS SATISFIED BY TYPING 8 TWICE, which is exactly the
     * failure mode ticket 036 wrote a fraction to avoid — and with the fraction
     * gone, nothing else in this file can tell a derived row from a duplicated
     * literal. So the row is read.
     *
     * Ticket 034's tint bug is the standing precedent for why an equality
     * computed the way production computes it proves nothing on its own; this
     * project has since paid for it twice more.
     */
    const source = readFileSync(new URL('../weapons.ts', import.meta.url), 'utf8')
    const row = source.slice(source.indexOf('[ENEMY_RIFLE]: {'))
    expect(row).not.toBe('')
    const written = /^\s*rangeTiles:\s*([^,\n]+),/m.exec(row)?.[1]
    expect(written).toBe('RIFLE_RANGE_TILES')
  })

  it('and the resulting distance is pinned literally on both rows', () => {
    expect(player().rangeTiles).toBe(8)
    expect(enemy().rangeTiles).toBe(8)
  })

  it('so no fraction constant survives claiming a handicap that is gone', () => {
    /**
     * `ENEMY_RANGE_FRACTION` IS DELETED RATHER THAN SET TO 1, which is ticket
     * 091's shape a second time. A constant that multiplies by one is not a
     * fraction; it is a public export of `core/combat/index.ts` telling every
     * reader the two sides are handicapped apart when they are not, and the next
     * person to grep for it finds a lever that does nothing.
     *
     * Checked against the module namespace because a deleted export cannot be
     * imported by name — that would be a compile error rather than a failure.
     */
    expect(Object.keys(combat)).not.toContain('ENEMY_RANGE_FRACTION')
  })
})

describe('and he fires more slowly, which is now the only handicap left', () => {
  it('with a strictly longer cooldown than the squad`s rifle', () => {
    /**
     * 40, DOWN FROM 46 (ticket 092), which was itself down from 52 (ticket 075).
     * The exact value stays pinned on purpose — it makes a retune something
     * somebody decided rather than something that drifted — while the ordering
     * assertion is what actually holds the claim that he is the slower shot.
     */
    expect(enemy().cooldownTicks).toBeGreaterThan(player().cooldownTicks)
    expect(player().cooldownTicks).toBe(32)
    expect(enemy().cooldownTicks).toBe(40)
  })

  it('at a rate re-derived from the two cooldowns, not left at a stale threshold', () => {
    /**
     * FOUR ROUNDS FOR EVERY FIVE OF THE SQUAD'S. The old bound here was
     * `< 0.7 × the squad's`, which 46 cleared by a hair (78.3 against 78.75) and
     * 40 does not clear at all. Loosening that number until 40 fits would be the
     * test following the code; stating the ratio the two cooldowns actually
     * produce makes a retune of either come back here and say what the new claim
     * is.
     */
    const roundsPerMinute = (s: WeaponSpec): number => 3600 / s.cooldownTicks
    expect(roundsPerMinute(enemy())).toBeLessThan(roundsPerMinute(player()))
    expect(roundsPerMinute(enemy()) / roundsPerMinute(player())).toBeCloseTo(0.8, 10)
  })

  it('and 40 divides 3600, which is no longer a reason to avoid it', () => {
    /**
     * The inverse of the guard this replaces. `weapons.ts` used to warn against
     * the divisors of 3600 and this file used to assert `3600 % cooldown !== 0`,
     * both because `resolution.test.ts` counted the rate as
     * `floor(3600 / cd) + 1` and overcounted by one for exactly those values.
     * Ticket 092 fixed the arithmetic (`ceil`) instead of steering the requested
     * value around it, so the constraint is gone — and this asserts it is gone
     * rather than merely unmentioned, because a warning quietly reinstated in
     * `weapons.ts` would send the next designer back around the same loop.
     */
    expect(3600 % enemy().cooldownTicks).toBe(0)
    const source = readFileSync(new URL('../weapons.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('3600')
  })
})

describe('the accuracy curve is deliberately untouched', () => {
  it('so the reach and the rate are the only things that moved', () => {
    expect(enemy().accuracy).toEqual(player().accuracy)
    expect(player().accuracy).toEqual({ pointBlank: 0.9, maxRange: 0.25 })
  })

  it('leaving two rows that differ in name and cooldown ALONE', () => {
    /**
     * The end state stated once, positively, instead of inferred from four
     * separate equalities — and the assertion that fails loudest if a later
     * ticket reaches for damage or accuracy to re-open a gap between the sides
     * without saying so.
     *
     * `expect(theirs).not.toEqual(mine)` at the top of this file now rests
     * entirely on these two fields, which is worth knowing.
     */
    const exceptTheRate = (s: WeaponSpec) => ({
      damage: s.damage,
      rangeTiles: s.rangeTiles,
      accuracy: s.accuracy,
    })
    expect(exceptTheRate(enemy())).toEqual(exceptTheRate(player()))
    expect(enemy().name).not.toBe(player().name)
    expect(enemy().cooldownTicks).not.toBe(player().cooldownTicks)
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
