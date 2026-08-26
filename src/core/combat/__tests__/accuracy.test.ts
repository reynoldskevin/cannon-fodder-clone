import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { makeLevel } from '../../world/__tests__/fixture'
import { WEAPONS, RIFLE, INFANTRY_HEALTH, hitChanceAt, createCombatSystem } from '../index'
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

const world = (seed = 1): World => arena(seed).world

const rifle = (): WeaponSpec => {
  const spec = WEAPONS[RIFLE]
  if (spec === undefined) throw new Error('no rifle')
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
    // A non-finite distance is a corrupted position, and the safe answer is the
    // one that does not make a unit unhittable from anywhere.
    expect(Number.isFinite(hitChanceAt(spec, NaN))).toBe(true)
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
    const { shots } = duel({ hitPolicy: 'weapon', gap: rifle().rangeTiles - 0.1, ticks: 3000 })
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
    const gap = rifle().rangeTiles - 0.1
    const { shots } = duel({ hitPolicy: 'weapon', gap, ticks: 12_000 })
    const expected = hitChanceAt(rifle(), gap)
    const observed = hits(shots) / shots.length
    expect(shots.length).toBeGreaterThan(300)
    expect(Math.abs(observed - expected)).toBeLessThan(0.1)
  })

  it('and the near end of the curve really is more reliable than the far end', () => {
    // Measured rather than asserted from the table: this is the claim a player
    // would make, and it goes through the roll rather than around it.
    const far = rifle().rangeTiles - 0.1
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
    const { shots } = duel({ hitPolicy: 'weapon', gap: rifle().rangeTiles - 0.1, ticks: 3000 })
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
      const run = duel({ hitPolicy: policy, gap: rifle().rangeTiles - 0.1, ticks: 3000 })
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
