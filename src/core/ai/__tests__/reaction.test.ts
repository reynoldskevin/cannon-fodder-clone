import { describe, it, expect } from 'vitest'
import { rig, OPEN, WALLED } from './rig'
import { ARCHETYPES, DEFAULT_ARCHETYPE_NAME } from '../archetypes'
import { DEFAULT_REACTION_TICKS } from '../tuning'
import type { ArchetypeSpec } from '../archetypes'
import type { Rig } from './rig'

/**
 * Ticket 012a — a moment between being seen and being shot.
 *
 * THE OTHER HALF OF WHAT PLAYING THE GAME FOUND. Ticket 011b made a round a
 * chance rather than a certainty; this is the beat before the first one. An
 * enemy that enters `engage` issues `orderFire` on the SAME TICK, so the first
 * thing the player learns about being spotted is a man falling over. There is
 * nothing to react to, because the reaction and the consequence arrive together.
 *
 * IT GATES `shootAt` AND NOTHING ELSE. Entering `engage` already halts a man —
 * deliberately, so he does not walk into knife range and waste the level's cover
 * — and that stays exactly as it is. His target memory, his leash and his post
 * are untouched. A ticket that also moved him would be a retune of engagement
 * distance wearing a reaction delay's name.
 *
 * THE TIMER IS PINNED AGAINST AN INJECTED TABLE, not against the shipped one.
 * `AiOptions.archetypes` REPLACES the table, so every timing case below states
 * its own `reactionTicks` and cannot be silently retuned by a designer editing
 * `archetypes.ts`. The shipped values get their own describe block at the
 * bottom, where they are the subject rather than the instrument.
 */

/** An archetype table with one row, so the number under test is the only one. */
const table = (reactionTicks: number, over: Partial<ArchetypeSpec> = {}): Record<string, ArchetypeSpec> => {
  const base = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]
  if (base === undefined) throw new Error('no default archetype')
  return { [DEFAULT_ARCHETYPE_NAME]: { ...base, reactionTicks, ...over } }
}

/**
 * An enemy and a player five tiles apart on open ground.
 *
 * FIVE, so the man is inside the rifle's eight from the first tick and enters
 * `engage` immediately — this suite is measuring the beat, and a fixture that
 * also had to walk him there would be measuring the approach.
 */
function contact(reactionTicks: number, kind = DEFAULT_ARCHETYPE_NAME): Rig {
  const r = rig(OPEN, { archetypes: table(reactionTicks) })
  if (kind === DEFAULT_ARCHETYPE_NAME) r.spawn(10, 5, 'enemy')
  else r.spawnKind(10, 5, 'enemy', kind)
  // Tough, so the firefight does not end with the first round that lands and
  // every assertion below is about the timer rather than about one man's life.
  r.spawn(5, 5, 'player', 10_000)
  return r
}

/** Ticks until the AI first issued a fire order, or `null` if it never did. */
function ticksToFirstOrder(r: Rig, limit: number): number | null {
  for (let t = 0; t < limit; t += 1) {
    r.run(1)
    if (r.spy.fires.length > 0) return t + 1
  }
  return null
}

