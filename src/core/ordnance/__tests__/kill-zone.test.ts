import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { resolveBlast } from '../blast'
import { ORDNANCE } from '../table'
import { INFANTRY_HEALTH } from '../../combat/weapons'

/**
 * Ticket 071 — how many squares a blast actually clears.
 *
 * THE ROCKET USED TO HAVE THE SMALLER KILL ZONE, WHICH IS BACKWARDS. Measured
 * off the shipped table before this ticket: a grenade killed out to 1.875 tiles
 * — the whole 3x3 block of tile centres — and a rocket only to 1.18, which is
 * the impact tile and its four orthogonal neighbours. The heavier, slower,
 * scarcer weapon cleared five squares where the thing you can throw every second
 * and a half cleared nine.
 *
 * RADIUS IS NOT KILL ZONE, and the difference is the whole subtlety here.
 * `blastRadiusTiles` is where damage reaches ZERO; a man dies where it drops
 * below `INFANTRY_HEALTH`, which is much closer in. The falloff curve sets the
 * ratio between the two — 0.75 of the radius for the grenade's linear curve,
 * `1 - sqrt(1/peak)` for the rocket's quadratic — so reading the radius off the
 * table and calling it the kill zone is wrong by a factor that differs per
 * weapon. Every case below counts BODIES, not radii.
 *
 * COUNTED AGAINST THE REAL TABLE, never a fixture. `blast.test.ts` next door
 * uses synthetic specs to pin the mechanism; this file is about the two rows the
 * game actually ships, so a retune that broke the promise would fail here rather
 * than pass a test about an invented weapon.
 */

/** Open ground, big enough that a 5x5 kill zone is nowhere near an edge. */
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
  ....................
  ....................
