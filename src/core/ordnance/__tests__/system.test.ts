import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid, INFANTRY } from '../../pathing/navgrid'
import { tileToWorld, worldToTileX, worldToTileY } from '../../view/projection'
import { createOrdnanceSystem } from '../system'
import { planTrajectory } from '../ballistics'
import type { OrdnanceSpec } from '../table'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 015 — the per-tick ordnance pass.
 *
 * WHAT THIS OWNS that the two pure modules do not: the grid (so a rocket stops
 * at cover), the world (so a blast damages somebody), the tick (so a fuse can
 * expire), and the order everything happens in.
 *
 * PROJECTILES ARE NOT ENTITIES. They live in this system's own array and never
 * enter `world.entities`. `World.spawnFromLevel` already draws that line for
 * props and chests; here the reason is sharper, because an entity in the live
 * array goes through `CombatSystem.pickTarget` and the AI every tick — so a
 * thrown grenade would become a thing soldiers stop and shoot at.
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

/** A tall wall down column 10, for shots that run LENGTHWISE along it. */
const TALL_WALL = `
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
`

/** A wall down column 10. */
const WALLED = `
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
  ..........#.........
`

const spec = (over: Partial<OrdnanceSpec>): OrdnanceSpec => ({
  name: 'test',
  arc: 'ballistic',
  speedTilesPerTick: 0.5,
  fuseTicks: 600,
  blastRadiusTiles: 3,
  peakDamage: 50,
  falloff: 'linear',
  cooldownTicks: 30,
  ammoCost: 1,
  damagesFriendlies: true,
  ...over,
})

const TABLE = {
  lob: spec({ name: 'lob', arc: 'ballistic' }),
  dart: spec({ name: 'dart', arc: 'flat', speedTilesPerTick: 1 }),
  /** Detonates in the air well before it could arrive. */
  shortfuse: spec({ name: 'shortfuse', arc: 'ballistic', fuseTicks: 3 }),
}

function rig(art = OPEN, table: Record<string, OrdnanceSpec> = TABLE) {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const ordnance = createOrdnanceSystem(grid, { table })
  world.addSystem(ordnance)
  const events: SimEvent[] = []
  return {
    world,
    grid,
    ordnance,
    level,
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy' = 'player', health = 1000) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    at(tileX: number, tileY: number) {
      return tileToWorld(tileX, tileY, level.size)
    },
    /** Ticks, accumulating every event so a detonation is not drained away. */
    run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        events.push(...world.drainEvents())
      }
    },
    events,
    explosions() {
      return events.filter((e) => e.type === 'Explosion')
    },
  }
}

describe('launching', () => {
  it('a launched projectile is in flight', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(true)
    expect(r.ordnance.inFlightCount).toBe(1)
  })

  it('refuses ordnance the table does not name', () => {
    // An open enum reaching a table that has no row for it. Silently doing
    // nothing is how a typo in level data becomes a weapon that never fires and
    // nobody can explain.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    expect(r.ordnance.launch(man.id, 'howitzer', { x: 9, y: 5 })).toBe(false)
    expect(r.ordnance.inFlightCount).toBe(0)
  })

  it('refuses an id that names nothing living', () => {
    const r = rig()
    r.run(1)
    expect(r.ordnance.launch(99_999, 'lob', { x: 9, y: 5 })).toBe(false)
    expect(r.ordnance.inFlightCount).toBe(0)
  })

  it('refuses a dead launcher', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.world.despawn(man.id)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(false)
  })

  it('launches from where the launcher is standing', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    const p = r.ordnance.inFlight()[0]
    const from = r.at(3, 5)
    expect(p?.x).toBeCloseTo(from.x, 6)
    expect(p?.z).toBeCloseTo(from.z, 6)
  })

  it('honours the cooldown, so holding the button is not a barrage', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(true)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(false)
  })

  it('lets him throw again once the cooldown has run', () => {
    // Without this, "honours the cooldown" is satisfied by a system that lets
    // every unit throw exactly one grenade per mission.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(true)
    r.run(TABLE.lob.cooldownTicks + 1)
    expect(r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(true)
  })

  it('one man`s cooldown is not the whole squad`s', () => {
    const r = rig()
    const a = r.spawn(3, 5)
    const b = r.spawn(3, 6)
    r.run(1)
    expect(r.ordnance.launch(a.id, 'lob', { x: 9, y: 5 })).toBe(true)
    expect(r.ordnance.launch(b.id, 'lob', { x: 9, y: 6 })).toBe(true)
  })

  it('refuses a target that is not on the map', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    expect(r.ordnance.launch(man.id, 'lob', { x: 99, y: 5 })).toBe(false)
    expect(r.ordnance.launch(man.id, 'lob', { x: -1, y: 5 })).toBe(false)
  })
})

