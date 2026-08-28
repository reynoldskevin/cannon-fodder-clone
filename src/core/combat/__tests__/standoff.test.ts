import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem } from '../index'
import type { SimEvent } from '../../world/events'
import type { Entity } from '../../world/world'

/**
 * Ticket 036 — the per-team weapon, end to end through the combat system — as
 * amended by ticket 092, which closed the standoff band this file was written to
 * prove.
 *
 * `enemy-weapon.test.ts` asserts the TABLE. This asserts that the table is
 * actually reached: a per-team weapon nothing looks up is two rows of data and
 * no change to the game. `combat/system.ts` had exactly one `weaponForKind`
 * call, and if it keeps calling it every enemy on the map still carries the
 * player's rifle while the suite reports the ticket done.
 */

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

function rig() {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 1 })
  // Commanded fire only. An auto-engaging shooter would hit men no order ever
  // pointed at, which is the one thing every assertion here has to rule out.
  const combat = createCombatSystem(bakeNavGrid(level), { autoEngageTeams: [] })
  world.addSystem(combat)
  return {
    world,
    combat,
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy'): Entity {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health: 1000 })
    },
    /** Run `ticks`, returning every shot fired in them. */
    run(ticks: number): SimEvent[] {
      const shots: SimEvent[] = []
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        for (const event of world.drainEvents()) if (event.type === 'ShotFired') shots.push(event)
      }
      return shots
    },
  }
}

/** The first shot each unit fired, by shooter id. */
const firstShotBy = (shots: readonly SimEvent[], id: number): SimEvent | undefined =>
  shots.find((e) => e.type === 'ShotFired' && e.shooterId === id)

describe('at seven tiles the exchange is mutual (ticket 092)', () => {
  it('the player`s round finds the enemy', () => {
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(11, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 11, y: 5 })
    const shot = firstShotBy(r.run(4), mine.id)
    expect(shot?.type).toBe('ShotFired')
    if (shot?.type !== 'ShotFired') throw new Error('no shot')
    expect(shot.targetId).toBe(theirs.id)
  })

  it('and the enemy`s round, fired down the same line, now finds the player', () => {
    /**
     * SEVEN TILES WAS THE DECISIVE DISTANCE, AND THIS ASSERTION IS INVERTED.
     * Ticket 036 gave the enemy 6.4 tiles precisely so that a round fired from
     * here reached nobody; ticket 092 gives him the squad's eight back, so it
     * reaches.
     *
     * INVERTED RATHER THAN DELETED, deliberately. A file that simply stopped
     * asserting the band would leave the ticket's central claim — that the
     * enemy's reach actually moved, through the wiring and not just in the
     * table — checked by nothing at all, and would pass just as happily against
     * an enemy who still carried the short rifle.
     */
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(11, 5, 'enemy')
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shot = firstShotBy(r.run(4), theirs.id)
    expect(shot?.type).toBe('ShotFired')
    if (shot?.type !== 'ShotFired') throw new Error('no shot')
    expect(shot.targetId).toBe(mine.id)
  })

  it('so a squad that backs off to seven tiles keeps taking casualties', () => {
    // Both under standing orders at once, which is the situation the player is
    // actually in. Backing off out of contact is no longer an answer to being
    // engaged — the squad has to break line of sight or win the exchange.
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(11, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 11, y: 5 })
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shots = r.run(200)
    const landedOnMe = shots.filter(
      (e) => e.type === 'ShotFired' && e.shooterId === theirs.id && e.targetId === mine.id,
    )
    const landedOnHim = shots.filter(
      (e) => e.type === 'ShotFired' && e.shooterId === mine.id && e.targetId === theirs.id,
    )
    expect(landedOnMe.length).toBeGreaterThan(0)
    expect(landedOnHim.length).toBeGreaterThan(0)
  })
})

describe('and the two envelopes now end at the same distance', () => {
  it('at eight tiles — the shared maximum — both rounds still find their man', () => {
    /**
     * `inRange` compares with `<=`, so eight tiles is the last distance inside
     * an eight-tile rifle. This is the boundary that pins the enemy's reach at
     * exactly the squad's rather than merely at MORE than 6.4: an enemy given
     * seven tiles, or 7.5, passes every case above and fails here.
     */
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(12, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 12, y: 5 })
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shots = r.run(4)
    const his = firstShotBy(shots, theirs.id)
    const hers = firstShotBy(shots, mine.id)
    if (his?.type !== 'ShotFired' || hers?.type !== 'ShotFired') throw new Error('missing shots')
    expect(his.targetId).toBe(mine.id)
    expect(hers.targetId).toBe(theirs.id)
  })

  it('and at nine tiles NEITHER does, so the reach is equal rather than unbounded', () => {
    // The other side of the same boundary. Both men still fire — a commanded
    // shot always leaves the rifle — and neither round reaches anyone.
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(13, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 13, y: 5 })
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shots = r.run(4)
    const his = firstShotBy(shots, theirs.id)
    const hers = firstShotBy(shots, mine.id)
    if (his?.type !== 'ShotFired' || hers?.type !== 'ShotFired') throw new Error('missing shots')
    expect(his.targetId).toBeNull()
    expect(hers.targetId).toBeNull()
  })
})

describe('and he pulls the trigger less often', () => {
  it('firing strictly fewer rounds than a player unit over the same window', () => {
    /**
     * COUNTED FROM THE EVENT STREAM, not from the cooldown constant, because the
     * constant is already asserted next door and re-asserting it here would test
     * the table twice and the wiring never. This is the only test in the suite
     * that fails if `markFired` is handed the wrong spec — a plausible mistake,
     * since the two rows are structurally identical and a stale `weaponForKind`
     * left in the cooldown path would be invisible everywhere else.
     *
     * Both men are inside each other's range here, so range plays no part.
     */
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(8, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 8, y: 5 })
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shots = r.run(600)
    const byMe = shots.filter((e) => e.type === 'ShotFired' && e.shooterId === mine.id).length
    const byHim = shots.filter((e) => e.type === 'ShotFired' && e.shooterId === theirs.id).length
    expect(byMe).toBeGreaterThan(0)
    expect(byHim).toBeGreaterThan(0)
    // 600 ticks at 32 against 40: 19 rounds to 15. The bound was 0.75, which
    // suited the 46 of ticket 036 and does not survive 40 — re-derived from the
    // two cooldowns (32/40 = 0.8) rather than loosened until the new value fit,
    // which would be the test following the code.
    expect(byHim).toBeLessThan(byMe)
    expect(byHim).toBeLessThan(byMe * 0.85)
  })
})