`

/**
 * Stand a man on every tile within `reach` of the centre and report which ones
 * the blast KILLS, as `dx,dy` offsets.
 *
 * REAL ENTITIES AT REAL WORLD POSITIONS, run through `resolveBlast` — not the
 * falloff formula evaluated by hand. A test that recomputed the curve would
 * agree with itself no matter what the blast code did with line of sight, team
 * filtering or the `t >= 1` boundary.
 *
 * `health` IS `INFANTRY_HEALTH`, so "killed" means what it means in the game: a
 * man is dead when the damage he takes is at least the health he has.
 */
function killedOffsets(ordnance: string, reach = 4): string[] {
  const level = asciiLevel(OPEN)
  const world = new World(level, { seed: 1 })
  const grid = bakeNavGrid(level)
  const spec = ORDNANCE[ordnance]
  if (spec === undefined) throw new Error(`no such ordnance: ${ordnance}`)

  const cx = 9
  const cy = 5
  const ids = new Map<number, string>()
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const p = tileToWorld(cx + dx, cy + dy, level.size)
      // `player` so the friendly-fire flag is exercised from the enemy's blast:
      // both rows set `damagesFriendlies`, so nobody is spared either way.
      const man = world.spawn({
        kind: 'rifleman',
        team: 'player',
        x: p.x,
        z: p.z,
        health: INFANTRY_HEALTH,
      })
      ids.set(man.id, `${String(dx)},${String(dy)}`)
    }
  }

  const centre = tileToWorld(cx, cy, level.size)
  const hits = resolveBlast(world, grid, spec, centre.x, centre.z, null)

  const killed: string[] = []
  for (const hit of hits) {
    const at = ids.get(hit.id)
    if (at !== undefined && hit.damage >= INFANTRY_HEALTH) killed.push(at)
  }
  return killed.sort()
}

/** Every `dx,dy` inside a square block of `side` tiles centred on the impact. */
function block(side: number): string[] {
  const half = (side - 1) / 2
  const out: string[] = []
  for (let dy = -half; dy <= half; dy += 1) {
    for (let dx = -half; dx <= half; dx += 1) out.push(`${String(dx)},${String(dy)}`)
  }
  return out.sort()
}

describe('a grenade clears a 3x3', () => {
  it('kills exactly nine squares', () => {
    expect(killedOffsets('grenade')).toEqual(block(3))
  })

  it('and the ninth is a CORNER, not just the four beside it', () => {
    /**
     * THE CASE THAT SEPARATES A 3x3 FROM A PLUS. A corner sits at 1.414 tiles
     * where an orthogonal neighbour is at 1.0, so a lethal radius anywhere
     * between them kills five squares and looks, from a body count alone, like a
     * blast that is nearly right. This is the shape the rocket used to have.
     */
    const killed = killedOffsets('grenade')
    for (const corner of ['1,1', '-1,1', '1,-1', '-1,-1']) {
      expect({ corner, killed: killed.includes(corner) }).toEqual({ corner, killed: true })
    }
  })

  it('and a man one square further out lives', () => {
    // Two tiles due east is 2.0 away, outside the 1.5 lethal radius. The blast
    // still REACHES that far on some settings — this is about who dies.
    const killed = killedOffsets('grenade')
    for (const spared of ['2,0', '0,2', '-2,0', '0,-2', '2,2']) {
      expect({ spared, killed: killed.includes(spared) }).toEqual({ spared, killed: false })
    }
  })
})

describe('a rocket clears a 5x5', () => {
  it('kills exactly twenty-five squares', () => {
    expect(killedOffsets('rocket')).toEqual(block(5))
  })

  it('including the far corners, which are the hardest tiles to reach', () => {
    /**
     * A 5x5's corner is 2.83 tiles out — further than a tile TWO rings away on
     * the axis (2.0) and further than the 3-ring axis tile is close (3.0). Any
     * lethal radius that catches the corners but not `3,0` is a narrow band, and
     * these two cases are the two edges of it.
     */
    const killed = killedOffsets('rocket')
    for (const corner of ['2,2', '-2,2', '2,-2', '-2,-2']) {
      expect({ corner, killed: killed.includes(corner) }).toEqual({ corner, killed: true })
    }
  })

  it('and stops there — the sixth ring survives', () => {
    const killed = killedOffsets('rocket')
    for (const spared of ['3,0', '0,3', '-3,0', '3,1', '3,3']) {
      expect({ spared, killed: killed.includes(spared) }).toEqual({ spared, killed: false })
    }
  })
})

describe('and the heavier weapon is the deadlier one', () => {
  it('the rocket kills strictly more than the grenade', () => {
    /**
     * THE INVERSION THIS TICKET EXISTS TO FIX, stated as the one comparison that
     * cannot be satisfied by getting both footprints wrong in the same
     * direction. Before this ticket it read 5 against 9 — backwards.
     */
    const grenade = killedOffsets('grenade')
    const rocket = killedOffsets('rocket')
    expect(rocket.length).toBeGreaterThan(grenade.length)
    expect({ grenade: grenade.length, rocket: rocket.length }).toEqual({ grenade: 9, rocket: 25 })
  })

  it('and its kill zone CONTAINS the grenade`s', () => {
    // Not merely bigger by count: every square a grenade clears, a rocket
    // clears. Two blast shapes of equal area that overlapped partially would
    // pass a count comparison and mean something quite different in play.
    const grenade = killedOffsets('grenade')
    const rocket = new Set(killedOffsets('rocket'))
    for (const square of grenade) {
      expect({ square, alsoRocket: rocket.has(square) }).toEqual({ square, alsoRocket: true })
    }
  })
})

describe('and the table still says what it always said', () => {
  it('both weapons still hurt their own side', () => {
    // Unchanged and load-bearing: these radii are what a player has to keep his
    // own squad out of, and a retune that quietly spared friendlies would make
    // the bigger blast free.
    expect(ORDNANCE['grenade']?.damagesFriendlies).toBe(true)
    expect(ORDNANCE['rocket']?.damagesFriendlies).toBe(true)
  })

  it('and the kill zone is derived from the row, not written down twice', () => {
    /**
     * THE ONLY PLACE THE NUMBERS LIVE IS THE TABLE. This case reproduces the
     * lethal radius from `peakDamage`, `falloff` and `blastRadiusTiles` and
     * checks it against the footprints counted above — so a future edit that
     * changed a row without changing the kill zone, or the reverse, cannot pass
     * both halves of this file.
     */
    const lethalRadius = (name: string): number => {
      const row = ORDNANCE[name]
      if (row === undefined) throw new Error(name)
      const share = INFANTRY_HEALTH / row.peakDamage
      const t = row.falloff === 'quadratic' ? 1 - Math.sqrt(share) : 1 - share
      return row.blastRadiusTiles * t
    }
    // A 3x3's corner is at sqrt(2); the next ring out is at 2.
    expect(lethalRadius('grenade')).toBeGreaterThanOrEqual(Math.SQRT2)
    expect(lethalRadius('grenade')).toBeLessThan(2)
    // A 5x5's corner is at sqrt(8); the next ring out is at 3.
    expect(lethalRadius('rocket')).toBeGreaterThanOrEqual(Math.sqrt(8))
    expect(lethalRadius('rocket')).toBeLessThan(3)
  })
})