describe('the beat before the first round', () => {
  it('holds fire for the archetype`s own count, then fires', () => {
    /**
     * Bounded on BOTH sides. A lower bound alone is satisfied by a man who never
     * fires at all — which is not a reaction delay, it is a broken enemy — and an
     * upper bound alone is satisfied by no delay whatsoever.
     *
     * The upper bound is loose by two ticks because the exact tick `engage` is
     * entered on is a detail of acquisition, not of this ticket. What must be
     * exact is that nothing is fired BEFORE the count.
     */
    const r = contact(45)
    const at = ticksToFirstOrder(r, 200)
    expect(at).not.toBeNull()
    expect(at ?? 0).toBeGreaterThanOrEqual(45)
    expect(at ?? 0).toBeLessThanOrEqual(47)
  })

  it('and the count is the one the table says, not a constant', () => {
    // Two different tables, two different beats. A hardcoded 45 in the state
    // machine would pass the case above perfectly and fail here.
    const quick = ticksToFirstOrder(contact(10), 200)
    const slow = ticksToFirstOrder(contact(90), 300)
    expect(quick ?? 0).toBeGreaterThanOrEqual(10)
    expect(quick ?? 0).toBeLessThanOrEqual(12)
    expect(slow ?? 0).toBeGreaterThanOrEqual(90)
    expect(slow ?? 0).toBeLessThanOrEqual(92)
  })

  it('a zero delay is today`s behaviour exactly, and that is the control', () => {
    /**
     * THE CONTROL THE WHOLE SUITE RESTS ON. Without it, a fixture that never
     * produced an engagement at all would satisfy every "did not fire before N
     * ticks" assertion above by firing NEVER — the same fixture-on-a-convenient-
     * value trap that has hidden four defects on this project.
     */
    const at = ticksToFirstOrder(contact(0), 50)
    expect(at).not.toBeNull()
    expect(at ?? 99).toBeLessThanOrEqual(2)
  })

  it('fires nothing at all while the beat runs', () => {
    // Stated on the whole spy rather than on its length at one instant: a
    // machine that ordered fire and immediately ceased would leave a count of
    // zero standing orders and a trail of calls saying otherwise.
    const r = contact(45)
    r.run(40)
    expect(r.spy.fires).toEqual([])
  })
})

describe('what the beat does NOT change', () => {
  it('he still halts the moment he engages', () => {
    /**
     * The halt on entering `engage` predates this ticket and is deliberate — a
     * man who keeps walking ends the engagement in knife range and wastes every
     * piece of cover the level contains. The delay gates `shootAt`; if it gated
     * the state machine instead, this is what would break.
     */
    const r = contact(45)
    r.run(3)
    expect(r.spy.halts.length).toBeGreaterThan(0)
    expect(r.spy.fires).toEqual([])
  })

  it('and he is in `engage` throughout, not parked in some other state', () => {
    // The beat is a man raising his rifle, not a man who has not noticed yet.
    // A machine that stayed in `pursue` until the timer expired would look the
    // same from outside and would walk him into the target instead.
    const r = contact(45)
    const enemy = r.world.entities.filter((e) => e.team === 'enemy')[0]
    expect(enemy).toBeDefined()
    r.run(5)
    expect(r.ai.stateOf(enemy?.id ?? 0)).toBe('engage')
    r.run(25)
    expect(r.ai.stateOf(enemy?.id ?? 0)).toBe('engage')
  })

  it('and he keeps his target the whole time', () => {
    // `targetOf` is gated on `engage`, so this is also a second reading of the
    // state above — and it is what the debug overlay draws a sightline from.
    const r = contact(45)
    const enemy = r.world.entities.filter((e) => e.team === 'enemy')[0]
    const player = r.world.entities.filter((e) => e.team === 'player')[0]
    r.run(20)
    expect(r.ai.targetOf(enemy?.id ?? 0)).toBe(player?.id)
  })
})