describe('flight and detonation', () => {
  it('a grenade is in the air for a while, then gone', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(1)
    expect(r.ordnance.inFlightCount).toBe(1)
    r.run(200)
    expect(r.ordnance.inFlightCount).toBe(0)
  })

  it('is in the air for exactly the flight its trajectory was planned for', () => {
    /**
     * Pins the off-by-one that a `>=` quietly turned into a `>` would introduce,
     * and which nothing else here can see: every other case runs the clock far
     * past impact and only asks whether the round eventually went off.
     *
     * Expressed against `planTrajectory`'s own answer rather than a literal, so
     * this asserts the SYSTEM agrees with the flight it planned rather than
     * restating a number that would then have to be maintained in two places.
     */
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    const from = r.at(3, 5)
    const aim = r.at(9, 5)
    const flight = planTrajectory(TABLE.lob, from.x, from.z, aim.x, aim.z).flightTicks
    expect(flight).toBeGreaterThan(2)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(flight - 1)
    expect({ when: 'one tick short', count: r.ordnance.inFlightCount }).toEqual({
      when: 'one tick short',
      count: 1,
    })
    r.run(1)
    expect({ when: 'on the tick', count: r.ordnance.inFlightCount }).toEqual({
      when: 'on the tick',
      count: 0,
    })
  })

  it('refuses to launch before the system has ever ticked', () => {
    // It has no world to read a position out of. Same shape as
    // `CombatSystem.orderFire`'s `attached`, and stated here so a later refactor
    // that made it throw — or worse, launch from the origin — is caught.
    const level = asciiLevel(OPEN)
    const world = new World(level, { seed: 1 })
    const ordnance = createOrdnanceSystem(bakeNavGrid(level), { table: TABLE })
    world.addSystem(ordnance)
    const p = tileToWorld(3, 5, level.size)
    const man = world.spawn({ kind: 'rifleman', team: 'player', x: p.x, z: p.z, health: 1000 })
    expect(ordnance.launch(man.id, 'lob', { x: 9, y: 5 })).toBe(false)
    expect(ordnance.inFlightCount).toBe(0)
  })

  it('it climbs and comes back down rather than sliding along the floor', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 15, y: 5 })
    let peak = 0
    for (let i = 0; i < 60; i += 1) {
      r.run(1)
      const p = r.ordnance.inFlight()[0]
      if (p !== undefined && p.y > peak) peak = p.y
    }
    expect(peak).toBeGreaterThan(0)
  })

  it('it explodes where it was aimed', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const boom = r.explosions()[0]
    const aim = r.at(9, 5)
    expect(boom).toBeDefined()
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    expect(boom.x).toBeCloseTo(aim.x, 6)
    expect(boom.z).toBeCloseTo(aim.z, 6)
  })

  it('it explodes exactly once', () => {
    // A detonation that fired on every tick after impact, or a projectile left
    // in the array after it went off, both look identical until you count.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(300)
    expect(r.explosions()).toHaveLength(1)
  })

  it('a short fuse detonates in the air, short of the target', () => {
    // An airburst is a real outcome and it must be reported where it happened.
    // Teleporting it to the aim point would hide the whole mechanic.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'shortfuse', { x: 17, y: 5 })
    r.run(40)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    const from = r.at(3, 5)
    const aim = r.at(17, 5)
    expect(Math.abs(boom.x - from.x)).toBeLessThan(Math.abs(aim.x - from.x))
    expect(boom.y).toBeGreaterThan(0)
  })

  it('a fuse longer than the flight does not cut the throw short', () => {
    // The control for the case above: `fuseTicks` is a deadline, not a duration
    // the projectile always serves.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    expect(boom.y).toBeCloseTo(0, 6)
  })

  it('a flat projectile stops at the near face of a wall', () => {
    /**
     * The rocket's half of the arc distinction. A grenade arcs OVER cover — that
     * is what it is for — and a rocket does not, so it must detonate on the wall
     * rather than inside the room behind it. `clearFractionAlong` already
     * computes exactly this stopping point for the rifle's tracer (ticket 011a),
     * so this needs no new geometry.
     */
    const r = rig(WALLED)
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'dart', { x: 17, y: 5 })
    r.run(200)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    const wall = r.at(10, 5)
    const aim = r.at(17, 5)
    expect(boom.x).toBeLessThan(wall.x)
    expect(boom.x).toBeLessThan(aim.x)
  })

  it('stops at the wall from ANY position within the launcher`s tile', () => {
    /**
     * THE CASE A TILE-CENTRE FIXTURE CANNOT SEE, and it cost this ticket a
     * review cycle.
     *
     * `clearFractionAlong` reports a fraction of the ray joining two tile
     * CENTRES. Applying that fraction to the ray from a launcher's ACTUAL
     * position — which is only at a tile centre when he is standing on a
     * waypoint, i.e. almost never — scales a different, differently-anchored
     * vector, and the impact lands INSIDE the wall. `resolveBlast` then finds
     * its centre tile solid, snaps the sightline to the nearest passable
     * neighbour, and that neighbour can be on the FAR side of the wall: the
     * blast reaches straight through the cover it was supposed to stop at.
     *
     * The error is one-directional and therefore easy to miss — a launcher
     * nudged AWAY from the wall detonates harmlessly short, and only one nudged
     * TOWARD it punches through. Every fixture above stands on a centre, where
     * the two rays coincide exactly and the bug is invisible.
     *
     * The invariant asserted is the one that actually matters and that any
     * correct fix satisfies: a flat round never detonates inside solid terrain.
     */
    const r = rig(WALLED)
    const from = r.at(13, 5)
    const impacts: { off: number; tile: number }[] = []
    for (const off of [0, -0.2, -0.4, -0.49, 0.2, 0.49]) {
      const one = rig(WALLED)
      const man = one.world.spawn({
        kind: 'rifleman',
        team: 'player',
        x: from.x + off,
        z: from.z,
        health: 1000,
      })
      one.run(1)
      one.ordnance.launch(man.id, 'dart', { x: 3, y: 5 })
      one.run(200)
      const boom = one.explosions()[0]
      if (boom?.type !== 'Explosion') throw new Error(`no explosion at offset ${String(off)}`)
      // World x back to a tile index, through the shared projection rather than
      // a hand-rolled `+ (w - 1) / 2`, which is the off-by-half this project has
      // paid for twice.
      impacts.push({ off, tile: worldToTileX(boom.x, one.level.size) })
    }
    // Column 10 is the wall. No impact may be inside it.
    expect(impacts.filter((i) => i.tile === 10)).toEqual([])
    expect(r.level.size.w).toBe(20)
  })

  it('and nobody sheltering behind that wall is touched, from any offset', () => {
    // The consequence stated in the terms a player would report it in. At
    // `INFANTRY_HEALTH = 1` any positive damage through the wall is a death.
    const from = tileToWorld(13, 5, { w: 20, h: 8 })
    const survived: { off: number; hp: number }[] = []
    for (const off of [0, -0.2, -0.4, -0.49]) {
      const one = rig(WALLED)
      const man = one.world.spawn({
        kind: 'rifleman',
        team: 'player',
        x: from.x + off,
        z: from.z,
        health: 1000,
      })
      const behind = one.at(9, 5)
      const victim = one.world.spawn({
        kind: 'rifleman',
        team: 'enemy',
        x: behind.x,
        z: behind.z,
        health: 1000,
      })
      one.run(1)
      one.ordnance.launch(man.id, 'dart', { x: 3, y: 5 })
      one.run(200)
      survived.push({ off, hp: one.world.get(victim.id)?.health ?? 0 })
    }
    expect(survived).toEqual([
      { off: 0, hp: 1000 },
      { off: -0.2, hp: 1000 },
      { off: -0.4, hp: 1000 },
      { off: -0.49, hp: 1000 },
    ])
  })

  it('never detonates inside solid ground, on ANY line including along a wall', () => {
    /**
     * THE INVARIANT, SWEPT — and the case that a horizontal firing line cannot
     * reach.
     *
     * The first fix for the off-centre clamp pulled the impact back one tile
     * face per pass, with a budget of four, on the reasoning that a guess under
     * a tile out names at most the blocking tile or the one behind it. That
     * reasoning is false for an OBLIQUE ray: a shot that runs nearly parallel to
     * a wall enters the wall column and then crosses many ROW faces inside it,
     * so it is a long way out measured in faces while being barely out measured
     * in space. Four passes are spent without ever escaping in x, and the round
     * detonates inside the wall — which is finding 1 all over again, at 2% of
     * shots instead of 50%.
     *
     * Swept rather than sampled because the failure is a thin sliver of the
     * input space: every fixture above fires along a row, and along a row this
     * never happens. It also pins the whole clamp at once — the pass budget, the
     * face nudge, both axes of the slab intersection, and the world-to-tile
     * spelling at THIS call site, which the blast test's fixture does not cover.
     */
    const level = asciiLevel(TALL_WALL)
    const grid = bakeNavGrid(level)
    const inSolid: string[] = []
    let fired = 0
    for (const column of [9, 11]) {
      for (const row of [0, 3, 6, 9]) {
        for (const ox of [-0.3, 0, 0.3]) {
          for (const oz of [-0.3, 0, 0.3]) {
            for (const target of [
              { x: 10, y: 9 },
              { x: 10, y: 0 },
            ]) {
              const world = new World(level, { seed: 1 })
              const ordnance = createOrdnanceSystem(grid, { table: TABLE })
              world.addSystem(ordnance)
              const from = tileToWorld(column, row, level.size)
              const man = world.spawn({
                kind: 'rifleman',
                team: 'player',
                x: from.x + ox,
                z: from.z + oz,
                health: 1000,
              })
              world.tick()
              world.drainEvents()
              if (!ordnance.launch(man.id, 'dart', target)) continue
              let bx = Number.NaN
              let bz = Number.NaN
              for (let i = 0; i < 60; i += 1) {
                world.tick()
                for (const e of world.drainEvents()) {
                  if (e.type === 'Explosion') {
                    bx = e.x
                    bz = e.z
                  }
                }
              }
              if (Number.isNaN(bx)) continue
              fired += 1
              const tx = worldToTileX(bx, level.size)
              const tz = worldToTileY(bz, level.size)
              if (!grid.passable(tx, tz, INFANTRY)) {
                inSolid.push(
                  `from (${String(column)}${ox >= 0 ? '+' : ''}${String(ox)}, ${String(row)}${oz >= 0 ? '+' : ''}${String(oz)}) at (${String(target.x)},${String(target.y)}) -> tile ${String(tx)},${String(tz)}`,
                )
              }
            }
          }
        }
      }
    }
    // Non-vacuity: a sweep that fired nothing would pass this silently.
    expect(fired).toBeGreaterThan(100)
    expect(inSolid).toEqual([])
  })

  it('and an oblique shot along a wall does not kill the man on the far side', () => {
    /**
     * The consequence, in the terms a player would report it, and the geometry
     * matters: the shooter is EAST of the wall and the victim is WEST of it, so
     * a hit here is a round that went through two tiles of solid rock.
     *
     * The mechanism is worth stating because it is not obvious from the impact
     * point alone. The round detonates INSIDE the wall column; `resolveBlast`
     * finds its centre tile impassable and `sightOrigin` snaps the sightline to
     * the nearest passable neighbour, whose ring scan resolves ties toward −x —
     * the far side. So the blast is measured from a tile the shooter cannot see,
     * and cover stops meaning anything.
     *
     * Full health asserted rather than "less damage": at `INFANTRY_HEALTH = 1`
     * every one of these is a death, and 1000 HP is only here so the failure
     * reads as a number instead of a corpse.
     */
    const level = asciiLevel(TALL_WALL)
    const grid = bakeNavGrid(level)
    const world = new World(level, { seed: 1 })
    const ordnance = createOrdnanceSystem(grid, { table: TABLE })
    world.addSystem(ordnance)
    const from = tileToWorld(11, 0, level.size)
    const man = world.spawn({
      kind: 'rifleman',
      team: 'player',
      x: from.x - 0.3,
      z: from.z - 0.3,
      health: 1000,
    })
    const behind = tileToWorld(9, 2, level.size)
    const victim = world.spawn({
      kind: 'rifleman',
      team: 'enemy',
      x: behind.x,
      z: behind.z,
      health: 1000,
    })
    world.tick()
    world.drainEvents()
    ordnance.launch(man.id, 'dart', { x: 10, y: 9 })
    for (let i = 0; i < 120; i += 1) {
      world.tick()
      world.drainEvents()
    }
    expect(world.get(victim.id)?.health).toBe(1000)
  })

  it('a ballistic projectile clears the same wall and lands beyond it', () => {
    // Side by side with the case above, from the same tile at the same target,
    // differing only in the `arc` field. If that field were ignored these two
    // would agree.
    const r = rig(WALLED)
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 17, y: 5 })
    r.run(300)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    const wall = r.at(10, 5)
    expect(boom.x).toBeGreaterThan(wall.x)
  })
})

