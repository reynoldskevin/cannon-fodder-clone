import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'
import { ARCHETYPES, archetypeFor, DEFAULT_ARCHETYPE_NAME } from '../archetypes'
import { weaponForKind } from '../../combat'
import { DEFAULT_SIGHT_RANGE_TILES } from '../tuning'
import type { ArchetypeSpec } from '../archetypes'

/**
 * Ticket 018 — enemy variety, as a table.
 *
 * WHAT WAS WRONG BEFORE. `AiOptions` carries `sightRangeTiles`,
 * `alertRadiusTiles` and the two timeouts — ONE SET OF NUMBERS FOR EVERY ENEMY
 * ON THE MAP. A sniper and a conscript could not differ, because there was
 * nowhere to say how. This makes them per unit, resolved by `Entity.kind`, with
 * the existing options becoming the fallback an unknown kind gets.
 *
 * WHICH IS THE REGRESSION THAT MATTERS: level 1 spawns three plain `rifleman`
 * enemies and they must behave exactly as they do today. A table that changed
 * the default would retune a shipped level by accident.
 */

const spec = (over: Partial<ArchetypeSpec>): ArchetypeSpec => ({
  name: 'test-kind',
  sightRangeTiles: 6,
  alertRadiusTiles: 6,
  pursueTimeoutTicks: 120,
  alertTimeoutTicks: 120,
  aggression: 1,
  ...over,
})

describe('the table is a table', () => {
  it('has rows', () => {
    // Otherwise every invariant below is vacuously true.
    expect(Object.keys(ARCHETYPES).length).toBeGreaterThan(0)
  })

  it('every row is keyed by its own name', () => {
    for (const [key, row] of Object.entries(ARCHETYPES)) {
      expect({ key, name: row.name }).toEqual({ key, name: key })
    }
  })

  it('every row declares sane numbers', () => {
    for (const [key, row] of Object.entries(ARCHETYPES)) {
      expect({
        key,
        sight: row.sightRangeTiles > 0,
        alert: row.alertRadiusTiles > 0,
        pursue: Number.isInteger(row.pursueTimeoutTicks) && row.pursueTimeoutTicks > 0,
        alertT: Number.isInteger(row.alertTimeoutTicks) && row.alertTimeoutTicks > 0,
        aggression: row.aggression > 0,
      }).toEqual({ key, sight: true, alert: true, pursue: true, alertT: true, aggression: true })
    }
  })

  it('every row survives a JSON round-trip unchanged', () => {
    // SPECS ARE DATA, NOT BEHAVIOUR — the rule `combat/weapons.ts` states and
    // `ordnance/table.ts` repeats. A function or a getter here would vanish, and
    // with it any hope of loading archetypes from `level.json`.
    expect(JSON.parse(JSON.stringify(ARCHETYPES))).toEqual(ARCHETYPES)
  })

  it('every archetype names a kind that can actually hold a weapon', () => {
    /**
     * THE ANTI-DRIFT DEVICE, and the reason two tables are acceptable at all.
     *
     * AI stats live here; the weapon lives in `combat/weapons.ts`'s
     * `WEAPON_BY_KIND`, because `core/combat` is the lower layer and must not
     * depend upward on `core/ai`. Two tuning surfaces keyed by the same string
     * is duplication unless something forces them to agree — and an archetype
     * with no weapon row is a soldier who patrols, sees, alerts, pursues, and
     * cannot fire, which reads as a bug in the AI rather than a gap in a table.
     */
    for (const key of Object.keys(ARCHETYPES)) {
      expect({ key, armed: weaponForKind(key) !== null }).toEqual({ key, armed: true })
    }
  })

  it('includes the archetype every level spawns today', () => {
    expect(Object.keys(ARCHETYPES)).toContain(DEFAULT_ARCHETYPE_NAME)
  })

  it('ships more than one row, or "enemy variety" is theoretical', () => {
    // A table with a single row is a constant with extra steps. The criterion is
    // that the five levels can FEEL different without five sets of code, and
    // that is only demonstrated once a second archetype exists to differ from
    // the first.
    expect(Object.keys(ARCHETYPES).length).toBeGreaterThanOrEqual(2)
  })

  it('at least one shipped row differs from the plain defaults', () => {
    // Two rows that both restate `tuning.ts` are still one archetype wearing two
    // names. Something has to actually vary.
    const rows = Object.values(ARCHETYPES)
    expect(rows.some((r) => r.sightRangeTiles !== DEFAULT_SIGHT_RANGE_TILES)).toBe(true)
  })
})