describe('`isReacting` is how anything else can see the beat', () => {
  /**
   * NOT `Entity.state`, and that is a decision rather than a preference. That
   * field has exactly one writer — `squad/system.ts` — and the squad system runs
   * AFTER the AI in `systemOrder`, so anything the AI wrote there would be
   * overwritten on the same tick, every tick, and the cue would never appear at
   * all. This is the accessor shape `stateOf` and `targetOf` already use for the
   * debug overlay, for the same reason: ask the system that owns the fact.
   */

  it('is true during the beat and false once he opens up', () => {
    const r = contact(45)
    const enemy = r.world.entities.filter((e) => e.team === 'enemy')[0]
    const id = enemy?.id ?? 0
    r.run(5)
    expect(r.ai.isReacting(id)).toBe(true)
    r.run(60)
    expect(r.ai.isReacting(id)).toBe(false)
  })

  it('is false for a man who is not engaging at all', () => {
    // An idle man is not "about to shoot"; a cue hung off a flag that were true
    // for everybody would light up the whole map.
    const r = rig(OPEN, { archetypes: table(45) })
    const lonely = r.spawn(10, 5, 'enemy')
    r.run(5)
    expect(r.ai.isReacting(lonely.id)).toBe(false)
  })

  it('is false for a unit this machine does not command, and for one that never existed', () => {
    // Matches `stateOf`/`targetOf`, which answer `undefined` for both. A boolean
    // cannot say "unknown", so the safe answer is the one that draws nothing.
    const r = contact(45)
    const player = r.world.entities.filter((e) => e.team === 'player')[0]
    r.run(5)
    expect(r.ai.isReacting(player?.id ?? 0)).toBe(false)
    expect(r.ai.isReacting(9999)).toBe(false)
  })

  it('agrees with the firing it describes, tick by tick', () => {
    /**
     * The two must not be able to drift: a flag that said "reacting" after the
     * rounds started would put an alerted cue over a man in a firefight for the
     * rest of the mission. Walked one tick at a time rather than sampled twice,
     * because a sample at two instants cannot see a flag that flickers.
     */
    const r = contact(45)
    const enemy = r.world.entities.filter((e) => e.team === 'enemy')[0]
    const id = enemy?.id ?? 0
    for (let t = 0; t < 80; t += 1) {
      r.run(1)
      const reacting = r.ai.isReacting(id)
      const hasFired = r.spy.fires.length > 0
      expect({ t, both: reacting && hasFired }).toEqual({ t, both: false })
    }
    expect(r.spy.fires.length).toBeGreaterThan(0)
  })
})

describe('the timer starts on ENTERING engage, not on picking a target', () => {
  it('a nearer attacker does not buy the first one another beat', () => {
    /**
     * THE DECISION THAT IS EASY TO GET BACKWARDS AND EXPENSIVE WHEN IT IS. A
     * timer reset on every re-aim means a man facing two attackers never fires
     * at all: he switches, waits, switches, waits, forever. A man who has been
     * in a firefight for a second is not surprised by his second opponent.
     *
     * THE SWITCH HAS TO HAPPEN WITHOUT LEAVING `engage`, which is the whole
     * point, and getting that fixture right took a probe. Killing the man he is
     * shooting at does NOT do it: the machine sends him to `idle` on the tick
     * his target dies — deliberately, since he watched it fall and there is
     * nothing left to look for — so he re-enters `engage` afresh and a new beat
     * is CORRECT there. What re-aims inside one engagement is a NEARER target
     * arriving, because acquisition takes the closest each tick. Measured: aim
     * switches and a fresh `orderFire` is issued with the state never leaving
     * `engage`.
     */
    const r = contact(30)
    const enemy = r.world.entities.filter((e) => e.team === 'enemy')[0]
    const id = enemy?.id ?? 0
    // Through the beat and into the firefight.
    r.run(60)
    const before = r.spy.fires.length
    expect(before).toBeGreaterThan(0)
    expect(r.ai.isReacting(id)).toBe(false)

    // Two tiles from him, so he is now the nearest and the aim moves.
    const nearer = r.spawn(8, 5, 'player', 10_000)
    r.run(6)
    expect(r.ai.stateOf(id)).toBe('engage')
    expect(r.ai.targetOf(id)).toBe(nearer.id)
    // Six ticks is a fifth of the thirty a fresh beat would cost.
    expect(r.ai.isReacting(id)).toBe(false)
    expect(r.spy.fires.length).toBeGreaterThan(before)
  })
})

