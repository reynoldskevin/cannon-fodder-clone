import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { falloffAt, resolveBlast } from '../blast'
import type { OrdnanceSpec } from '../table'

/**
 * Ticket 015 — the blast.
 *
 * WHY THIS IS A SEPARATE, PURE FUNCTION rather than something the system does
 * inline. A blast is the first thing in this game that damages more than one
 * entity from one cause, and every interesting question about it — who is inside
 * the radius, how much each takes, whose side they are on, what is between them
 * and the centre — is answerable without a tick loop or a projectile. Resolving
 * it in the middle of the flight pass would put all four behind a grenade that
 * has to be thrown first.
 *
 * IT COMPUTES, IT DOES NOT APPLY. `resolveBlast` returns who takes what; the
 * system calls `applyDamage`. That split is what lets these tests assert exact
 * damage numbers against a soldier who would otherwise be dead — at
 * `INFANTRY_HEALTH = 1` every blast that reaches a man at all kills him, so a
 * function that applied its own damage could only ever be tested as a body count.
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
 * A lone solid tile at (7, 2) — a tree — with a wall at column 10 beside it.
 * For the case of a grenade that lands IN the scenery, which on a jungle map is
 * an ordinary throw rather than an edge case.
 */
const TREE_AND_WALL = `
  ....................
  ..........#.........
  .......#..#.........
  ..........#.........
  ....................
`

