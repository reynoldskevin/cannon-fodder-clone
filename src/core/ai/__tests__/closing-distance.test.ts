import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../archetypes'
import { weaponFor } from '../../combat'
import type { ArchetypeSpec } from '../archetypes'

/**
 * Ticket 037 — a pursuing enemy closes to a distance he can actually shoot from.
 *
 * `ai/system.ts` entered `engage` the instant the target was inside the WEAPON'S
 * MAXIMUM range and halted there for the rest of the firefight. That is the
 * least effective distance available to him — the accuracy curve is at its worst
 * at `rangeTiles` — and, before ticket 036 gave the enemy his own rifle, it was
 * also exactly the player's own range, which is why the reported symptom was
 * specifically "they stop at the edge of MY firing range".
 */

/** The reach of the weapon an ENEMY rifleman actually holds. 6.4 since ticket 036. */
const RANGE = weaponFor(DEFAULT_ARCHETYPE_NAME, 'enemy')!.rangeTiles

/**
 * An archetype row keyed as `rifleman`, so the unit it describes is ARMED.
 *
 * Keyed by the shipped name deliberately: `AiOptions.archetypes` REPLACES the
 * table, and `weaponFor` arms by kind — so an invented kind like `test-kind` is
 * a soldier with no weapon, who never engages at any distance and would make
 * every assertion below pass for the wrong reason.
 *
 * Sight is 12 so it comfortably exceeds the 6.4-tile weapon; the gap between the
 * two is the whole space this ticket operates in.
 */
const armed = (over: Partial<ArchetypeSpec>): Record<string, ArchetypeSpec> => ({
  [DEFAULT_ARCHETYPE_NAME]: {
    name: DEFAULT_ARCHETYPE_NAME,
    sightRangeTiles: 12,
    alertRadiusTiles: 12,
    pursueTimeoutTicks: 600,
    alertTimeoutTicks: 600,
    aggression: 1,
    reactionTicks: 12,
    closeToFraction: 0.5,
    ...over,
  },
})

/** How far apart two entities stand, in tiles. */
const gap = (r: ReturnType<typeof rig>, a: number, b: number): number => {
  const one = r.world.get(a)
  const two = r.world.get(b)
  if (one === undefined || two === undefined) throw new Error('entity gone')
  return Math.hypot(one.x - two.x, one.z - two.z)
}

