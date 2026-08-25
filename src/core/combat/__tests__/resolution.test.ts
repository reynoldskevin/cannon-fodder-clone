import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { makeLevel } from '../../world/__tests__/fixture'
import {
  WEAPONS,
  RIFLE,
  INFANTRY_HEALTH,
  applyDamage,
  createCooldowns,
  readyToFire,
  markFired,
  inRange,
} from '../index'

/**
 * Ticket 011 — cooldowns, damage, death and attribution.
 *
 * "Faithful to the original's lethality — infantry die to a single hit."
 * The trap in that sentence is implementing lethality as a BOOLEAN. Health is a
 * value and damage is a value; one-shot death is what falls out of a rifle
 * doing `INFANTRY_HEALTH` damage, not a special case in the hit path. That is
 * the vehicles extension point (`ARCHITECTURE.md`) and it costs nothing today.
 *
 * FRIENDLY FIRE IS A FEATURE, not a bug to be guarded against — the original
 * lets you mow down your own squad, and the campaign's Boot Hill screen needs
 * to know who did it. So attribution must be correct rather than merely
 * present.
 */

const world = (): World => new World(makeLevel(), { seed: 1 })

const soldier = (w: World, team: 'player' | 'enemy', x = 0, z = 0) =>
  w.spawn({ kind: 'rifleman', team, x, z })

describe('WEAPONS', () => {
  it('declares the rifle', () => {
    expect(WEAPONS[RIFLE]).toBeDefined()
  })

  it('gives every weapon a positive damage, cooldown and range', () => {
    for (const [name, spec] of Object.entries(WEAPONS)) {
      expect({ name, ok: spec.damage > 0 }).toEqual({ name, ok: true })
      expect({ name, ok: spec.cooldownTicks > 0 }).toEqual({ name, ok: true })
      expect({ name, ok: spec.rangeTiles > 0 }).toEqual({ name, ok: true })
    }
  })

  it('makes the rifle one-shot lethal against infantry', () => {
    expect(WEAPONS[RIFLE]!.damage).toBeGreaterThanOrEqual(INFANTRY_HEALTH)
  })

  it('agrees with the health an unspecified spawn actually gets', () => {
    // `core/world` cannot import from `core/combat` — that is the wrong way up
    // the dependency stack — so the infantry hit point exists in both files and
    // "the two must agree" is a comment rather than a mechanism. This is the
    // mechanism. If either side is retuned alone, a rifle round stops being
    // lethal (or a jeep stops being tough) with nothing to say why.
    const w = world()
    const fresh = w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
    expect(fresh.health).toBe(INFANTRY_HEALTH)
  })

  it('keeps damage a value rather than a boolean', () => {
    // The vehicles extension point: a jeep with health 5 must survive a rifle
    // round without the hit path needing to learn what a jeep is.
    expect(typeof WEAPONS[RIFLE]!.damage).toBe('number')
    expect(INFANTRY_HEALTH).toBeGreaterThan(0)
  })

  it('gives the rifle a range that fits the camera', () => {
    // A weapon that outranges the visible area means units trade fire with
    // things the player cannot see, which reads as dying to nothing.
    expect(WEAPONS[RIFLE]!.rangeTiles).toBeGreaterThan(2)
    expect(WEAPONS[RIFLE]!.rangeTiles).toBeLessThan(30)
  })

  it('is the single tuning surface — specs are plain data', () => {
    const spec = WEAPONS[RIFLE]!
    expect(JSON.parse(JSON.stringify(spec))).toEqual({ ...spec })
  })
})

