import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { makeLevel } from '../../world/__tests__/fixture'
import {
  WEAPONS,
  RIFLE,
  INFANTRY_HEALTH,
  hitChanceAt,
  createCombatSystem,
  weaponFor,
} from '../index'
import { bakeNavGrid } from '../../pathing/navgrid'
import type { WeaponSpec } from '../index'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 011b — a shot is a chance, not a certainty.
 *
 * PLAYING THE GAME FOUND THIS, AND IT IS NOT A BALANCE NUMBER. `resolution.ts`
 * checks team, range and line of sight, and if all three pass the round lands.
 * With `INFANTRY_HEALTH = 1` that makes any sightline an execution: an enemy who
 * reaches eight tiles kills a man every 32 ticks with certainty, and no cover,
 * no manoeuvre and no reaction changes the outcome. The complaint was never that
 * men die too easily — it is that they die INEVITABLY, and those are different
 * problems. Health stays at 1.
 *
 * CERTAINTY REMAINS THE DEFAULT, and that is the rule that makes this ticket one
 * ticket. Twenty-three test files and a hundred and thirty-odd assertion sites
 * depend on a round that lands; a rifle that became probabilistic for everyone
 * would put all of them in play at once. So the roll is POLICY —
 * `CombatOptions.hitPolicy` — exactly as `autoEngageTeams` is, and for the same
 * reason: ticket 011's contract is untouched, and the session is what changes
 * its mind about the game it is running.
 */

const level = () => makeLevel()

/**
 * A world and the nav grid its sightlines are walked on.
 *
 * BAKED FROM THE SAME LEVEL DOCUMENT, and passed in, because that is what every
 * caller of `createCombatSystem` in this codebase does — `createSession`, the AI
 * rig, `aim.test.ts`. An earlier draft of this suite built combat with no grid
 * at all, which forced an overload and a documented wart into production code to
 * serve one test's convenience. A fixture is not a reason to widen an API.
 */
function arena(seed = 1): { world: World; grid: ReturnType<typeof bakeNavGrid> } {
  const doc = level()
  return { world: new World(doc, { seed }), grid: bakeNavGrid(doc) }
}

const rifle = (): WeaponSpec => {
  const spec = WEAPONS[RIFLE]
  if (spec === undefined) throw new Error('no rifle')
  return spec
}

/**
 * The weapon `duel()`'s shooter ACTUALLY HOLDS.
 *
 * That fixture spawns him on the ENEMY team, and since ticket 036 the two teams
 * carry different rows — so `rifle()`, which is the squad's, stopped describing
 * this suite's own shooter. Every gap below is derived from his real reach.
 *
 * NOT A COSMETIC RENAME. A gap taken from the player's eight-tile row puts the
 * sandbag 1.5 tiles beyond the enemy's 6.4, and `inRange` then refuses every
 * round: the sample comes back EMPTY and every rate below divides by zero. The
 * failure looks like "the roll broke", which is why the shooter's own weapon is
 * named rather than assumed.
 */
const duellist = (): WeaponSpec => {
  const spec = weaponFor('rifleman', 'enemy')
  if (spec === null) throw new Error('no enemy rifle')
  return spec
}

/** A weapon that always hits, for isolating everything that is not the roll. */
const certain = (over: Partial<WeaponSpec> = {}): WeaponSpec => ({
  ...rifle(),
  accuracy: { pointBlank: 1, maxRange: 1 },
  ...over,
})