describe('he keeps walking while the target is inside his range but far in it', () => {
  it('stays in `pursue` at six tiles, which is inside the weapon and outside the closing distance', () => {
    /**
     * THE DISTANCE THAT DECIDES THE TICKET. Six tiles is inside the 6.4-tile
     * rifle — so the OLD machine engaged here and stopped — and outside the
     * 3.2-tile closing distance this row asks for.
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    expect(gap(r, enemy.id, player.id)).toBeGreaterThan(RANGE * 0.5)
    expect(gap(r, enemy.id, player.id)).toBeLessThan(RANGE)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
  })

  it('and the gap actually shrinks, rather than him merely being labelled `pursue`', () => {
    // A state name is not a behaviour. This is the assertion that fails if the
    // machine reports `pursue` and issues no order.
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(4)
    const before = gap(r, enemy.id, player.id)
    r.run(40)
    expect(gap(r, enemy.id, player.id)).toBeLessThan(before - 0.5)
  })

  it('then halts once he is inside the closing distance, and stops there', () => {
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(300)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    const settled = gap(r, enemy.id, player.id)
    expect(settled).toBeLessThanOrEqual(RANGE * 0.5 + 0.75)
    // And he PLANTS his feet: a man who keeps walking after engaging ends the
    // firefight in knife range, which wastes every piece of cover on the map.
    r.run(120)
    expect(Math.abs(gap(r, enemy.id, player.id) - settled)).toBeLessThan(0.5)
  })
})

describe('the two boundaries are different, or he vibrates', () => {
  it('having engaged, he STAYS engaged out to the full weapon range', () => {
    /**
     * THE HYSTERESIS, AND IT IS THE LOAD-BEARING PART OF THE DESIGN. Entering on
     * the closing distance and leaving on the same one would put a man who
     * halted at 3.2 tiles back into `pursue` the moment his target drifted to
     * 3.3, and back to `engage` the moment it drifted in again — sixty times a
     * second. Five tiles is well outside the closing distance and well inside
     * the rifle, so it is only reachable by a machine with two thresholds.
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.place(player.id, 5, 5) // five tiles: outside 3.2, inside 6.4
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('and only drops back to `pursue` once it passes the FULL range', () => {
    // The other side of the same claim. Without it, "stays engaged" is satisfied
    // by a machine that never leaves `engage` at all.
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.place(player.id, 2, 5) // eight tiles: outside 6.4
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
  })

  it('so an ordinary approach produces a handful of transitions, not hundreds', () => {
    /**
     * The symptom the hysteresis exists to prevent, measured directly rather
     * than argued. A single-threshold machine flickers engage/pursue every few
     * ticks for as long as the man sits near his stopping distance; a soldier
     * vibrating on the spot is what the player would actually see.
     *
     * Bounded generously — this is not asserting an exact transition count, it
     * is asserting the difference between "a few" and "constantly".
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    r.spawn(8, 5, 'player', 10_000)
    let previous = String(r.ai.stateOf(enemy.id))
    let changes = 0
    for (let t = 0; t < 400; t += 1) {
      r.run(1)
      const now = String(r.ai.stateOf(enemy.id))
      if (now !== previous) changes += 1
      previous = now
    }
    expect(changes).toBeLessThanOrEqual(4)
  })

  it('and the reaction beat is not re-armed by crossing the closing boundary', () => {
    /**
     * `Memory.armedTargetId` arms the beat per TARGET ACQUISITION precisely so a
     * boundary flicker cannot restart a countdown that then never completes —
     * `reaction.test.ts` pins that for the weapon-range boundary. This ticket
     * introduces a SECOND boundary, and a man who re-armed on it would stand
     * there raising his rifle forever while the player walked in and out of 3.2
     * tiles.
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5, reactionTicks: 30 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(60)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(r.ai.isReacting(enemy.id)).toBe(false)
    for (let i = 0; i < 6; i += 1) {
      r.place(player.id, 5, 5) // outside the closing distance
      r.run(3)
      r.place(player.id, 8, 5) // back inside it
      r.run(3)
    }
    expect(r.ai.isReacting(enemy.id)).toBe(false)
  })
})

describe('a fraction of one reproduces the old behaviour exactly', () => {
  it('halting at maximum range, which is what makes the knob honest', () => {
    /**
     * The property that says this is a tuning surface and not a hardcoded new
     * rule: a row that wants a man to hold the treeline and a row that wants him
     * at arm's length must be the same code. Six tiles is inside 6.4 and would
     * be `pursue` at any fraction below ~0.94.
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 1 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    r.spawn(8, 5, 'player', 10_000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('and he does not advance afterwards', () => {
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 1 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(4)
    const before = gap(r, enemy.id, player.id)
    r.run(200)
    expect(Math.abs(gap(r, enemy.id, player.id) - before)).toBeLessThan(0.5)
  })
})

describe('an unarmed kind is untouched by any of it', () => {
  it('closes forever and never engages', () => {
    /**
     * `system.ts` already documents this as the honest behaviour for something
     * that cannot shoot back: no weapon means no range, so there is no distance
     * at which it stops. A fraction OF ZERO is still zero, and the arithmetic
     * must not turn that into a divide or a NaN — a NaN comparison is false, so
     * the man would engage from anywhere or from nowhere depending on which way
     * the test was written.
     */
    const r = rig(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawnKind(14, 5, 'enemy', 'sandbag')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
    const before = gap(r, enemy.id, player.id)
    r.run(120)
    expect(gap(r, enemy.id, player.id)).toBeLessThan(before)
    expect(r.ai.stateOf(enemy.id)).not.toBe('engage')
  })
})

describe('the shipped table says what each kind is for', () => {
  it('every row carries a closing fraction, in (0, 1]', () => {
    for (const [key, row] of Object.entries(ARCHETYPES)) {
      expect({ key, ok: typeof row.closeToFraction === 'number' }).toEqual({ key, ok: true })
      expect({ key, ok: row.closeToFraction > 0 && row.closeToFraction <= 1 }).toEqual({
        key,
        ok: true,
      })
    }
  })

  it('the line infantryman closes, and the marksman does not', () => {
    /**
     * The pair is the point. A sniper who walks toward the squad to shoot has
     * thrown away the only thing that made him worth placing — the same argument
     * `archetypes.ts` already makes for his short leash and his short pursue
     * timeout. If both rows ever read the same, one of them is a decision nobody
     * made.
     */
    expect(ARCHETYPES[DEFAULT_ARCHETYPE_NAME]?.closeToFraction).toBe(0.6)
    expect(ARCHETYPES['sniper']?.closeToFraction).toBe(1)
  })

  it('and the table is still plain data', () => {
    // The rule `archetypes.ts` states: a row must survive a JSON round-trip, so
    // a level document can carry a garrison's profile with no code change.
    expect(JSON.parse(JSON.stringify(ARCHETYPES))).toEqual(ARCHETYPES)
  })
})