describe('resolution', () => {
  it('finds a row by kind', () => {
    expect(archetypeFor(DEFAULT_ARCHETYPE_NAME)?.name).toBe(DEFAULT_ARCHETYPE_NAME)
  })

  it('answers undefined for a kind nothing has heard of', () => {
    // Not a thrown error and not a silent default: the CALLER decides what an
    // unknown kind falls back to, and here that is the system options.
    expect(archetypeFor('space-marine')).toBeUndefined()
  })

  it('the default archetype sees exactly as far as the old single setting did', () => {
    /**
     * THE REGRESSION GUARD FOR A SHIPPED LEVEL. Level 1's three enemies are
     * plain `rifleman`, and this ticket must not retune them by a tile. If the
     * table's row and `DEFAULT_SIGHT_RANGE_TILES` ever disagree, one of the two
     * is a decision nobody made.
     */
    expect(archetypeFor(DEFAULT_ARCHETYPE_NAME)?.sightRangeTiles).toBe(DEFAULT_SIGHT_RANGE_TILES)
  })
})

describe('the stats actually drive the machine', () => {
  it('a short-sighted archetype does not engage a man the default would', () => {
    /**
     * The point of the whole ticket, asserted through behaviour rather than
     * through a lookup: two enemies, same geometry, different rows, different
     * outcomes. A system that resolved the archetype and then used the system
     * default anyway would pass every table test above.
     */
    const r = rig(OPEN, { archetypes: { squinter: spec({ name: 'squinter', sightRangeTiles: 3 }) } })
    const enemy = r.spawnKind(2, 5, 'enemy', 'squinter')
    r.spawn(9, 5, 'player', 1000) // 7 tiles: inside the default 12, outside 3
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('and the default-sighted one does engage him', () => {
    // The control. Without it, an AI that never engaged anybody would satisfy
    // the case above.
    const r = rig(OPEN)
    const enemy = r.spawn(2, 5, 'enemy')
    r.spawn(9, 5, 'player', 1000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
  })

  it('a long-sighted archetype NOTICES a man from further than the default', () => {
    /**
     * ASSERTED ON SIGHT, NOT ON ENGAGEMENT, and the distinction is load-bearing.
     * Whether a man is SEEN is this ticket's business — it is the archetype's
     * `sightRangeTiles`. Whether he can then be SHOT is the rifle's, pinned by
     * `states.test.ts`'s "range is the rifle`s, not a number of its own" at eight
     * tiles. At fourteen tiles apart nothing can engage, whatever it can see, and
     * an archetype that could would be a second "how far can he shoot" — exactly
     * the drift `tuning.ts` exists to prevent.
     */
    const r = rig(OPEN, { archetypes: { hawk: spec({ name: 'hawk', sightRangeTiles: 18 }) } })
    const enemy = r.spawnKind(1, 5, 'enemy', 'hawk')
    r.spawn(15, 5, 'player', 1000) // 14 tiles: outside the default 12
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and the default-sighted one does not notice him at all', () => {
    // The control for the case above, and the half that proves the row was read:
    // same geometry, no archetype, and he stands there.
    const r = rig(OPEN)
    const enemy = r.spawn(1, 5, 'enemy')
    r.spawn(15, 5, 'player', 1000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })

  it('two archetypes on one map behave differently at the same instant', () => {
    // Enemy variety is the criterion, and variety means SIMULTANEOUS
    // difference. One-archetype-per-test could be satisfied by a global that
    // happened to be set correctly each time.
    const r = rig(OPEN, {
      archetypes: {
        squinter: spec({ name: 'squinter', sightRangeTiles: 3 }),
        hawk: spec({ name: 'hawk', sightRangeTiles: 18 }),
      },
    })
    const blind = r.spawnKind(2, 2, 'enemy', 'squinter')
    const sharp = r.spawnKind(2, 8, 'enemy', 'hawk')
    r.spawn(9, 5, 'player', 1000)
    r.run(10)
    expect({
      blind: r.ai.stateOf(blind.id) === 'idle',
      sharp: r.ai.stateOf(sharp.id) === 'idle',
    }).toEqual({ blind: true, sharp: false })
  })

  it('an unknown kind falls back to the system defaults', () => {
    // Which is what keeps every level authored before this ticket working. Sight
    // again, not engagement: an unarmed kind has no weapon range at all, so it
    // can notice a man and never shoot him — see the note above.
    const r = rig(OPEN)
    const enemy = r.spawnKind(2, 5, 'enemy', 'wandering-minstrel')
    r.spawn(9, 5, 'player', 1000) // 7 tiles: inside the default 12
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).not.toBe('idle')
  })

  it('and an unknown kind still cannot see past that default', () => {
    const r = rig(OPEN)
    const enemy = r.spawnKind(1, 5, 'enemy', 'wandering-minstrel')
    r.spawn(15, 5, 'player', 1000) // 14 tiles: outside it
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})

describe('an explicit option outranks the archetype row', () => {
  /**
   * THE PRECEDENCE, PINNED — explicit `AiOptions` value, then archetype row,
   * then `tuning.ts`.
   *
   * The rule was proposed by the implementer rather than by this ticket, and it
   * is the right one: an option is a statement about THIS session, a row is a
   * default for a KIND, and the specific instruction should win. Taking the
   * ticket's original wording literally would have broken the pre-existing
   * `states.test.ts` case that runs riflemen with `pursueTimeoutTicks: 30`.
   *
   * Only `pursueTimeoutTicks` was accidentally covered by that older test.
   * Adversarial review flipped the other three and the suite stayed green, so
   * the rule was documented in a comment and asserted nowhere — which is how the
   * ticket document and the code came to disagree with nothing adjudicating.
   */
  const seen = (r: ReturnType<typeof rig>, id: number): boolean => r.ai.stateOf(id) !== 'idle'

  it('for sight range', () => {
    // The row says he sees 18 tiles; the session says 3. At 7 tiles he must not
    // see the man, or the row won.
    const r = rig(OPEN, {
      sightRangeTiles: 3,
      archetypes: { hawk: spec({ name: 'hawk', sightRangeTiles: 18 }) },
    })
    const enemy = r.spawnKind(2, 5, 'enemy', 'hawk')
    r.spawn(9, 5, 'player', 1000)
    r.run(10)
    expect(seen(r, enemy.id)).toBe(false)
  })

  it('for alert radius', () => {
    // A shout carries the session's distance, not the row's. The enemy is 10
    // tiles from the shot: inside the row's 18, outside the session's 4.
    const r = rig(OPEN, {
      alertRadiusTiles: 4,
      archetypes: { hawk: spec({ name: 'hawk', alertRadiusTiles: 18, sightRangeTiles: 2 }) },
    })
    const enemy = r.spawnKind(2, 5, 'enemy', 'hawk')
    r.ai.hear([r.shotAt(12, 5)])
    r.run(5)
    expect(seen(r, enemy.id)).toBe(false)
  })

  it('and the row still decides when the session says nothing', () => {
    // The other half. Without it, "the option wins" is satisfied by an
    // implementation that ignores the row entirely.
    const r = rig(OPEN, { archetypes: { hawk: spec({ name: 'hawk', sightRangeTiles: 2 }) } })
    const enemy = r.spawnKind(2, 5, 'enemy', 'hawk')
    r.spawn(9, 5, 'player', 1000)
    r.run(10)
    expect(seen(r, enemy.id)).toBe(false)
  })
})

describe('adding an archetype is a table row', () => {
  it('a row invented at runtime drives the machine end to end', () => {
    /**
     * The criterion, tested the hard way. A test that edited the shipped
     * `ARCHETYPES` would prove nothing — the table sits in the same repository
     * as the code, so a row that happened to need a matching `if` somewhere
     * would still pass. What must be shown is that a row a caller invents, who
     * cannot touch a line of `src/core/ai`, is honoured.
     */
    const r = rig(OPEN, {
      archetypes: { 'jungle-scout': spec({ name: 'jungle-scout', sightRangeTiles: 2 }) },
    })
    const scout = r.spawnKind(2, 5, 'enemy', 'jungle-scout')
    r.spawn(6, 5, 'player', 1000) // 4 tiles: outside its 2, inside the default
    r.run(10)
    expect(r.ai.stateOf(scout.id)).toBe('idle')
    expect(Object.keys(ARCHETYPES)).not.toContain('jungle-scout')
  })

  it('the caller`s table REPLACES the shipped one rather than merging it', () => {
    // The mutant the case above cannot see: `{ ...ARCHETYPES, ...options }`
    // keeps it green while making "only a table row" true just for rows the
    // module already anticipated.
    /**
     * DISCRIMINATED THROUGH A SHIPPED ROW THAT DIFFERS FROM THE DEFAULTS, which
     * is the only thing that can tell the two apart.
     *
     * The obvious version of this test — supply a caller table, then spawn
     * `rifleman` — cannot work: `rifleman`'s row equals `tuning.ts` by design
     * (see the regression guard above), so "unknown, fell back to the default"
     * and "found the shipped row" produce identical behaviour. Setting an
     * explicit `sightRangeTiles` option instead does not help either, because an
     * explicit option outranks an archetype and would decide the outcome
     * whichever way the table resolved.
     *
     * So it uses the row that genuinely varies. Replaced: that kind is unknown to
     * this system, falls back to the default 12, and does not see a man 14 tiles
     * off. Merged: its own longer sight finds him.
     */
    const varied = Object.values(ARCHETYPES).find(
      (a) => a.sightRangeTiles > DEFAULT_SIGHT_RANGE_TILES,
    )
    expect(varied).toBeDefined()
    const r = rig(OPEN, {
      archetypes: { 'jungle-scout': spec({ name: 'jungle-scout', sightRangeTiles: 2 }) },
    })
    const enemy = r.spawnKind(1, 5, 'enemy', varied?.name ?? '')
    r.spawn(15, 5, 'player', 1000) // 14 tiles
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})
