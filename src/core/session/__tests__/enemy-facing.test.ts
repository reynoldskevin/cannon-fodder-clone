import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'
import { DEFAULT_ENEMY_FACING } from '../../ai/tuning'
import type { RenderEntity } from '../../render-state/entity'

/**
 * Ticket 038 — the blind arc has to be VISIBLE, or it is not stealth.
 *
 * THIS IS THE CRITERION THAT DECIDES WHETHER THE WHOLE TICKET IS PLAYABLE, and
 * it is the one most easily left out, because everything else in 038 can be
 * green while the game is unplayable.
 *
 * `renderEntities` derives a sprite facing from MOVEMENT — where a unit went
 * since the last frame — with `stableFacing` downstream smoothing it and a
 * stationary man keeping whatever he last had. After this ticket an enemy has a
 * facing in the SIMULATION that decides what he can see, and the two can
 * disagree: a man drawn looking east while watching south. A blind arc the
 * player cannot see is not a mechanic, it is an invisible rule that kills them.
 *
 * So for an enemy the sim's facing IS what gets drawn.
 */

const SOLDIER = 'soldier'

/** The one enemy in these fixtures, as the renderer sees it. */
const enemyOf = (drawn: readonly RenderEntity[], id: number): RenderEntity => {
  const found = drawn.find((e) => e.unit === SOLDIER && e.id === id)
  if (found === undefined) throw new Error('enemy not drawn')
  return found
}

/** Angle between what is drawn and a direction, in degrees. */
const angleOf = (e: RenderEntity, dx: number, dz: number): number => {
  const length = Math.hypot(e.dx, e.dz) * Math.hypot(dx, dz)
  if (length === 0) return 180
  const dot = (e.dx * dx + e.dz * dz) / length
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
}

const enemyId = (s: ReturnType<typeof createSession>): number => {
  const found = s.world.entities.find((e) => e.team === 'enemy')
  if (found === undefined) throw new Error('no enemy')
  return found.id
}

describe('an enemy is drawn facing where he is actually watching', () => {
  it('a man who has not moved is drawn facing the default, not facing nowhere', () => {
    /**
     * The frames before anything happens, which is most of a mission for most of
     * a garrison. `dx`/`dz` of `(0, 0)` means "unchanged" to the renderer, so a
     * stationary enemy would inherit whatever `stableFacing` last had — for a man
     * who has never moved, the renderer's own `DEFAULT_FACING`, which has no
     * reason to agree with the arc the sim is using.
     */
    const s = createSession(makeLevel({ avatars: [{ x: 2, y: 2 }], enemies: [{ x: 10, y: 5 }] }))
    s.advance(1 / 60)
    const drawn = enemyOf(s.renderEntities(FLAT), enemyId(s))
    expect(angleOf(drawn, DEFAULT_ENEMY_FACING.dx, DEFAULT_ENEMY_FACING.dz)).toBeLessThan(1)
  })

  it('and matches the AI`s own facing once he has something to look at', () => {
    /**
     * Compared against the AI rather than against a compass direction, because
     * the claim is AGREEMENT — a renderer that computed a perfectly sensible
     * facing of its own would pass any test that only checked the drawn value
     * was reasonable, and would still leave the sprite and the arc disagreeing.
     */
    const s = createSession(
      makeLevel({ avatars: [{ x: 12, y: 9 }], enemies: [{ x: 10, y: 3 }] }),
    )
    for (let i = 0; i < 90; i += 1) s.advance(1 / 60)
    const id = enemyId(s)
    const mind = s.ai.facingOf(id)
    expect(mind).toBeDefined()
    const drawn = enemyOf(s.renderEntities(FLAT), id)
    expect(angleOf(drawn, mind!.dx, mind!.dz)).toBeLessThan(1)
  })

  it('and keeps agreeing with it while he stands still', () => {
    // The stationary case is where the two most easily drift: the renderer has
    // nothing to derive from, and the sim still has an opinion.
    const s = createSession(
      makeLevel({ avatars: [{ x: 12, y: 9 }], enemies: [{ x: 10, y: 3 }] }),
    )
    for (let i = 0; i < 200; i += 1) s.advance(1 / 60)
    const id = enemyId(s)
    for (let i = 0; i < 5; i += 1) {
      s.advance(1 / 60)
      const mind = s.ai.facingOf(id)!
      expect(angleOf(enemyOf(s.renderEntities(FLAT), id), mind.dx, mind.dz)).toBeLessThan(1)
    }
  })

  it('and what is drawn is a unit vector, like every other facing on the wire', () => {
    const s = createSession(makeLevel({ avatars: [{ x: 2, y: 2 }], enemies: [{ x: 10, y: 5 }] }))
    s.advance(1 / 60)
    const drawn = enemyOf(s.renderEntities(FLAT), enemyId(s))
    expect(Math.hypot(drawn.dx, drawn.dz)).toBeCloseTo(1, 6)
  })
})