describe('the Explosion event', () => {
  it('carries the position, the radius and the ordnance type', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    expect({
      ordnance: boom.ordnance,
      radiusTiles: boom.radiusTiles,
      source: boom.sourceId,
    }).toEqual({ ordnance: 'lob', radiusTiles: TABLE.lob.blastRadiusTiles, source: man.id })
  })

  it('is stamped with the tick it went off on', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const boom = r.explosions()[0]
    if (boom?.type !== 'Explosion') throw new Error('not an explosion')
    expect(boom.tick).toBeGreaterThan(1)
  })

  it('precedes the deaths it causes', () => {
    /**
     * The same ordering contract `ShotFired` holds against `UnitDied`, and for
     * the same reason: FX plays the fireball from the explosion and the fall
     * from the death. Reversed, the men drop before the grenade goes off.
     */
    const r = rig()
    const thrower = r.spawn(3, 5)
    r.spawn(9, 5, 'enemy', 1)
    r.run(1)
    r.ordnance.launch(thrower.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const boomAt = r.events.findIndex((e) => e.type === 'Explosion')
    const diedAt = r.events.findIndex((e) => e.type === 'UnitDied')
    expect(boomAt).toBeGreaterThanOrEqual(0)
    expect(diedAt).toBeGreaterThan(boomAt)
  })

  it('goes off even when it catches nobody', () => {
    // The event drives FX and sound, not just damage. A grenade thrown into an
    // empty field must still make a noise.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 17, y: 9 })
    r.run(300)
    expect(r.explosions()).toHaveLength(1)
  })
})

