import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createOrdnanceSystem } from '../system'
import { ORDNANCE } from '../table'
import type { OrdnanceSpec } from '../table'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 015 — "adding a new ordnance type requires only a table row".
 *
 * THE CLAIM IS ONLY WORTH ANYTHING IF IT IS TESTED THE HARD WAY. A test that
 * edited the shipped `ORDNANCE` table and then fired the result would prove
 * nothing: the table is in the same repository as the code, so a row that
 * happened to need a matching `if` somewhere would still pass. What must be
 * shown is that a row invented AT RUNTIME, by a caller who cannot touch a line
 * of `src/core/ordnance`, flies, detonates, falls off and kills — which is
 * exactly the position a designer loading ordnance from `level.json` will be in.
 *
 * That is what `createOrdnanceSystem(grid, { table })` is for. A system that
 * read the module singleton directly could not be put in this position at all,
 * and the criterion would be untestable rather than merely untested.
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

/**
 * A weapon nothing in `src/core` has heard of: a slow, enormous, friendly-fire
 * mortar with a quadratic falloff. Every field is deliberately unlike the rows
 * the table ships with.
 */
const MORTAR: OrdnanceSpec = {
  name: 'siege-mortar',
  arc: 'ballistic',
  speedTilesPerTick: 0.2,
  fuseTicks: 900,
  blastRadiusTiles: 6,
  peakDamage: 300,
  falloff: 'quadratic',
  cooldownTicks: 90,
  ammoCost: 2,
  damagesFriendlies: false,
}

function rig() {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 7 })
  const grid = bakeNavGrid(level)
  const ordnance = createOrdnanceSystem(grid, { table: { 'siege-mortar': MORTAR } })
  world.addSystem(ordnance)
  const events: SimEvent[] = []
  return {
    world,
    ordnance,
    spawn: (x: number, y: number, team: 'player' | 'enemy' = 'player', health = 1000) => {
      const p = tileToWorld(x, y, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        events.push(...world.drainEvents())
      }
    },
    events,
  }
}

describe('a weapon invented at runtime works end to end', () => {
  it('launches', () => {
    const r = rig()
    const gunner = r.spawn(2, 5)
    r.run(1)
    expect(r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })).toBe(true)
  })

  it('flies for as long as its own speed says, not some default', () => {
    // Speed 0.2 over 10 tiles is 50 ticks. A system that ignored the row's speed
    // would land it far earlier, and every other assertion here would still pass.
    const r = rig()
    const gunner = r.spawn(2, 5)
    r.run(1)
    r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })
    r.run(40)
    expect(r.ordnance.inFlightCount).toBe(1)
    r.run(20)
    expect(r.ordnance.inFlightCount).toBe(0)
  })

  it('explodes, and says which weapon it was', () => {
    const r = rig()
    const gunner = r.spawn(2, 5)
    r.run(1)
    r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })
    r.run(200)
    const boom = r.events.find((e) => e.type === 'Explosion')
    if (boom?.type !== 'Explosion') throw new Error('no explosion')
    expect({ ordnance: boom.ordnance, radiusTiles: boom.radiusTiles }).toEqual({
      ordnance: 'siege-mortar',
      radiusTiles: 6,
    })
  })

  it('uses its own enormous radius', () => {
    // Five tiles from the centre — outside every radius the shipped table uses,
    // inside this one's.
    const r = rig()
    const gunner = r.spawn(2, 5)
    const distant = r.spawn(17, 5, 'enemy', 5000)
    r.run(1)
    r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })
    r.run(200)
    expect(r.world.get(distant.id)?.health).toBeLessThan(5000)
  })

  it('uses its own quadratic falloff, not a linear default', () => {
    /**
     * The sharpest of these, because it discriminates a real mistake: a system
     * that read every field of the row EXCEPT `falloff`, and always fell off
     * linearly, would pass every other test in this file.
     *
     * Radius 6, victim 3 tiles out, peak 300. Quadratic takes (1 - 0.5)^2 = 25%
     * — 75 damage. Linear would take 50% — 150. The two are far enough apart
     * that no rounding argument can confuse them.
     */
    const r = rig()
    const gunner = r.spawn(2, 5)
    const victim = r.spawn(15, 5, 'enemy', 5000)
    r.run(1)
    r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })
    r.run(200)
    expect(5000 - (r.world.get(victim.id)?.health ?? 0)).toBeCloseTo(75, 6)
  })

  it('honours its own friendly-fire flag', () => {
    const r = rig()
    const gunner = r.spawn(2, 5)
    const mate = r.spawn(12, 5, 'player', 5000)
    const foe = r.spawn(12, 6, 'enemy', 5000)
    r.run(1)
    r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })
    r.run(200)
    expect({
      mateHurt: (r.world.get(mate.id)?.health ?? 0) < 5000,
      foeHurt: (r.world.get(foe.id)?.health ?? 0) < 5000,
    }).toEqual({ mateHurt: false, foeHurt: true })
  })

  it('honours its own cooldown', () => {
    const r = rig()
    const gunner = r.spawn(2, 5)
    r.run(1)
    expect(r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })).toBe(true)
    r.run(60) // less than 90
    expect(r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })).toBe(false)
    r.run(40) // now past it
    expect(r.ordnance.launch(gunner.id, 'siege-mortar', { x: 12, y: 5 })).toBe(true)
  })

  it('needed no row in the shipped table to do any of it', () => {
    // The negative half of the claim, and the one that catches a system which
    // quietly merges the caller's table over the module's instead of replacing
    // it — at which point "only a table row" is true only for rows the module
    // already anticipated.
    expect(Object.keys(ORDNANCE)).not.toContain('siege-mortar')
  })
})

describe('the shipped table is a table, not a special case', () => {
  it('has at least one row', () => {
    // Otherwise every invariant below is vacuously true.
    expect(Object.keys(ORDNANCE).length).toBeGreaterThan(0)
  })

  it('every row is internally consistent', () => {
    for (const [key, row] of Object.entries(ORDNANCE)) {
      expect({
        key,
        keyedByName: row.name === key,
        arc: row.arc === 'ballistic' || row.arc === 'flat',
        falloff: ['linear', 'constant', 'quadratic'].includes(row.falloff),
        speed: row.speedTilesPerTick > 0,
        fuse: Number.isInteger(row.fuseTicks) && row.fuseTicks > 0,
        radius: row.blastRadiusTiles > 0,
        damage: row.peakDamage > 0,
        cooldown: Number.isInteger(row.cooldownTicks) && row.cooldownTicks > 0,
        ammo: Number.isInteger(row.ammoCost) && row.ammoCost >= 0,
        friendlies: typeof row.damagesFriendlies === 'boolean',
      }).toEqual({
        key,
        keyedByName: true,
        arc: true,
        falloff: true,
        speed: true,
        fuse: true,
        radius: true,
        damage: true,
        cooldown: true,
        ammo: true,
        friendlies: true,
      })
    }
  })

  it('every row survives a JSON round-trip unchanged', () => {
    /**
     * SPECS ARE DATA, NOT BEHAVIOUR — the rule `combat/weapons.ts` states and
     * the reason `falloff` is the NAME of a curve rather than the curve itself.
     * A function, a getter or a derived field would vanish or change here, and
     * with it any hope of a later ticket loading the table from `level.json`.
     */
    expect(JSON.parse(JSON.stringify(ORDNANCE))).toEqual(ORDNANCE)
  })
})