describe('the player`s own squad is untouched by any of it', () => {
  it('a player unit still takes its facing from movement and aim', () => {
    /**
     * The AI holds no facing for a player unit — it holds no state for one at
     * all — so nothing here may reach into `renderEntities` and blank the
     * squad's direction. Ticket 010's aim-facing behaviour is a separate
     * contract with its own suite (`aim-facing.test.ts`); this only has to prove
     * that 038 did not quietly take it over.
     */
    const level = makeLevel({
      avatars: [{ x: 4, y: 9 }],
      enemies: [{ x: 18, y: 1 }],
    })
    const s = createSession(level)
    const mine = s.world.entities.find((e) => e.team === 'player')!
    s.queue.push({ type: 'move', unitIds: [mine.id], target: { x: 4, y: 2 } })
    for (let i = 0; i < 60; i += 1) s.advance(1 / 60)
    const drawn = enemyOf(s.renderEntities(FLAT), mine.id)
    // He was ordered NORTH and is walking; the drawn facing must follow him and
    // must not be the enemies' southward default.
    expect(drawn.dz).toBeLessThan(0)
  })
})

describe('an authored facing is honoured, whatever spelling the level used', () => {
  /**
   * `core/level` validates `facing` only as a non-empty STRING, and
   * `schema.test.ts` pins `'south'` as a value a level may carry — while
   * `FACING_VECTORS` is keyed `N`, `NE`, `E`... and `facingVector` returns
   * `undefined` for anything else. Before this ticket that mismatch cost a
   * sprite its starting pose. Now it decides what a guard can SEE, silently, and
   * the level author gets a garrison looking the wrong way with nothing to say
   * so.
   *
   * Both spellings must work, or the vocabulary the schema accepts and the
   * vocabulary the game understands are two different vocabularies.
   */
  const facedNorth = (facing: string): number => {
    const s = createSession(
      makeLevel({ avatars: [{ x: 2, y: 2 }], enemies: [{ x: 10, y: 5, facing }] }),
    )
    s.advance(1 / 60)
    const drawn = enemyOf(s.renderEntities(FLAT), enemyId(s))
    return angleOf(drawn, 0, -1)
  }

  it('accepts the compass abbreviation', () => {
    expect(facedNorth('N')).toBeLessThan(1)
  })

  it('and the long name the level schema also accepts', () => {
    expect(facedNorth('north')).toBeLessThan(1)
  })

  it('and an unrecognised spelling still falls back to the default, visibly', () => {
    /**
     * WHAT THIS ACTUALLY COVERS, stated honestly. An earlier draft of this case
     * carried this name and then called `facedNorth('north')` — a RECOGNISED
     * spelling — so it was a weaker duplicate of the case above it wearing a
     * different title. Review caught it.
     *
     * Widening `FACING_VECTORS` fixes the eight spellings somebody thought of;
     * it does not close the class. A typo still falls silently through to the
     * southward default, and the author cannot tell that from the field being
     * ignored. That is pinned here as the CURRENT behaviour rather than as the
     * desired one — closing it properly means rejecting unknown facings at
     * level-parse time, which changes `core/level`'s contract and belongs in its
     * own ticket.
     */
    expect(facedNorth('nrth')).toBeCloseTo(180, 0)
  })

  it('and every diagonal round-trips too', () => {
    for (const [name, abbrev] of [
      ['northeast', 'NE'],
      ['southeast', 'SE'],
      ['southwest', 'SW'],
      ['northwest', 'NW'],
    ]) {
      expect({ name, same: facedNorth(name!) }).toEqual({ name, same: facedNorth(abbrev!) })
    }
  })
})
