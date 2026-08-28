import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem } from '../index'
import type { Difficulty } from '../index'
import type { SimEvent } from '../../world/events'
import type { Entity } from '../../world/world'

/**
 * Ticket 036 — the standoff band, end to end through the combat system — as
 * amended by ticket 093.
 *
 * TICKET 092 CLOSED THIS BAND FOR EVERYBODY AND 093 MADE THAT AN OPT-IN. The
 * cases below run on the SHIPPED DEFAULT, where the band is exactly what 036
 * built; the hard-mode block at the bottom is where 092's enemy lives now, and
 * it is the same geometry asserted the other way round.
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

function rig(difficulty?: Difficulty) {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 1 })
  // Commanded fire only. An auto-engaging shooter would hit men no order ever
  // pointed at, which is the one thing every assertion here has to rule out.
  //
  // The difficulty is passed THROUGH the system's options rather than set on a
  // module, which is what makes the hard block below a test of the wiring and
  // not just of the table `enemy-weapon.test.ts` already covers.
  const combat = createCombatSystem(bakeNavGrid(level), {
    autoEngageTeams: [],
    ...(difficulty === undefined ? {} : { difficulty }),
  })
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

describe('at seven tiles the squad can shoot and the enemy cannot', () => {
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

  it('and the enemy`s round, fired down the same line, finds nobody', () => {
    /**
     * SEVEN TILES IS THE DECISIVE DISTANCE — inside the squad's eight and
     * outside the enemy's 6.4.
     *
     * He still FIRES: a commanded shot always leaves the rifle, and suppressing
     * fire is a tracer that hits nothing. What he must not do is reach a man
     * 0.6 tiles beyond the weapon he holds.
     */
    const r = rig()
    r.spawn(4, 5, 'player')
    const theirs = r.spawn(11, 5, 'enemy')
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shot = firstShotBy(r.run(4), theirs.id)
    expect(shot?.type).toBe('ShotFired')
    if (shot?.type !== 'ShotFired') throw new Error('no shot')
    expect(shot.targetId).toBeNull()
  })

  it('so a squad that backs off to seven tiles stops taking casualties', () => {
    // Both under standing orders at once, which is the situation the player is
    // actually in. Long enough for several cooldowns on both sides.
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
    expect(landedOnMe).toHaveLength(0)
    expect(landedOnHim.length).toBeGreaterThan(0)
  })
})

describe('and inside his range the exchange is mutual again', () => {
  it('at six tiles both rounds find their man', () => {
    /**
     * The other side of the boundary, and it is what stops the band from being
     * satisfiable by an enemy who simply cannot shoot. Six is inside 6.4.
     */
    const r = rig()
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(10, 5, 'enemy')
    r.combat.orderFire([mine.id], { x: 10, y: 5 })
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shots = r.run(4)
    const his = firstShotBy(shots, theirs.id)
    const hers = firstShotBy(shots, mine.id)
    if (his?.type !== 'ShotFired' || hers?.type !== 'ShotFired') throw new Error('missing shots')
    expect(his.targetId).toBe(mine.id)
    expect(hers.targetId).toBe(theirs.id)
  })
})

describe('on HARD the band is closed (tickets 092, 093)', () => {
  it('the enemy`s round at seven tiles now finds the player', () => {
    /**
     * THE SAME GEOMETRY AS THE DECISIVE CASE ABOVE, ASSERTED THE OTHER WAY.
     * That is what makes this a test of the difficulty reaching the combat
     * system rather than of the hard table existing — a `difficulty` option
     * accepted and then ignored leaves this identical to the default and
     * failing, while `enemy-weapon.test.ts` would still pass in full.
     */
    const r = rig('hard')
    const mine = r.spawn(4, 5, 'player')
    const theirs = r.spawn(11, 5, 'enemy')
    r.combat.orderFire([theirs.id], { x: 4, y: 5 })
    const shot = firstShotBy(r.run(4), theirs.id)
    if (shot?.type !== 'ShotFired') throw new Error('no shot')
    expect(shot.targetId).toBe(mine.id)
  })

  it('and at eight tiles — the shared maximum — both rounds still find their man', () => {
    // `inRange` compares with `<=`, so eight is the last distance inside an
    // eight-tile rifle. This pins the hard reach at exactly the squad's rather
    // than merely at more than 6.4: an enemy given seven tiles passes the case
    // above and fails here.
    const r = rig('hard')
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

  it('and at nine tiles NEITHER does, so hard equalises rather than unbounds', () => {
    const r = rig('hard')
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

  it('and he fires faster on hard than on normal, in the same window', () => {
    // The rate half of the difficulty, counted from the event stream rather than
    // from the constant — the only thing that fails if `markFired` is handed the
    // normal spec while the reach lookup got the hard one.
    const count = (d?: Difficulty): number => {
      const r = rig(d)
      r.spawn(4, 5, 'player')
      const theirs = r.spawn(8, 5, 'enemy')
      r.combat.orderFire([theirs.id], { x: 4, y: 5 })
      return r.run(600).filter((e) => e.type === 'ShotFired' && e.shooterId === theirs.id).length
    }
    expect(count('hard')).toBeGreaterThan(count())
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
    // 600 ticks at 32 against 46: about 19 rounds against about 14. This runs on
    // the DEFAULT difficulty, where the enemy's slower rate is the shipped
    // behaviour; the hard block above covers the other one.
    expect(byHim).toBeLessThan(byMe)
    expect(byHim).toBeLessThan(byMe * 0.75)
  })
})