/** A wall down column 10, with a gap at row 2 to fire through. */
const WALLED = `
  ..........#.........
  ..........#.........
  ....................
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
  fuseTicks: 120,
  blastRadiusTiles: 4,
  peakDamage: 100,
  falloff: 'linear',
  cooldownTicks: 30,
  ammoCost: 1,
  damagesFriendlies: true,
  ...over,
})

function rig(art = OPEN) {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  return {
    world,
    grid,
    level,
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy' = 'enemy', health = 1000) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    at(tileX: number, tileY: number) {
      return tileToWorld(tileX, tileY, level.size)
    },
  }
}

/** The damage `id` takes, or 0 if the blast did not reach it. */
const damageTo = (hits: readonly { id: number; damage: number }[], id: number): number =>
  hits.find((h) => h.id === id)?.damage ?? 0

describe('the falloff curves are what they are named', () => {
  it('every curve is full strength at the centre', () => {
    // `curve(0) = 1` is the invariant that makes `peakDamage` mean peak damage.
    // A curve that started anywhere else would silently retune every ordnance
    // row in the table at once.
    for (const curve of ['linear', 'constant', 'quadratic'] as const) {
      expect({ curve, at0: falloffAt(curve, 0) }).toEqual({ curve, at0: 1 })
    }
  })

  it('linear falls off in a straight line', () => {
    expect(falloffAt('linear', 0.25)).toBeCloseTo(0.75, 9)
    expect(falloffAt('linear', 0.5)).toBeCloseTo(0.5, 9)
    expect(falloffAt('linear', 0.75)).toBeCloseTo(0.25, 9)
  })

  it('quadratic falls off faster than linear everywhere in between', () => {
    // The distinction that makes naming two curves worth anything. If they
    // agreed, the field would be decoration.
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const q = falloffAt('quadratic', t)
      const l = falloffAt('linear', t)
      expect({ t, faster: q < l }).toEqual({ t, faster: true })
    }
  })

  it('constant does not fall off at all inside the radius', () => {
    for (const t of [0, 0.25, 0.5, 0.99]) {
      expect({ t, v: falloffAt('constant', t) }).toEqual({ t, v: 1 })
    }
  })

  it('every curve is spent at the edge and beyond', () => {
    for (const curve of ['linear', 'constant', 'quadratic'] as const) {
      expect({ curve, at1: falloffAt(curve, 1) }).toEqual({ curve, at1: 0 })
      expect({ curve, past: falloffAt(curve, 2.5) }).toEqual({ curve, past: 0 })
    }
  })

  it('never returns a negative, which would heal the victim', () => {
    for (const curve of ['linear', 'constant', 'quadratic'] as const) {
      for (const t of [1.0001, 2, 50]) {
        expect({ curve, t, ok: falloffAt(curve, t) >= 0 }).toEqual({ curve, t, ok: true })
      }
    }
  })
})

describe('blast damage falls off with distance', () => {
  it('a man at the centre takes the peak', () => {
    const r = rig()
    const victim = r.spawn(5, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, victim.id)).toBeCloseTo(100, 6)
  })

  it('a man at half the radius takes half, under a linear curve', () => {
    // Radius 4, victim 2 tiles away: exactly the 50% case the criteria name.
    const r = rig()
    const victim = r.spawn(7, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, victim.id)).toBeCloseTo(50, 6)
  })

  it('a man at the edge of the radius takes nothing', () => {
    // 100% of the radius. A linear curve reaches exactly zero here, and
    // `applyDamage` already ignores non-positive damage — so the boundary needs
    // no special case, and this asserts there is not one hiding.
    const r = rig()
    const victim = r.spawn(9, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, victim.id)).toBe(0)
  })

  it('a man outside the radius is not in the list at all', () => {
    const r = rig()
    const victim = r.spawn(12, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(hits.some((h) => h.id === victim.id)).toBe(false)
  })

  it('the declared curve is the one used', () => {
    // Same geometry, same radius, same peak — only the named curve differs. If
    // the field were ignored these would be equal.
    const r = rig()
    const victim = r.spawn(7, 5)
    const centre = r.at(5, 5)
    const linear = resolveBlast(r.world, r.grid, spec({ falloff: 'linear' }), centre.x, centre.z, null)
    const quad = resolveBlast(
      r.world,
      r.grid,
      spec({ falloff: 'quadratic' }),
      centre.x,
      centre.z,
      null,
    )
    const flat = resolveBlast(
      r.world,
      r.grid,
      spec({ falloff: 'constant' }),
      centre.x,
      centre.z,
      null,
    )
    expect(damageTo(quad, victim.id)).toBeLessThan(damageTo(linear, victim.id))
    expect(damageTo(flat, victim.id)).toBeGreaterThan(damageTo(linear, victim.id))
  })

  it('measures distance as a circle, not a square', () => {
    // Chebyshev would put the diagonal man inside the radius. A blast with
    // corners is one players find by standing at them.
    const r = rig()
    const diagonal = r.spawn(8, 8) // 3,3 away — 4.24 true distance, radius 4
    const straight = r.spawn(8, 5) // 3 away
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect({
      diagonalHit: hits.some((h) => h.id === diagonal.id),
      straightHit: damageTo(hits, straight.id) > 0,
    }).toEqual({ diagonalHit: false, straightHit: true })
  })

  it('scales with the declared peak damage', () => {
    const r = rig()
    const victim = r.spawn(6, 5)
    const centre = r.at(5, 5)
    const weak = resolveBlast(r.world, r.grid, spec({ peakDamage: 10 }), centre.x, centre.z, null)
    const strong = resolveBlast(r.world, r.grid, spec({ peakDamage: 40 }), centre.x, centre.z, null)
    expect(damageTo(strong, victim.id)).toBeCloseTo(damageTo(weak, victim.id) * 4, 6)
  })

  it('a larger radius reaches a man a smaller one does not', () => {
    const r = rig()
    const victim = r.spawn(11, 5) // 6 tiles out
    const centre = r.at(5, 5)
    const small = resolveBlast(r.world, r.grid, spec({ blastRadiusTiles: 4 }), centre.x, centre.z, null)
    const large = resolveBlast(r.world, r.grid, spec({ blastRadiusTiles: 8 }), centre.x, centre.z, null)
    expect(damageTo(small, victim.id)).toBe(0)
    expect(damageTo(large, victim.id)).toBeGreaterThan(0)
  })
})

describe('cover stops a blast', () => {
  it('a man behind a wall takes nothing', () => {
    // THE REASON COVER MEANS ANYTHING AGAINST ORDNANCE. Without this a grenade
    // thrown at a bunker's outside wall kills everyone inside it, and the
    // building is decoration.
    const r = rig(WALLED)
    const sheltered = r.spawn(11, 5)
    const centre = r.at(9, 5) // the wall at column 10 is directly between them
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, sheltered.id)).toBe(0)
  })

  it('a man the same distance away in the open takes the damage', () => {
    // The control. Without it, a blast that reached nobody at all would satisfy
    // the case above.
    const r = rig(WALLED)
    const exposed = r.spawn(7, 5)
    const centre = r.at(9, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, exposed.id)).toBeGreaterThan(0)
  })

  it('a man reachable through the gap is still caught', () => {
    // Row 2 is the gap in the wall. Cover blocks a line, not a direction — a
    // blast that treated the whole column as solid would be checking the wrong
    // thing and would happen to pass the case above.
    const r = rig(WALLED)
    const throughGap = r.spawn(11, 2)
    const centre = r.at(9, 2)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(damageTo(hits, throughGap.id)).toBeGreaterThan(0)
  })
})

describe('a blast that lands in the scenery is not swallowed by it', () => {
  it('still catches the man standing next to the tree it landed in', () => {
    /**
     * THE CASE THAT MAKES OR BREAKS ORDNANCE ON THIS MAP. `hasLineOfSight`
     * refuses outright when the SOURCE tile is solid — a rifle inside a rock
     * sees nothing, which is right for a rifle — so a blast centred on a canopy
     * tile would report zero victims in every direction. The level-1 repaint put
     * over a thousand canopy tiles on the map, so "the grenade landed in a tree"
     * is not an edge case, it is most throws; and a grenade that lands a foot
     * from a man and does nothing reads as the weapon being broken.
     *
     * So the centre is resolved from the nearest passable tile when its own is
     * solid. The blast is not blocked BY ITSELF. Distance is still measured from
     * where it actually went off.
     */
    const r = rig(TREE_AND_WALL)
    const beside = r.spawn(8, 2)
    const centre = r.at(7, 2) // a solid tile
    const hits = resolveBlast(r.world, r.grid, spec({ blastRadiusTiles: 6 }), centre.x, centre.z, null)
    expect(damageTo(hits, beside.id)).toBeGreaterThan(0)
  })

  it('but a wall further out still shelters the man behind it', () => {
    // The other half, and the reason this is not simply "skip the cover test
    // when the centre is solid". Landing in a tree must not turn a grenade into
    // one that shoots through bunkers.
    const r = rig(TREE_AND_WALL)
    const sheltered = r.spawn(11, 2)
    const centre = r.at(7, 2)
    const hits = resolveBlast(r.world, r.grid, spec({ blastRadiusTiles: 6 }), centre.x, centre.z, null)
    expect(damageTo(hits, sheltered.id)).toBe(0)
  })
})

describe('the friendly-fire flag decides whose side is safe', () => {
  it('ordnance that damages friendlies damages both teams', () => {
    // FRIENDLY FIRE BECOMES REACHABLE HERE, and `combat/system.ts` says as much
    // in its own comments: the rifle can never produce it because target
    // selection skips your own team. A grenade does not ask.
    const r = rig()
    const mate = r.spawn(6, 5, 'player')
    const foe = r.spawn(4, 5, 'enemy')
    const centre = r.at(5, 5)
    const hits = resolveBlast(
      r.world,
      r.grid,
      spec({ damagesFriendlies: true }),
      centre.x,
      centre.z,
      'player',
    )
    expect({
      mate: damageTo(hits, mate.id) > 0,
      foe: damageTo(hits, foe.id) > 0,
    }).toEqual({ mate: true, foe: true })
  })

  it('ordnance that does not spares the launcher`s team only', () => {
    const r = rig()
    const mate = r.spawn(6, 5, 'player')
    const foe = r.spawn(4, 5, 'enemy')
    const centre = r.at(5, 5)
    const hits = resolveBlast(
      r.world,
      r.grid,
      spec({ damagesFriendlies: false }),
      centre.x,
      centre.z,
      'player',
    )
    expect({
      mate: damageTo(hits, mate.id) > 0,
      foe: damageTo(hits, foe.id) > 0,
    }).toEqual({ mate: false, foe: true })
  })

  it('reads the launcher`s team, not a hardcoded side', () => {
    // The same spec thrown by the other team must spare the other team. A
    // `team === 'player'` shortcut passes the case above and fails this one.
    const r = rig()
    const playerMan = r.spawn(6, 5, 'player')
    const enemyMan = r.spawn(4, 5, 'enemy')
    const centre = r.at(5, 5)
    const hits = resolveBlast(
      r.world,
      r.grid,
      spec({ damagesFriendlies: false }),
      centre.x,
      centre.z,
      'enemy',
    )
    expect({
      player: damageTo(hits, playerMan.id) > 0,
      enemy: damageTo(hits, enemyMan.id) > 0,
    }).toEqual({ player: true, enemy: false })
  })

  it('with no launcher team, nobody is spared', () => {
    // A minefield, a burning fuel drum, a scripted demolition: ordnance with no
    // owner belongs to no side, and `null` must not accidentally match a team.
    const r = rig()
    const playerMan = r.spawn(6, 5, 'player')
    const enemyMan = r.spawn(4, 5, 'enemy')
    const centre = r.at(5, 5)
    const hits = resolveBlast(
      r.world,
      r.grid,
      spec({ damagesFriendlies: false }),
      centre.x,
      centre.z,
      null,
    )
    expect({
      player: damageTo(hits, playerMan.id) > 0,
      enemy: damageTo(hits, enemyMan.id) > 0,
    }).toEqual({ player: true, enemy: true })
  })
})