describe('the accuracy curve', () => {
  it('is the weapon`s own number at point-blank and at maximum range', () => {
    const spec = certain({ accuracy: { pointBlank: 0.8, maxRange: 0.2 } })
    expect(hitChanceAt(spec, 0)).toBeCloseTo(0.8, 10)
    expect(hitChanceAt(spec, spec.rangeTiles)).toBeCloseTo(0.2, 10)
  })

  it('falls off linearly between them', () => {
    // Linear because nothing yet argues for a curve. Asserted at the midpoint
    // AND at a quarter, because a midpoint alone is satisfied by any symmetric
    // curve through the same two endpoints.
    const spec = certain({ accuracy: { pointBlank: 1, maxRange: 0 } })
    expect(hitChanceAt(spec, spec.rangeTiles / 2)).toBeCloseTo(0.5, 10)
    expect(hitChanceAt(spec, spec.rangeTiles / 4)).toBeCloseTo(0.75, 10)
  })

  it('clamps past maximum range rather than going negative', () => {
    /**
     * A round is refused beyond `rangeTiles` by `inRange`, so this is a value
     * nothing should ask for — but an unclamped extrapolation returns a negative
     * chance, and a negative chance compared against a `[0,1)` draw is a shot
     * that can never land, which would read as a weapon that silently stopped
     * working at the edge of its envelope.
     */
    const spec = certain({ accuracy: { pointBlank: 1, maxRange: 0.2 } })
    expect(hitChanceAt(spec, spec.rangeTiles * 3)).toBeGreaterThanOrEqual(0)
    expect(hitChanceAt(spec, spec.rangeTiles * 3)).toBeCloseTo(0.2, 10)
  })

  it('clamps behind point-blank too, and survives a nonsense distance', () => {
    const spec = certain({ accuracy: { pointBlank: 0.9, maxRange: 0.25 } })
    expect(hitChanceAt(spec, -5)).toBeCloseTo(0.9, 10)
    /**
     * A non-finite distance is a corrupted position, and the safe answer is the
     * one that does not make a unit unhittable from anywhere.
     *
     * PINNED TO AN END, not merely to being finite. `maxRange` is finite too, so
     * a finiteness check alone is satisfied by a guard that sends NaN to the FAR
     * end — the opposite of what the comment on the production side claims, and
     * a silently different weapon for anybody standing at a corrupted position.
     */
    expect(hitChanceAt(spec, NaN)).toBeCloseTo(spec.accuracy.pointBlank, 10)
  })

  it('reproduces today`s game exactly when both ends are 1', () => {
    // The property the default rests on: an all-ones curve is not "very likely",
    // it is certain, at every distance including the boundary.
    const spec = certain()
    for (const d of [0, 1, 4, spec.rangeTiles - 0.001, spec.rangeTiles]) {
      expect({ d, chance: hitChanceAt(spec, d) }).toEqual({ d, chance: 1 })
    }
  })
})