describe('leaving engage costs him the beat again', () => {
  it('a man who loses his target behind cover waits afresh when it reappears', () => {
    /**
     * The other side of the rule above. He genuinely did lose the man — this is
     * a new engagement, not a re-aim inside one — so he pays for it again. A
     * timer that were never cleared would make every enemy in the mission
     * instant after his first contact, which is the bug this ticket exists to
     * remove arriving through the back door.
     *
     * THE WALL IS WHAT BREAKS SIGHT, NOT DISTANCE, and that is not a stylistic
     * choice. `OPEN` is twenty by ten, so from the middle of it NO tile is more
     * than about eleven tiles away — less than the twelve a rifleman sees. A
     * first draft tried to walk the target out of sight across open ground and
     * it never left his vision at all; the probe written to confirm the fixture
     * would have reported success on a test that proved nothing. `WALLED` has a
     * full-height wall at x=8 and is the only way to actually break the line.
     */
    const r = rig(WALLED, { archetypes: table(30) })
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(12, 5, 'player', 10_000)
    r.run(60)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    const fired = r.spy.fires.length
    expect(fired).toBeGreaterThan(0)

    // Behind the wall. He pursues the last-known position, then gives up.
    r.place(player.id, 3, 5)
    r.run(90)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')

    const before = r.spy.fires.length
    r.place(player.id, 12, 5)
    // Back in contact, and inside a fresh beat — measured at four ticks, which
    // is when the un-delayed machine had already fired again.
    r.run(4)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    expect(r.ai.isReacting(enemy.id)).toBe(true)
    expect(r.spy.fires.length).toBe(before)
    // And out the other side of it.
    r.run(40)
    expect(r.spy.fires.length).toBeGreaterThan(before)
  })
})

describe('the shipped tuning', () => {
  it('gives every archetype a reaction it can survive a JSON round trip with', () => {
    // The bargain ticket 018 states for this table: rows are data, so a later
    // ticket can read a garrison's profile straight out of `level.json`.
    expect(JSON.parse(JSON.stringify(ARCHETYPES))).toEqual(ARCHETYPES)
    for (const [name, spec] of Object.entries(ARCHETYPES)) {
      expect({ name, ok: Number.isInteger(spec.reactionTicks) }).toEqual({ name, ok: true })
      expect({ name, ok: spec.reactionTicks >= 0 }).toEqual({ name, ok: true })
    }
  })

  it('agrees with the fallback for the rifleman, as every other field does', () => {
    /**
     * `archetypes.test.ts` already pins the rifleman row to the system defaults,
     * deliberately: introducing per-unit stats must never retune a shipped level
     * by a tile on the way past. A new field has to join that promise or the row
     * and the fallback start disagreeing about a level nobody edited.
     */
    expect(ARCHETYPES[DEFAULT_ARCHETYPE_NAME]?.reactionTicks).toBe(DEFAULT_REACTION_TICKS)
  })

  it('gives the rifleman a beat a player can actually act inside', () => {
    // Under about a third of a second there is nothing to react to; much over a
    // second and the enemy is comic rather than deliberate.
    const rifleman = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]
    expect(rifleman?.reactionTicks ?? 0).toBeGreaterThanOrEqual(20)
    expect(rifleman?.reactionTicks ?? 0).toBeLessThanOrEqual(75)
  })

  it('lets the sniper off faster than the line infantryman', () => {
    /**
     * His whole advantage is the position he is already standing in, looking
     * down the sightline. A marksman who took LONGER to react than a conscript
     * would be a row that says the opposite of what ticket 018 placed him for.
     */
    const sniper = ARCHETYPES['sniper']
    const rifleman = ARCHETYPES[DEFAULT_ARCHETYPE_NAME]
    expect(sniper).toBeDefined()
    expect(sniper?.reactionTicks ?? 0).toBeLessThan(rifleman?.reactionTicks ?? 0)
  })

  it('and that difference is visible in play, not just in the table', () => {
    // Measured through the machine, because a table two rows apart that the
    // state machine reads from only one of would pass the assertion above.
    const riflemanAt = ticksToFirstOrder(contact(45), 200)
    const sniperAt = ticksToFirstOrder(contact(20), 200)
    expect(sniperAt ?? 0).toBeLessThan(riflemanAt ?? 0)
  })
})

describe('the beat is a tick count, so a mission still replays', () => {
  it('two runs of the same fixture are identical', () => {
    // No rng and no wall clock: `reactionTicks` advances on the sim's own tick
    // like every other timeout in `tuning.ts`.
    const pattern = (): string => {
      const r = contact(45)
      const marks: string[] = []
      for (let t = 0; t < 120; t += 1) {
        r.run(1)
        marks.push(r.spy.fires.length > 0 ? '1' : '0')
      }
      return marks.join('')
    }
    expect(pattern()).toBe(pattern())
  })
})