describe('the result is ordered and self-consistent', () => {
  it('reports victims in spawn order, so two runs agree', () => {
    // `world.entities` order is spawn order and ticket 005 guarantees it stable.
    // Anything else here — a `Map`, a sort by distance with no tie-break — is a
    // place two identical missions can diverge.
    const r = rig()
    const a = r.spawn(6, 5)
    const b = r.spawn(4, 5)
    const c = r.spawn(5, 6)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id, c.id])
  })

  it('names each victim exactly once', () => {
    const r = rig()
    for (let i = 3; i <= 7; i += 1) r.spawn(i, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)
    const ids = hits.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('an empty world blasts nobody rather than throwing', () => {
    const r = rig()
    const centre = r.at(5, 5)
    expect(resolveBlast(r.world, r.grid, spec({}), centre.x, centre.z, null)).toEqual([])
  })

  it('a zero radius reaches nobody, rather than dividing by zero', () => {
    // `d / radius` is `NaN` at the centre and `Infinity` elsewhere, and a `NaN`
    // damage subtracted from health silently makes a soldier unkillable forever.
    const r = rig()
    const victim = r.spawn(5, 5)
    const centre = r.at(5, 5)
    const hits = resolveBlast(r.world, r.grid, spec({ blastRadiusTiles: 0 }), centre.x, centre.z, null)
    expect(damageTo(hits, victim.id)).toBe(0)
    expect(hits.every((h) => Number.isFinite(h.damage))).toBe(true)
  })

  it('never reports a non-finite or negative damage', () => {
    const r = rig()
    for (let i = 2; i <= 8; i += 1) r.spawn(i, 5)
    const centre = r.at(5, 5)
    for (const falloff of ['linear', 'constant', 'quadratic'] as const) {
      const hits = resolveBlast(r.world, r.grid, spec({ falloff }), centre.x, centre.z, null)
      expect({
        falloff,
        ok: hits.every((h) => Number.isFinite(h.damage) && h.damage > 0),
      }).toEqual({ falloff, ok: true })
    }
  })
})