describe('inRange', () => {
  const R = 5

  it('accepts a target inside the radius', () => {
    expect(inRange(0, 0, 3, 0, R)).toBe(true)
    expect(inRange(0, 0, 0, 3, R)).toBe(true)
  })

  it('rejects a target beyond the radius', () => {
    expect(inRange(0, 0, 6, 0, R)).toBe(false)
  })

  it('accepts a target exactly at maximum range', () => {
    // The boundary is inclusive: a unit that has walked to exactly its maximum
    // range should fire, not stand there having arrived at a spot it cannot
    // shoot from.
    expect(inRange(0, 0, R, 0, R)).toBe(true)
  })

  it('measures euclidean distance, not chebyshev', () => {
    // (4,4) is 5.66 away, outside a radius of 5, even though both axes are
    // within it. Chebyshev would give every unit a square firing envelope.
    expect(inRange(0, 0, 4, 4, R)).toBe(false)
    expect(inRange(0, 0, 3, 4, R)).toBe(true)
  })

  it('handles a zero-length shot', () => {
    expect(inRange(2, 2, 2, 2, R)).toBe(true)
  })

  it('rejects rather than throws on non-finite input', () => {
    expect(inRange(0, 0, Number.NaN, 0, R)).toBe(false)
    expect(inRange(0, 0, Number.POSITIVE_INFINITY, 0, R)).toBe(false)
  })
})

describe('cooldowns', () => {
  it('starts every unit ready to fire', () => {
    const cd = createCooldowns()
    expect(readyToFire(cd, 1, 0)).toBe(true)
  })

  it('blocks a second shot inside the cooldown window', () => {
    const cd = createCooldowns()
    markFired(cd, 1, 0, WEAPONS[RIFLE]!)
    expect(readyToFire(cd, 1, 1)).toBe(false)
  })

  it('allows the next shot once the cooldown has elapsed', () => {
    const cd = createCooldowns()
    const spec = WEAPONS[RIFLE]!
    markFired(cd, 1, 0, spec)
    expect(readyToFire(cd, 1, spec.cooldownTicks - 1)).toBe(false)
    expect(readyToFire(cd, 1, spec.cooldownTicks)).toBe(true)
  })

  it('tracks each unit separately', () => {
    const cd = createCooldowns()
    markFired(cd, 1, 0, WEAPONS[RIFLE]!)
    expect(readyToFire(cd, 1, 1)).toBe(false)
    expect(readyToFire(cd, 2, 1)).toBe(true)
  })

  it('produces exactly the expected rate of fire over a minute', () => {
    // The number a designer will actually want to change, asserted as a rate
    // rather than as an internal counter.
    const cd = createCooldowns()
    const spec = WEAPONS[RIFLE]!
    let shots = 0
    for (let tick = 0; tick < 3600; tick++) {
      if (readyToFire(cd, 1, tick)) {
        shots++
        markFired(cd, 1, tick, spec)
      }
    }
    expect(shots).toBe(Math.floor(3600 / spec.cooldownTicks) + 1)
  })

  it('forgets a despawned unit so the map does not grow all mission', () => {
    const cd = createCooldowns()
    for (let id = 0; id < 100; id++) markFired(cd, id, 0, WEAPONS[RIFLE]!)
    expect(cd.size).toBe(100)
    cd.forget(50)
    expect(cd.size).toBe(99)
    expect(readyToFire(cd, 50, 1)).toBe(true)
  })
})

