import { describe, it, expect } from 'vitest'
import { rig, OPEN, WEST } from './rig'
import type { AiOptions } from '../index'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../archetypes'
import { weaponFor } from '../../combat'
import type { ArchetypeSpec } from '../archetypes'

/**
 * Every enemy this suite spawns is faced at its own fixture (ticket 038).
 *
 * These cases were written when sight was a disc, so they park their player due
 * east or west of the enemy — 90 degrees off the shipped southward default, at
 * which nothing is acquired and every assertion here becomes a test of the
 * vision cone instead of a test of its own subject. The arc has its own suite in
 * `vision-cone.test.ts`, which runs on the shipped default.
 */
const arena = (art = OPEN, options: Partial<AiOptions> = {}) => rig(art, options, WEST)


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

/** The reach of the weapon an ENEMY rifleman actually holds. Eight since ticket 092. */
const RANGE = weaponFor(DEFAULT_ARCHETYPE_NAME, 'enemy')!.rangeTiles

/**
 * An archetype row keyed as `rifleman`, so the unit it describes is ARMED.
 *
 * Keyed by the shipped name deliberately: `AiOptions.archetypes` REPLACES the
 * table, and `weaponFor` arms by kind — so an invented kind like `test-kind` is
 * a soldier with no weapon, who never engages at any distance and would make
 * every assertion below pass for the wrong reason.
 *
 * Sight is 12 so it comfortably exceeds the eight-tile weapon; the gap between the
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
     * THE DISTANCE THAT DECIDES THE TICKET. Six tiles is inside the eight-tile
     * rifle — so the OLD machine engaged here and stopped — and outside the
     * four-tile closing distance this row asks for. Both bounds are asserted
     * against `RANGE` below rather than trusted from this comment.
     */
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
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
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(4)
    const before = gap(r, enemy.id, player.id)
    r.run(40)
    expect(gap(r, enemy.id, player.id)).toBeLessThan(before - 0.5)
  })

  it('then halts once he is inside the closing distance, and stops there', () => {
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
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
     * halted at four tiles back into `pursue` the moment his target drifted to
     * 4.1, and back to `engage` the moment it drifted in again — sixty times a
     * second. Five tiles is well outside the closing distance and well inside
     * the rifle, so it is only reachable by a machine with two thresholds.
     */
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    // Five tiles: outside the 4-tile closing distance, inside the 8-tile rifle.
    r.place(player.id, 5, 5)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('and only drops back to `pursue` once it passes the FULL range', () => {
    // The other side of the same claim. Without it, "stays engaged" is satisfied
    // by a machine that never leaves `engage` at all.
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    /**
     * DERIVED FROM THE WEAPON, NOT TYPED. This read `r.place(player.id, 2, 5)`
     * with the comment "eight tiles: outside 6.4", and ticket 092 gave the enemy
     * the squad's eight — so the fixture that used to sit 1.6 tiles beyond his
     * reach landed exactly ON it, `inRange` admitted it, and the man stayed in
     * `engage`. A distance typed from a weapon table is a number that stops
     * meaning what its comment says the moment the table moves.
     */
    const beyondReach = 10 - Math.ceil(RANGE) - 1
    expect(10 - beyondReach).toBeGreaterThan(RANGE)
    r.place(player.id, beyondReach, 5)
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
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
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
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5, reactionTicks: 30 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(60)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(r.ai.isReacting(enemy.id)).toBe(false)
    /**
     * DRIVEN PAST THE FULL RANGE, NOT MERELY PAST THE CLOSING DISTANCE.
     *
     * An earlier draft of this case moved the target to five tiles and back —
     * and adversarial review showed it could not fail, because the hysteresis
     * next door keeps him ENGAGED throughout, so no re-arm decision is ever
     * reached. A test that cannot fail is worse than no test: it reports
     * coverage of the thing it does not check.
     *
     * The far position must be outside the rifle ENTIRELY, so he genuinely drops
     * to `pursue`; two tiles is back inside the closing distance, so he
     * genuinely re-enters `engage`. It is the SAME MAN throughout, so the beat
     * must not be paid again — a soldier who re-armed on every boundary crossing
     * would stand there raising his rifle forever against a target that steps in
     * and out of cover.
     *
     * AND THE FAR POSITION IS DERIVED, BECAUSE IT WENT VACUOUS ONCE ALREADY.
     * It was `r.place(player.id, 2, 5)` — eight tiles, chosen when the enemy's
     * rifle reached 6.4. Ticket 092 gave him eight, so that position landed
     * inside the envelope, he never dropped to `pursue`, and the loop below
     * stopped exercising the re-arm decision at all. The suite stayed green:
     * the closing assertions hold trivially for a man who never left `engage`,
     * which is precisely the "reports coverage of the thing it does not check"
     * failure described above, arriving by a different route.
     */
    const beyondReach = 10 - Math.ceil(RANGE) - 1
    expect(10 - beyondReach).toBeGreaterThan(RANGE)
    for (let i = 0; i < 6; i += 1) {
      r.place(player.id, beyondReach, 5) // outside the rifle entirely
      r.run(3)
      r.place(player.id, 8, 5) // two tiles: back inside the closing distance
      r.run(3)
    }
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(r.ai.isReacting(enemy.id)).toBe(false)
  })
})