describe('the rifle is tuned to be survivable at distance and lethal up close', () => {
  it('carries an accuracy that falls off', () => {
    const spec = rifle()
    expect(spec.accuracy.pointBlank).toBeGreaterThan(spec.accuracy.maxRange)
  })

  it('is worth closing on, and worth backing away from', () => {
    /**
     * The play claim, as numbers: a man at the edge of the envelope must be
     * MATERIALLY safer than one at point-blank, or the curve is decoration. Half
     * is the line — below that, retreating out to maximum range is not a real
     * option and the player is back to trading certain deaths.
     */
    const spec = rifle()
    expect(hitChanceAt(spec, spec.rangeTiles)).toBeLessThan(
      hitChanceAt(spec, 0) / 2,
    )
  })

  it('still kills reliably at point-blank', () => {
    // The other guard rail. An enemy who has walked into your squad's faces
    // should be lethal; a rifle that missed half its shots at one tile would
    // make firefights comic and `kill_all` missions interminable.
    expect(hitChanceAt(rifle(), 0)).toBeGreaterThanOrEqual(0.75)
  })

  it('never promises a chance outside [0, 1] anywhere in its envelope', () => {
    const spec = rifle()
    for (let d = 0; d <= spec.rangeTiles; d += 0.25) {
      const chance = hitChanceAt(spec, d)
      expect({ d, ok: chance >= 0 && chance <= 1 }).toEqual({ d, ok: true })
    }
  })

  it('is data, not behaviour, like every other spec in this file', () => {
    // The bargain `weapons.ts` states: a spec must survive a JSON round trip, so
    // a later ticket can read weapon tables out of a level document.
    expect(JSON.parse(JSON.stringify(WEAPONS))).toEqual(WEAPONS)
  })

  it('leaves infantry health alone', () => {
    // Stated as an assertion because it is the thing most likely to be "fixed"
    // by somebody solving the difficulty complaint the other way.
    expect(INFANTRY_HEALTH).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The policy seam
// ---------------------------------------------------------------------------

/** Put two enemies in each other's faces and run `ticks` of combat. */
function duel(options: {
  readonly hitPolicy?: 'certain' | 'weapon'
  readonly seed?: number
  readonly ticks?: number
  readonly gap?: number
}): { readonly shots: readonly SimEvent[]; readonly world: World } {
  const { world: w, grid } = arena(options.seed ?? 1)
  w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
  /**
   * A target that cannot die and cannot shoot back.
   *
   * TOUGH, so a long sample measures the ROLL rather than the length of one
   * man's life — `INFANTRY_HEALTH` is 1 and this suite must not change that, and
   * a high-health entity is the extension point `weapons.ts` names for exactly
   * this. UNARMED, because `WEAPON_BY_KIND` arms no kind it has not heard of and
   * a target returning fire would put its own rounds in a count that is supposed
   * to be about one shooter.
   */
  w.spawn({ kind: 'sandbag', team: 'player', x: options.gap ?? 0.5, z: 0, health: 10_000 })
  const combat = createCombatSystem(
    grid,
    options.hitPolicy === undefined ? {} : { hitPolicy: options.hitPolicy },
  )
  w.addSystem(combat)
  // No `orderFire`: `autoEngageTeams` defaults to both teams, which is ticket
  // 011's own behaviour and the thing this suite is measuring against.
  const shots: SimEvent[] = []
  for (let t = 0; t < (options.ticks ?? 600); t += 1) {
    w.tick()
    for (const event of w.drainEvents()) if (event.type === 'ShotFired') shots.push(event)
  }
  return { shots, world: w }
}

const hits = (shots: readonly SimEvent[]): number =>
  shots.filter((s) => s.type === 'ShotFired' && s.hit).length

describe('the roll is policy, and certainty is the default', () => {
  it('a combat system built with no options never misses', () => {
    /**
     * THE ASSERTION 419 EXISTING TESTS REST ON. Every one of them constructs
     * combat without a `hitPolicy` and asserts a death, a health drop or a
     * count; if the default ever became probabilistic they would fail in a
     * scatter that would look like flakiness rather than like a decision.
     */
    const { shots } = duel({})
    expect(shots.length).toBeGreaterThan(10)
    expect(hits(shots)).toBe(shots.length)
  })

  it('and `certain` says the same thing out loud', () => {
    const { shots } = duel({ hitPolicy: 'certain' })
    expect(hits(shots)).toBe(shots.length)
  })

  it('`weapon` rolls, so some rounds miss', () => {
    // At point-blank the rifle is deliberately reliable, so the sample is taken
    // at distance where the curve actually bites.
    const { shots } = duel({ hitPolicy: 'weapon', gap: duellist().rangeTiles - 0.1, ticks: 3000 })
    expect(shots.length).toBeGreaterThan(20)
    expect(hits(shots)).toBeLessThan(shots.length)
    expect(hits(shots)).toBeGreaterThan(0)
  })

  it('and lands close to the curve`s own number over a long sample', () => {
    /**
     * The roll must be USING the chance, not merely being random. A coin flip
     * would pass "some miss, some hit" at any tuning whatsoever; this pins the
     * observed rate to what `hitChanceAt` promises at that distance.
     *
     * The tolerance is wide on purpose — this is a finite sample from a seeded
     * stream, and a tight bound would be a test that fails when somebody retunes
     * the rifle by a hundredth. It is still far tighter than the gap between the
     * near and far ends of the curve, which is what it needs to distinguish.
     */
    const gap = duellist().rangeTiles - 0.1
    /**
     * TWENTY THOUSAND TICKS, NOT TWELVE. The floor of 300 rounds below is what
     * makes the 0.1 tolerance meaningful — it is a sample size, not a duration —
     * and ticket 036 slowed this shooter from a 32-tick cooldown to 52, which
     * turned the same window into 231 rounds. Lowering the floor instead would
     * have loosened the very bound this test exists to hold.
     */
    const { shots } = duel({ hitPolicy: 'weapon', gap, ticks: 20_000 })
    const expected = hitChanceAt(duellist(), gap)
    const observed = hits(shots) / shots.length
    expect(shots.length).toBeGreaterThan(300)
    expect(Math.abs(observed - expected)).toBeLessThan(0.1)
  })

  it('and the near end of the curve really is more reliable than the far end', () => {
    // Measured rather than asserted from the table: this is the claim a player
    // would make, and it goes through the roll rather than around it.
    const far = duellist().rangeTiles - 0.1
    const near = duel({ hitPolicy: 'weapon', gap: 0.5, ticks: 6000 })
    const away = duel({ hitPolicy: 'weapon', gap: far, ticks: 6000 })
    const rate = (r: { shots: readonly SimEvent[] }): number => hits(r.shots) / r.shots.length
    expect(rate(near)).toBeGreaterThan(rate(away) + 0.2)
  })
})

describe('a miss is an event, not a nothing', () => {
  it('still emits ShotFired', () => {
    /**
     * The muzzle flash, the report, the tracer and every enemy's reaction to
     * being shot at all hang off this event. A miss that emitted nothing would
     * be a soldier silently not shooting, and the level would stop reacting to
     * a firefight the moment the rounds started going wide.
     */
    const { shots } = duel({ hitPolicy: 'weapon', gap: duellist().rangeTiles - 0.1, ticks: 3000 })
    const missed = shots.filter((s) => s.type === 'ShotFired' && !s.hit)
    expect(missed.length).toBeGreaterThan(0)
    for (const shot of missed) {
      expect(shot.type).toBe('ShotFired')
    }
  })

  it('carries `hit` on every shot, from every producer', () => {
    // Required rather than optional: an absent flag read by a truthiness check
    // is a miss, so a producer that forgot it would silently make its weapon
    // useless. The compiler is the mechanism; this is the runtime half.
    const { shots } = duel({ hitPolicy: 'weapon', ticks: 600 })
    expect(shots.length).toBeGreaterThan(0)
    for (const shot of shots) {
      if (shot.type !== 'ShotFired') continue
      expect(typeof shot.hit).toBe('boolean')
    }
  })

  it('does no damage, and a hit does', () => {
    // The whole point, stated at the bottom of the stack. Two runs at seeds
    // chosen to differ, compared by the health actually removed.
    const shooter = (policy: 'certain' | 'weapon'): number => {
      const run = duel({ hitPolicy: policy, gap: duellist().rangeTiles - 0.1, ticks: 3000 })
      const target = run.world.entities.find((e) => e.team === 'player')
      return 10_000 - (target?.health ?? 0)
    }
    const certainDamage = shooter('certain')
    const rolledDamage = shooter('weapon')
    expect(certainDamage).toBeGreaterThan(0)
    expect(rolledDamage).toBeLessThan(certainDamage)
  })
})

describe('the roll is deterministic, because a mission must replay', () => {
  it('the same seed and the same script produce the same shots', () => {
    const run = (): string =>
      duel({ hitPolicy: 'weapon', seed: 7, gap: 6, ticks: 1200 })
        .shots.map((s) => (s.type === 'ShotFired' && s.hit ? '1' : '0'))
        .join('')
    expect(run()).toBe(run())
  })

  it('and a DIFFERENT seed produces different ones', () => {
    /**
     * THE HALF THAT IS EASY TO LEAVE OUT AND IS THE ONE THAT MATTERS. Without
     * it, a roll that ignored `world.rng` entirely — a hardcoded pattern, a
     * counter, a hash of the tick — would satisfy the test above perfectly.
     */
    const pattern = (seed: number): string =>
      duel({ hitPolicy: 'weapon', seed, gap: 6, ticks: 1200 })
        .shots.map((s) => (s.type === 'ShotFired' && s.hit ? '1' : '0'))
        .join('')
    expect(pattern(7)).not.toBe(pattern(8))
  })

  it('the state hash agrees, which is the sim`s own answer', () => {
    const run = (seed: number): string => {
      const { world: w } = duel({ hitPolicy: 'weapon', seed, gap: 6, ticks: 1200 })
      return String(w.stateHash())
    }
    expect(run(3)).toBe(run(3))
    expect(run(3)).not.toBe(run(4))
  })

  it('draws nothing on a tick where no round is fired', () => {
    /**
     * THE ORDERING CONTRACT. A draw on a quiet tick advances the stream and
     * desynchronises every subsequent shot in the mission — and it would be
     * invisible until two replays of the same seed diverged minutes apart.
     *
     * Measured through the rng itself: run a world with combat installed and
     * nobody firing, and the next value drawn must be the one a world that never
     * had combat would have drawn.
     */
    const idle = (withCombat: boolean): number => {
      const { world: w, grid } = arena(11)
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      w.spawn({ kind: 'sandbag', team: 'player', x: 30, z: 30, health: 10_000 })
      if (withCombat) w.addSystem(createCombatSystem(grid, { hitPolicy: 'weapon' }))
      for (let t = 0; t < 400; t += 1) w.tick()
      return w.rng.next()
    }
    // Thirty tiles apart, so nothing is ever in range and no shot is resolved.
    expect(idle(true)).toBe(idle(false))
  })
})

describe('the paths that must spend no draw at all', () => {
  /**
   * THE LOUDEST CLAIM THIS TICKET MAKES, AND IT WAS THE LEAST PINNED. An
   * adversarial review inserted a draw on the `'certain'` path and the entire
   * suite of 1771 tests still passed — because the one rng-ordering test above
   * runs at `hitPolicy: 'weapon'` with nothing in range, so it never enters the
   * certain branch at all.
   *
   * What that costs: a later refactor to `const roll = world.rng.next(); hit =
   * hitPolicy === 'certain' || roll < chance` reads as a tidy-up, keeps all 419
   * pre-existing tests green (the round still lands), and quietly consumes one
   * draw per shot in every certain mission. Everything downstream of the stream
   * shifts, and it surfaces as a saved seed replaying differently with the suite
   * fully green.
   */

  /** The next value the rng would hand out after `ticks` of this arrangement. */
  function streamAfter(build: (w: World, grid: ReturnType<typeof bakeNavGrid>) => void): number {
    const { world: w, grid } = arena(11)
    build(w, grid)
    for (let t = 0; t < 400; t += 1) w.tick()
    return w.rng.next()
  }

  const untouched = (): number =>
    streamAfter((w) => {
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      w.spawn({ kind: 'sandbag', team: 'player', x: 0.5, z: 0, health: 10_000 })
    })

  it('`certain` fires a great many rounds and draws nothing', () => {
    // Half a tile apart, so this is a continuous firefight for four hundred
    // ticks — not the quiet world the ordering test above uses. If `'certain'`
    // draws even once per shot, the stream has moved.
    const withCertainCombat = streamAfter((w, grid) => {
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      w.spawn({ kind: 'sandbag', team: 'player', x: 0.5, z: 0, health: 10_000 })
      w.addSystem(createCombatSystem(grid, { hitPolicy: 'certain' }))
    })
    expect(withCertainCombat).toBe(untouched())
  })

  it('and the default does the same, because the default IS certain', () => {
    const withDefaultCombat = streamAfter((w, grid) => {
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      w.spawn({ kind: 'sandbag', team: 'player', x: 0.5, z: 0, health: 10_000 })
      w.addSystem(createCombatSystem(grid))
    })
    expect(withDefaultCombat).toBe(untouched())
  })

  it('a firefight under `weapon` DOES move the stream, so the test above means something', () => {
    /**
     * The control. Without it, a `streamAfter` that silently failed to produce a
     * firefight at all would satisfy both assertions above perfectly — which is
     * the same fixture-on-a-convenient-value trap that has hidden four defects
     * in this project already.
     */
    const withRolling = streamAfter((w, grid) => {
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      w.spawn({ kind: 'sandbag', team: 'player', x: 0.5, z: 0, health: 10_000 })
      w.addSystem(createCombatSystem(grid, { hitPolicy: 'weapon' }))
    })
    expect(withRolling).not.toBe(untouched())
  })
})

describe('suppressing fire hits nothing, and costs no draw', () => {
  /**
   * A ROUND AIMED AT GROUND. `orderFire` takes a TILE, not a unit, and ticket
   * 011a's whole point is that a click on empty grass is suppressing fire rather
   * than a free kill on whoever is nearest. `ShotFired.targetId` is `null` for
   * those, and there is nothing for the round to hit.
   *
   * Neither new suite exercised this until a review pointed it out: `duel` leans
   * on `autoEngageTeams` defaulting to both teams, so `targetId` was non-null on
   * every shot in the entire acceptance suite. The mutant that survived —
   * `hit = true` for a suppressing round — is wrong twice over: the event lies
   * about a round that hit nothing, AND the round starts spending a draw, which
   * is the desync the tests above guard arriving through a second door.
   */

  /** Order one man to fire at bare ground and collect what comes out. */
  function suppress(hitPolicy: 'certain' | 'weapon'): {
    readonly shots: readonly SimEvent[]
    readonly nextRoll: number
  } {
    const { world: w, grid } = arena(11)
    const shooter = w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
    const combat = createCombatSystem(grid, { hitPolicy, autoEngageTeams: [] })
    w.addSystem(combat)
    // Two tiles away on empty ground, with nobody else in the world at all.
    combat.orderFire([shooter.id], { x: 2, y: 0 })
    const shots: SimEvent[] = []
    for (let t = 0; t < 400; t += 1) {
      w.tick()
      for (const event of w.drainEvents()) if (event.type === 'ShotFired') shots.push(event)
    }
    return { shots, nextRoll: w.rng.next() }
  }

  it('fires at the ground it was pointed at', () => {
    const { shots } = suppress('weapon')
    expect(shots.length).toBeGreaterThan(5)
    for (const shot of shots) {
      if (shot.type !== 'ShotFired') continue
      expect(shot.targetId).toBeNull()
    }
  })

  it('and every one of those rounds reports `hit: false`', () => {
    // Ticket 025 puts the impact where the round actually went; a suppressing
    // round claiming a hit would put it in a man's chest instead.
    for (const policy of ['certain', 'weapon'] as const) {
      const { shots } = suppress(policy)
      const claimed = shots.filter((s) => s.type === 'ShotFired' && s.hit).length
      expect({ policy, claimed }).toEqual({ policy, claimed: 0 })
    }
  })

  it('and spends no draw doing it, under either policy', () => {
    const quiet = (): number => {
      const { world: w } = arena(11)
      w.spawn({ kind: 'rifleman', team: 'enemy', x: 0, z: 0 })
      for (let t = 0; t < 400; t += 1) w.tick()
      return w.rng.next()
    }
    expect(suppress('certain').nextRoll).toBe(quiet())
    expect(suppress('weapon').nextRoll).toBe(quiet())
  })
})