describe('applyDamage', () => {
  it('reduces health by the damage dealt', () => {
    const w = world()
    const target = w.spawn({ kind: 'jeep', team: 'enemy', x: 0, z: 0, health: 5 })
    applyDamage(w, target.id, 2, null)
    expect(w.get(target.id)?.health).toBe(3)
  })

  it('does not kill a target that survives', () => {
    const w = world()
    const target = w.spawn({ kind: 'jeep', team: 'enemy', x: 0, z: 0, health: 5 })
    expect(applyDamage(w, target.id, 2, null)).toBe(false)
    expect(w.isAlive(target.id)).toBe(true)
  })

  it('kills infantry with a single rifle round', () => {
    const w = world()
    const target = soldier(w, 'enemy')
    expect(applyDamage(w, target.id, WEAPONS[RIFLE]!.damage, null)).toBe(true)
    expect(w.isAlive(target.id)).toBe(false)
  })

  it('despawns the dead', () => {
    const w = world()
    const target = soldier(w, 'enemy')
    applyDamage(w, target.id, 99, null)
    expect(w.get(target.id)).toBeUndefined()
    expect(w.entityCount).toBe(0)
  })

  it('emits UnitDied with team, id and killer', () => {
    const w = world()
    const killer = soldier(w, 'player')
    const target = soldier(w, 'enemy')
    w.drainEvents()
    applyDamage(w, target.id, 99, killer.id)
    const died = w.drainEvents().find((e) => e.type === 'UnitDied')
    expect(died).toMatchObject({
      type: 'UnitDied',
      id: target.id,
      team: 'enemy',
      killerId: killer.id,
      friendlyFire: false,
    })
  })

  it('emits UnitDied before UnitDespawned, so consumers see the death', () => {
    // FX subscribes to UnitDied to spawn a corpse at the entity's position. If
    // the despawn is announced first, a careful consumer has already dropped
    // the entity and the corpse appears at the origin.
    const w = world()
    const target = soldier(w, 'enemy', 3, 4)
    w.drainEvents()
    applyDamage(w, target.id, 99, null)
    const types = w.drainEvents().map((e) => e.type)
    expect(types.indexOf('UnitDied')).toBeLessThan(types.indexOf('UnitDespawned'))
  })

  it('emits nothing and reports false for an unknown target', () => {
    const w = world()
    w.drainEvents()
    expect(applyDamage(w, 4242, 10, null)).toBe(false)
    expect(w.drainEvents()).toHaveLength(0)
  })

  it('is idempotent against a target already dead', () => {
    const w = world()
    const target = soldier(w, 'enemy')
    applyDamage(w, target.id, 99, null)
    w.drainEvents()
    expect(applyDamage(w, target.id, 99, null)).toBe(false)
    expect(w.drainEvents()).toHaveLength(0)
  })

  it('ignores non-positive damage rather than healing', () => {
    const w = world()
    const target = w.spawn({ kind: 'jeep', team: 'enemy', x: 0, z: 0, health: 5 })
    applyDamage(w, target.id, -10, null)
    expect(w.get(target.id)?.health).toBe(5)
  })

  it('accepts a null killer for a death with no attributable shooter', () => {
    const w = world()
    const target = soldier(w, 'enemy')
    w.drainEvents()
    applyDamage(w, target.id, 99, null)
    const died = w.drainEvents().find((e) => e.type === 'UnitDied')
    expect(died).toMatchObject({ killerId: null, friendlyFire: false })
  })
})

describe('friendly fire attribution', () => {
  it('flags a kill on your own team as friendly fire', () => {
    const w = world()
    const killer = soldier(w, 'player')
    const victim = soldier(w, 'player')
    w.drainEvents()
    applyDamage(w, victim.id, 99, killer.id)
    const died = w.drainEvents().find((e) => e.type === 'UnitDied')
    expect(died).toMatchObject({ team: 'player', killerId: killer.id, friendlyFire: true })
  })

  it('does not flag a kill on the other team', () => {
    const w = world()
    const killer = soldier(w, 'player')
    const victim = soldier(w, 'enemy')
    w.drainEvents()
    applyDamage(w, victim.id, 99, killer.id)
    const died = w.drainEvents().find((e) => e.type === 'UnitDied')
    expect(died).toMatchObject({ friendlyFire: false })
  })

  it('flags enemy-on-enemy fire as friendly too', () => {
    // The campaign counts it, and an enemy grenade that kills its own squad is
    // one of the original's small joys.
    const w = world()
    const killer = soldier(w, 'enemy')
    const victim = soldier(w, 'enemy')
    w.drainEvents()
    applyDamage(w, victim.id, 99, killer.id)
    expect(w.drainEvents().find((e) => e.type === 'UnitDied')).toMatchObject({ friendlyFire: true })
  })

  it('does not flag friendly fire when the killer has already died', () => {
    // The killer despawned between firing and the round landing. Attribution
    // must not crash or silently invent a team.
    const w = world()
    const killer = soldier(w, 'player')
    const victim = soldier(w, 'enemy')
    w.despawn(killer.id)
    w.drainEvents()
    applyDamage(w, victim.id, 99, killer.id)
    const died = w.drainEvents().find((e) => e.type === 'UnitDied')
    expect(died).toMatchObject({ killerId: killer.id, friendlyFire: false })
  })

  it('does not flag a unit killing itself as friendly fire against another', () => {
    const w = world()
    const victim = soldier(w, 'player')
    w.drainEvents()
    applyDamage(w, victim.id, 99, victim.id)
    expect(w.drainEvents().find((e) => e.type === 'UnitDied')).toMatchObject({
      killerId: victim.id,
      friendlyFire: true,
    })
  })
})
