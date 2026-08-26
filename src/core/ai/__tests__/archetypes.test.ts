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

  it('a long-sighted archetype engages from further than the default', () => {
    const r = rig(OPEN, { archetypes: { hawk: spec({ name: 'hawk', sightRangeTiles: 18 }) } })
    const enemy = r.spawnKind(1, 5, 'enemy', 'hawk')
    r.spawn(15, 5, 'player', 1000) // 14 tiles: outside the default 12
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
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
    expect({ blind: r.ai.stateOf(blind.id), sharp: r.ai.stateOf(sharp.id) }).toEqual({
      blind: 'idle',
      sharp: 'engage',
    })
  })

  it('an unknown kind falls back to the system defaults', () => {
    // Which is what keeps every level authored before this ticket working.
    const r = rig(OPEN)
    const enemy = r.spawnKind(2, 5, 'enemy', 'wandering-minstrel')
    r.spawn(9, 5, 'player', 1000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
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
     * The system default is deliberately set to 3 here, DIFFERENT from the
     * shipped `rifleman` row's 12. Without that difference the case cannot
     * discriminate at all: the shipped row and the default agree by design (see
     * the regression guard above), so a merged table and a replaced one would
     * both engage and the test would be decoration.
     *
     * Replaced: `rifleman` is unknown to this system → system default 3 → a man
     * 4 tiles away is not seen. Merged: `rifleman` resolves to the shipped row's
     * 12 → he is.
     */
    const shipped = Object.keys(ARCHETYPES)[0]
    expect(shipped).toBeDefined()
    const r = rig(OPEN, {
      sightRangeTiles: 3,
      archetypes: { 'jungle-scout': spec({ name: 'jungle-scout', sightRangeTiles: 2 }) },
    })
    const enemy = r.spawnKind(2, 5, 'enemy', shipped ?? '')
    r.spawn(6, 5, 'player', 1000)
    r.run(10)
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
  })
})
