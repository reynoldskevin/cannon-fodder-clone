import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem } from '../index'
import { canFireFromTerrain, TERRAIN } from '../../level'
import type { SimEvent } from '../../world/events'
import type { Entity } from '../../world/world'

/**
 * Ticket 007b — a man in the water cannot shoot.
 *
 * The other half of what makes the bridge a decision. Swimming is slower, and
 * while he is doing it he is not fighting — so crossing under fire is a
 * commitment rather than a slower walk.
 *
 * THE CHECK IS ON THE SHOOTER'S OWN TILE, and combat is what enforces it. That
 * covers every route to a trigger at once — the player's standing order, the
 * AI's `orderFire`, auto-engage — because all three arrive at the same
 * decision. Putting it in any one of them would leave the other two firing.
 *
 * A HELD SHOT IS NOT A MISS. Ticket 011b's `hit: false` is a round that was
 * fired and went somewhere; this man never pulled the trigger. No `ShotFired`,
 * no tracer, no report, and nothing for a nearby enemy to hear — and his
 * cooldown is untouched, so he is ready the instant he reaches the bank.
 */

/** Dry left half, flooded right half, so a shooter can stand in either. */
const RIVER = `
  ........~~~~........
  ........~~~~........
  ........~~~~........
  ........~~~~........
  ........~~~~........
  ........~~~~........
`

function rig(autoEngage: boolean) {
  const level = asciiLevel(RIVER)
  const world = new World(level, { seed: 1 })
  const combat = createCombatSystem(
    bakeNavGrid(level),
    autoEngage ? {} : { autoEngageTeams: [] },
  )
  world.addSystem(combat)
  return {
    world,
    combat,
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy', health = 1000): Entity {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    /** Run `ticks`, returning every shot fired in them. */
    run(ticks: number): SimEvent[] {
      const shots: SimEvent[] = []
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        for (const e of world.drainEvents()) if (e.type === 'ShotFired') shots.push(e)
      }
      return shots
    },
  }
}

const by = (shots: readonly SimEvent[], id: number): SimEvent[] =>
  shots.filter((s) => s.type === 'ShotFired' && s.shooterId === id)

/** Tile 9 is in the river; tile 4 and tile 15 are dry banks. */
const WET = 9
const DRY_NEAR = 4
const DRY_FAR = 14

describe('the table', () => {
  it('forbids firing from water and allows it everywhere else', () => {
    expect(canFireFromTerrain(TERRAIN.WATER)).toBe(false)
    for (const dry of [TERRAIN.GRASS, TERRAIN.ROCK, TERRAIN.CANOPY]) {
      expect({ dry, can: canFireFromTerrain(dry) }).toEqual({ dry, can: true })
    }
  })

  it('lets a tile id it has never heard of fire', () => {
    // The neutral answer, matching `traversalForTerrain` and
    // `speedMultiplierForTerrain`: a level from a newer importer must not
    // silently disarm a squad standing on terrain this build cannot name.
    for (const unknown of [99, 4096, -1]) {
      expect({ unknown, can: canFireFromTerrain(unknown) }).toEqual({ unknown, can: true })
    }
  })
})

describe('a shooter standing in water fires nothing at all', () => {
  it('under a standing order', () => {
    const r = rig(false)
    const swimmer = r.spawn(WET, 3, 'player')
    r.spawn(DRY_FAR, 3, 'enemy')
    r.combat.orderFire([swimmer.id], { x: DRY_FAR, y: 3 })
    expect(by(r.run(120), swimmer.id)).toEqual([])
  })

  it('and under auto-engage', () => {
    /**
     * The second door to the same trigger. A rule enforced only where the
     * player's order is read would leave every auto-engaging unit — which is
     * how ticket 011 shipped, and how a future turret would behave — shooting
     * happily from the river.
     */
    const r = rig(true)
    const swimmer = r.spawn(WET, 3, 'player')
    r.spawn(DRY_FAR, 3, 'enemy')
    expect(by(r.run(120), swimmer.id)).toEqual([])
  })

  it('and it is not a miss — there is no event to be a miss', () => {
    /**
     * Stated on the EVENT rather than on the damage. A `ShotFired` with
     * `hit: false` would still draw a tracer, still make a report, and still be
     * heard by every enemy inside the alert radius — so a man wading across
     * would be broadcasting his position while doing no harm, which is the
     * opposite of what this rule is for.
     */
    const r = rig(false)
    const swimmer = r.spawn(WET, 3, 'player')
    r.spawn(DRY_FAR, 3, 'enemy')
    r.combat.orderFire([swimmer.id], { x: DRY_FAR, y: 3 })
    expect(r.run(120).length).toBe(0)
  })

  it('and the enemy he was aiming at is unharmed', () => {
    const r = rig(false)
    const swimmer = r.spawn(WET, 3, 'player')
    const target = r.spawn(DRY_FAR, 3, 'enemy')
    r.combat.orderFire([swimmer.id], { x: DRY_FAR, y: 3 })
    r.run(120)
    expect(r.world.isAlive(target.id)).toBe(true)
    expect(r.world.get(target.id)?.health).toBe(1000)
  })
})

describe('and the same man on the bank fires normally', () => {
  it('which is the control the cases above rest on', () => {
    /**
     * WITHOUT THIS THEY PROVE NOTHING. A fixture where nobody could shoot for an
     * unrelated reason — out of range, no line of sight, the wrong team —
     * satisfies every "fires nothing" assertion above perfectly.
     */
    const r = rig(false)
    const shooter = r.spawn(DRY_NEAR, 3, 'player')
    r.spawn(DRY_NEAR + 5, 3, 'enemy')
    r.combat.orderFire([shooter.id], { x: DRY_NEAR + 5, y: 3 })
    expect(by(r.run(120), shooter.id).length).toBeGreaterThan(0)
  })

  it('and shooting AT a man in the water is unaffected', () => {
    // The rule is about where the SHOOTER stands. A swimmer is a target like
    // any other — being unable to shoot back is the whole risk of crossing.
    const r = rig(false)
    const shooter = r.spawn(DRY_NEAR, 3, 'player')
    const swimmer = r.spawn(WET, 3, 'enemy', 1)
    r.combat.orderFire([shooter.id], { x: WET, y: 3 })
    r.run(120)
    expect(r.world.isAlive(swimmer.id)).toBe(false)
  })
})

describe('holding fire costs him nothing', () => {
  it('he shoots on the first tick he reaches the bank', () => {
    /**
     * The cooldown must be UNTOUCHED while he holds. A man who spent a shot on
     * every tick of a four-second crossing would come out of the water with
     * nothing ready, and the rule would be a punishment rather than a
     * restriction.
     *
     * He is moved out of the water by hand rather than walked, so this measures
     * the cooldown and not the squad system.
     */
    const r = rig(false)
    const swimmer = r.spawn(WET, 3, 'player')
    r.spawn(DRY_FAR, 3, 'enemy')
    r.combat.orderFire([swimmer.id], { x: DRY_FAR, y: 3 })
    expect(by(r.run(120), swimmer.id)).toEqual([])

    // Onto the near bank, still holding the same order.
    const bank = tileToWorld(DRY_NEAR + 6, 3, r.world.level.size)
    const man = r.world.get(swimmer.id)
    if (man === undefined) throw new Error('lost the swimmer')
    man.x = bank.x
    man.z = bank.z
    // ONE tick. A spent cooldown would need thirty-two.
    expect(by(r.run(1), swimmer.id).length).toBe(1)
  })
})