describe('a fraction of one reproduces the old behaviour exactly', () => {
  it('halting at maximum range, which is what makes the knob honest', () => {
    /**
     * The property that says this is a tuning surface and not a hardcoded new
     * rule: a row that wants a man to hold the treeline and a row that wants him
     * at arm's length must be the same code.
     *
     * SPAWNED AT EXACTLY `RANGE`, which is stronger than the six tiles this used
     * to use. Six was as good as maximum against the old 6.4-tile rifle; against
     * eight it is three quarters of the way out, so the case had quietly become
     * satisfiable by any fraction above 0.75 and no longer said anything
     * specific about `closeToFraction: 1`. At the exact edge, every fraction
     * below one is a `pursue` and this is the only row that engages.
     */
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 1 }) })
    const enemy = r.spawn(14, 5, 'enemy')
    const player = r.spawn(14 - RANGE, 5, 'player', 10_000)
    expect(gap(r, enemy.id, player.id)).toBe(RANGE)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('and he does not advance afterwards', () => {
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 1 }) })
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
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
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

describe('a target he has not closed on is a fresh approach', () => {
  it('switching to a further man drops him back to `pursue`', () => {
    /**
     * THE DEFECT ADVERSARIAL REVIEW FOUND, AND IT SHIPPED IN THE FIRST DRAFT.
     *
     * The hysteresis was keyed on `previous === ENGAGE` — a STATE check with no
     * reference to WHICH man he was engaging. So a soldier whose target went
     * down, or ducked behind cover while a second man was visible, carried the
     * full-range threshold over to somebody he had never closed on: he engaged
     * the new man at up to his full range and halted there, at the worst point of his
     * accuracy curve. That is verbatim the behaviour this ticket exists to
     * delete, reappearing on the most ordinary event in the game — level 1 puts
     * three riflemen against a four-man squad, so "the man he was shooting at
     * fell and he snapped to the next one" is not an edge case.
     *
     * `system.ts` already had the answer twelve lines below, where the reaction
     * beat is keyed on `armedTargetId` rather than on the state, for
     * structurally the same reason.
     */
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const near = r.spawn(7, 5, 'player', 10_000) // 3 tiles: inside the closing distance
    const far = r.spawn(4, 5, 'player', 10_000) // 6 tiles: outside it, inside 8
    r.run(6)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.world.despawn(near.id)
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
    // And he actually walks at the new man, rather than merely being relabelled.
    const before = gap(r, enemy.id, far.id)
    r.run(40)
    expect(gap(r, enemy.id, far.id)).toBeLessThan(before - 0.5)
  })

  it('but holding the SAME man across the boundary still costs nothing', () => {
    // The guard on the fix: "re-derive on a new target" must not become
    // "re-derive every tick", which would delete the hysteresis and bring back
    // the flicker it exists to prevent.
    const r = arena(OPEN, { archetypes: armed({ closeToFraction: 0.5 }) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(8, 5, 'player', 10_000)
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.place(player.id, 5, 5) // outside the closing distance, inside the rifle
    r.run(8)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })
})

describe('the marksman does not advance, which is the point of him', () => {
  it('engages from where he stands and stays there', () => {
    /**
     * ACCEPTANCE CRITERION 6, WHOSE SECOND HALF NOTHING EXERCISED. The shipped
     * sniper's `closeToFraction: 1` was pinned only by a literal table
     * assertion, so a machine that read the row and then ignored it — using the
     * default for everybody — passed. No test spawned a sniper at all.
     *
     * Six tiles is inside his eight-tile rifle and well outside the rifleman's
     * 4.8-tile closing distance, so this separates the two rows behaviourally.
     *
     * IT WAS FIVE, AND FIVE STOPPED SEPARATING THEM (ticket 092). At the enemy's
     * old 6.4-tile rifle the rifleman closed to 3.84 and five tiles cleared it
     * by 1.16; with the reach back at eight he closes to 4.8 and five clears it
     * by two tenths of a tile — inside the slop of where a man actually stands
     * after a few ticks, so the pair below stopped being about the archetype
     * rows at all. Both halves move together, because "the same spot" is the
     * whole point of the comparison.
     */
    const r = arena(OPEN)
    const enemy = r.spawnKind(10, 5, 'enemy', 'sniper')
    const player = r.spawn(4, 5, 'player', 10_000)
    r.run(6)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    const before = gap(r, enemy.id, player.id)
    r.run(200)
    expect(Math.abs(gap(r, enemy.id, player.id) - before)).toBeLessThan(0.5)
  })

  it('where the line infantryman in the same spot walks in', () => {
    // The other half of the pair. Same geometry, different rows, different
    // outcomes — without this, "the sniper holds" is satisfied by a machine in
    // which nobody ever advances.
    const r = arena(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(4, 5, 'player', 10_000)
    r.run(6)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
    const before = gap(r, enemy.id, player.id)
    r.run(60)
    expect(gap(r, enemy.id, player.id)).toBeLessThan(before - 0.5)
  })
})