describe('the blast lands on the world', () => {
  it('kills a man standing on the aim point', () => {
    const r = rig()
    const thrower = r.spawn(3, 5)
    const victim = r.spawn(9, 5, 'enemy', 1)
    r.run(1)
    r.ordnance.launch(thrower.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    expect(r.world.isAlive(victim.id)).toBe(false)
  })

  it('wounds a man at the fringe without killing him', () => {
    // The falloff made visible in the world rather than in a returned number:
    // radius 3, two tiles out, a third of the peak taken off a tough target.
    const r = rig()
    const thrower = r.spawn(3, 5)
    const victim = r.spawn(11, 5, 'enemy', 1000)
    r.run(1)
    r.ordnance.launch(thrower.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    const after = r.world.get(victim.id)
    expect(after).toBeDefined()
    expect(after?.health).toBeLessThan(1000)
  })

  it('leaves a man well clear of it untouched', () => {
    const r = rig()
    const thrower = r.spawn(3, 5)
    const bystander = r.spawn(17, 9, 'enemy', 1000)
    r.run(1)
    r.ordnance.launch(thrower.id, 'lob', { x: 9, y: 5 })
    r.run(200)
    expect(r.world.get(bystander.id)?.health).toBe(1000)
  })

  it('can kill the man who threw it', () => {
    // FRIENDLY FIRE, REACHABLE AT LAST. `combat/system.ts` notes that the rifle
    // can never produce it because target selection skips your own team; this is
    // the ticket where that stops being true, and dropping a grenade at your own
    // feet is how a player discovers it.
    const r = rig()
    const fool = r.spawn(5, 5, 'player', 1)
    r.run(1)
    r.ordnance.launch(fool.id, 'lob', { x: 5, y: 5 })
    r.run(200)
    expect(r.world.isAlive(fool.id)).toBe(false)
  })
})

describe('the in-flight view is the caller`s to keep', () => {
  it('does not alias the system`s own array', () => {
    /**
     * THE OPTIMISATION SOMEONE WILL REACH FOR, and the tracer buffer already
     * caught it once: handing back the live array avoids an allocation and means
     * a renderer holding last frame's list watches its grenades teleport as the
     * slots beneath them are reused by later launches.
     */
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    const held = r.ordnance.inFlight()
    const first = held[0]
    expect(first).toBeDefined()
    const wasX = first?.x ?? 0
    r.run(20)
    expect(held[0]?.x).toBe(wasX)
  })

  it('hands back a different array each time', () => {
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    expect(r.ordnance.inFlight()).not.toBe(r.ordnance.inFlight())
  })

  it('reports projectiles in launch order', () => {
    const r = rig()
    const a = r.spawn(3, 5)
    const b = r.spawn(3, 6)
    const c = r.spawn(3, 7)
    r.run(1)
    r.ordnance.launch(a.id, 'lob', { x: 9, y: 5 })
    r.ordnance.launch(b.id, 'lob', { x: 9, y: 6 })
    r.ordnance.launch(c.id, 'lob', { x: 9, y: 7 })
    expect(r.ordnance.inFlight().map((p) => p.launcherId)).toEqual([a.id, b.id, c.id])
  })

  it('is empty before anything is thrown', () => {
    const r = rig()
    r.run(1)
    expect(r.ordnance.inFlight()).toEqual([])
    expect(r.ordnance.inFlightCount).toBe(0)
  })

  it('agrees with inFlightCount', () => {
    const r = rig()
    const a = r.spawn(3, 5)
    const b = r.spawn(3, 6)
    r.run(1)
    r.ordnance.launch(a.id, 'lob', { x: 9, y: 5 })
    r.ordnance.launch(b.id, 'lob', { x: 9, y: 6 })
    expect(r.ordnance.inFlight()).toHaveLength(r.ordnance.inFlightCount)
  })
})

describe('a projectile is not an entity', () => {
  it('throwing one spawns nothing into the world', () => {
    // The whole reason projectiles are the system's own bookkeeping: an entity
    // in the live array is a thing the combat system's target scan and the AI
    // both walk every tick, so a grenade in the air would be something soldiers
    // stop to shoot at.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    const before = r.world.entityCount
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(5)
    expect(r.world.entityCount).toBe(before)
  })

  it('a launcher who dies mid-flight does not take his grenade with him', () => {
    // The round is in the air. Recalling it because the thrower was shot is the
    // same mistake `combat/system.ts` refuses to make in its second pass.
    const r = rig()
    const man = r.spawn(3, 5)
    const victim = r.spawn(9, 5, 'enemy', 1)
    r.run(1)
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(2)
    r.world.despawn(man.id)
    r.run(300)
    expect(r.explosions()).toHaveLength(1)
    expect(r.world.isAlive(victim.id)).toBe(false)
  })
})

describe('determinism', () => {
  it('two identical runs produce identical event streams', () => {
    // Nothing here may draw from `rng` or depend on a `Map`'s iteration order.
    // The event stream is a stronger check than `World.stateHash`, which does
    // not see projectiles at all.
    const play = () => {
      const r = rig()
      const a = r.spawn(3, 5)
      const b = r.spawn(4, 8, 'enemy', 1000)
      r.run(1)
      r.ordnance.launch(a.id, 'lob', { x: 9, y: 5 })
      r.ordnance.launch(b.id, 'dart', { x: 5, y: 5 })
      r.run(400)
      return JSON.stringify(r.events)
    }
    expect(play()).toBe(play())
  })

  it('simultaneous detonations resolve in launch order', () => {
    const r = rig()
    const a = r.spawn(3, 5)
    const b = r.spawn(3, 6)
    r.run(1)
    r.ordnance.launch(a.id, 'lob', { x: 9, y: 5 })
    r.ordnance.launch(b.id, 'lob', { x: 9, y: 6 })
    r.run(300)
    const sources = r
      .explosions()
      .map((e) => (e.type === 'Explosion' ? e.sourceId : -1))
    expect(sources).toEqual([a.id, b.id])
  })

  it('draws nothing from the world`s PRNG', () => {
    // A spread cone or a damage roll would be the natural place to reach for it,
    // and it would make every mission with a grenade in it unreplayable.
    const r = rig()
    const man = r.spawn(3, 5)
    r.run(1)
    const before = r.world.rng.getState()
    r.ordnance.launch(man.id, 'lob', { x: 9, y: 5 })
    r.run(300)
    expect(r.world.rng.getState()).toBe(before)
  })
})
