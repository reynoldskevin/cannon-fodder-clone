import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { bakeNavGrid } from '../../pathing/navgrid'
import { tileToWorld } from '../../view/projection'
import { createCombatSystem, AIM_CORRIDOR_TILES, WEAPONS, RIFLE } from '../index'
import type { SimEvent } from '../../world/events'
import type { Entity } from '../../world/world'

/**
 * Ticket 011c — a round hits what is in front of it.
 *
 * AIMING IS A DIRECTION, NOT A DESTINATION. Right-clicking used to have to land
 * within two tiles of a man to hit him, because `pickTarget` ranked candidates
 * by nearness to the AIM POINT — so a click into the gap between two enemies, or
 * at the ground behind one, hit nobody at all. That is not how pointing a rifle
 * works, and it is not how a player thinks he is playing.
 *
 * HALF OF THIS WAS ALREADY BUILT, WHICH IS THE POINT. Ticket 011a made the ROUND
 * travel along the line the player pointed, out to `rangeTiles`, stopping at the
 * near face of whatever cover it meets — and then said, in capitals, that target
 * selection was untouched by any of it. So the game drew the right tracer and
 * damaged somebody chosen by a different rule. This ticket makes selection use
 * the ray the tracer is already drawn along, which REMOVES a second answer
 * rather than adding one: after it the tracer and the damage cannot disagree
 * about where the round went.
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
 * ONE blocking tile at (8, 6), beside the line of fire rather than on it.
 *
 * The centre line from (4,5) straight along +x never touches it, so the round's
 * own reach is unclamped — but a man standing half a tile high of that line sits
 * in tile (9,6), and the sightline to HIM runs right through it. That is the
 * only geometry that can tell the two cover tests apart.
 */
const BESIDE = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ........#...........
  ....................
  ....................
  ....................
`

/** A wall down x=12, so a man at x=15 is behind cover from x=4. */
const WALLED = `
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
  ............#.......
`

function rig(art = OPEN) {
  const level = asciiLevel(art)
  const world = new World(level, { seed: 1 })
  // NOT the both-teams default: this suite is about COMMANDED fire, and a
  // shooter who also auto-engages would hit men no order ever pointed at, which
  // is the one thing every assertion below has to be able to rule out.
  const combat = createCombatSystem(bakeNavGrid(level), { autoEngageTeams: [] })
  world.addSystem(combat)
  return {
    world,
    combat,
    /** Spawn at a tile CENTRE. Tough by default, so a man survives to be counted. */
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy', health = 1000): Entity {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    /** Spawn off a tile centre, which is where a walking man actually stands. */
    spawnAt(worldX: number, worldZ: number, team: 'player' | 'enemy', health = 1000): Entity {
      return world.spawn({ kind: 'rifleman', team, x: worldX, z: worldZ, health })
    },
    at(tileX: number, tileY: number) {
      const p = tileToWorld(tileX, tileY, level.size)
      return { x: p.x, z: p.z }
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

const rifle = () => {
  const spec = WEAPONS[RIFLE]
  if (spec === undefined) throw new Error('no rifle')
  return spec
}

/** Which entity the first shot of the run named, or `null` for suppressing fire. */
const victimOf = (shots: readonly SimEvent[]): number | null => {
  const first = shots[0]
  if (first === undefined || first.type !== 'ShotFired') return null
  return first.targetId
}

describe('the aim point is a direction, not a destination', () => {
  it('a click SHORT of a man still reaches him', () => {
    /**
     * The clearest statement of the change. The order names a tile two along;
     * the man is six along. Under the old rule he was four tiles from the aim
     * point and therefore outside the two-tile tolerance, so the round hit
     * nothing at all — while the tracer, since ticket 011a, was already being
     * drawn the full eight tiles past him.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const enemy = r.spawn(10, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 6, y: 5 })
    expect(victimOf(r.run(4))).toBe(enemy.id)
  })

  it('and a click PAST him hits him too', () => {
    // The other side: the player pointed at open ground behind the man. The
    // round does not travel to the click and stop; it travels down the line and
    // meets him on the way.
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const enemy = r.spawn(8, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 11, y: 5 })
    expect(victimOf(r.run(4))).toBe(enemy.id)
  })

  it('the round carries its own range, not the distance to the click', () => {
    /**
     * "Bullets should reach a set distance, whatever the maximum distance is of
     * the current shot." A click one tile ahead fires the full eight — the
     * distance of a click is not something anybody aims, and a rifle whose reach
     * depended on it would be unusable.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const enemy = r.spawn(4 + rifle().rangeTiles, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 5, y: 5 })
    expect(victimOf(r.run(4))).toBe(enemy.id)
  })

  it('but not past its range, however far away the click was', () => {
    // The bound the ray is still subject to. Aiming at the far wall does not
    // lengthen the rifle.
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    r.spawn(4 + rifle().rangeTiles + 2, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 19, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
  })
})

describe('the FIRST man along the line takes it', () => {
  it('an enemy in front of the one you clicked gets the round', () => {
    /**
     * THE BEHAVIOURAL HEART OF THE TICKET, and the case the old rule got exactly
     * backwards: it would have picked the man nearest the AIM POINT — the far
     * one, the one clicked — and put the round through the near one to reach
     * him. Ranking by distance ALONG the ray is what makes a bullet a bullet.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const near = r.spawn(7, 5, 'enemy')
    const far = r.spawn(10, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 10, y: 5 })
    const victim = victimOf(r.run(4))
    expect(victim).toBe(near.id)
    // Stated on the SAME shot rather than on a second `run`, which would fire
    // nothing at all inside the 32-tick cooldown and make `not.toBe` pass
    // against a `null` that proves nothing.
    expect(victim).not.toBe(far.id)
  })

  it('and the far one is reachable once the near one is gone', () => {
    // The control. Without it the case above is satisfied by a rule that always
    // picks the nearest enemy and ignores the aim entirely — which is the
    // AUTO-ENGAGE rule, and would make commanded fire uncommandable.
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const near = r.spawn(7, 5, 'enemy')
    const far = r.spawn(10, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 10, y: 5 })
    expect(victimOf(r.run(4))).toBe(near.id)
    r.world.despawn(near.id)
    expect(victimOf(r.run(40))).toBe(far.id)
  })

  it('a man off to one side is NOT hit just because he is nearer the shooter', () => {
    /**
     * The other half of "along the line". A man three tiles away but ninety
     * degrees off the direction of fire must be ignored, or commanded fire is
     * just auto-engage with extra steps.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    r.spawn(4, 2, 'enemy')
    const down = r.spawn(9, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 9, y: 5 })
    expect(victimOf(r.run(4))).toBe(down.id)
  })

  it('and a man BEHIND the shooter is never hit', () => {
    // A ray has a direction. Projecting onto an infinite LINE rather than onto
    // the forward ray would let a man standing behind the muzzle be "on it" —
    // the sign error that would make a soldier shoot over his own shoulder.
    const r = rig()
    const shooter = r.spawn(10, 5, 'player')
    r.spawn(6, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 14, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
  })
})

describe('the corridor is what gives a ray width', () => {
  it('a man just off the line is still hit', () => {
    /**
     * A mathematical ray hits nothing, so a man counts as being on the line when
     * his PERPENDICULAR distance from it is inside the corridor. This is the same
     * forgiveness the old two-tile tolerance gave, rotated: a disc around the aim
     * point becomes a corridor along the line of fire.
     *
     * Placed OFF a tile centre deliberately — a fixture sitting on a convenient
     * value has hidden five defects on this project, and a man exactly on the
     * line cannot tell a corridor test from no corridor test at all.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const centre = r.at(9, 5)
    const inside = r.spawnAt(centre.x, centre.z + AIM_CORRIDOR_TILES * 0.5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 12, y: 5 })
    expect(victimOf(r.run(4))).toBe(inside.id)
  })

  it('and a man beyond it is not', () => {
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const centre = r.at(9, 5)
    r.spawnAt(centre.x, centre.z + AIM_CORRIDOR_TILES * 2.5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 12, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
  })

  it('the corridor is a half-width, and a sane one', () => {
    // Wide enough to forgive a pointer that is off by a third of a man, narrow
    // enough that "vaguely forwards" is not a guaranteed hit.
    expect(AIM_CORRIDOR_TILES).toBeGreaterThan(0.25)
    expect(AIM_CORRIDOR_TILES).toBeLessThanOrEqual(1.5)
  })
})

describe('the bounds a round is still subject to', () => {
  it('cover stops it, even with the man inside range and on the line', () => {
    const r = rig(WALLED)
    const shooter = r.spawn(8, 5, 'player')
    r.spawn(15, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 18, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
  })

  it('and the same shot connects with the wall taken away', () => {
    // The control for the case above: without it, "hit nobody" passes for a
    // fixture where the shot was out of range or the corridor was misaligned,
    // and the wall would be proving nothing.
    const r = rig(OPEN)
    const shooter = r.spawn(8, 5, 'player')
    const enemy = r.spawn(15, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 18, y: 5 })
    expect(victimOf(r.run(4))).toBe(enemy.id)
  })

  it('a man beside the line, behind cover of his own, is not hit through it', () => {
    /**
     * THE ONLY CASE THAT DISTINGUISHES THE TWO COVER TESTS, and without it the
     * per-candidate `hasLineOfSight` inside the ray scan is dead: deleting it
     * passed all 342 tests, while its own comment called it load-bearing.
     *
     * A full-height wall blocks the CENTRE line too, so `clearFractionAlong`
     * shortens the round's reach and catches it without anybody's sightline
     * being consulted. Here the blocking tile is beside the line: the round's
     * reach is unclamped, the man is inside the corridor and inside the range,
     * and the only thing standing between him and the bullet is the sightline
     * from the muzzle to HIM.
     *
     * He is placed HALF A TILE off the centre line — inside the corridor, but
     * far enough that `worldToTileAxis` puts him in the next tile row, which is
     * what makes his sightline a different walk from the round's.
     */
    const r = rig(BESIDE)
    const shooter = r.spawn(4, 5, 'player')
    const line = r.at(9, 5)
    r.spawnAt(line.x, line.z + 0.6, 'enemy')
    r.combat.orderFire([shooter.id], { x: 14, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
  })

  it('and the identical shot connects with that one tile taken away', () => {
    // The control. Without it the case above passes for a man who was outside
    // the corridor, or out of range, and the cover would be proving nothing.
    const r = rig(OPEN)
    const shooter = r.spawn(4, 5, 'player')
    const line = r.at(9, 5)
    const enemy = r.spawnAt(line.x, line.z + 0.6, 'enemy')
    r.combat.orderFire([shooter.id], { x: 14, y: 5 })
    expect(victimOf(r.run(4))).toBe(enemy.id)
  })

  it('your own team is never on the line', () => {
    /**
     * FRIENDLY FIRE THROUGH THE RIFLE STAYS UNREACHABLE, exactly as before this
     * ticket — a round crossing one of your own men passes through him. Making
     * it hit the first ANYBODY is defensible and faithful to the original, and
     * `applyDamage` already attributes it correctly, but it is a change to how
     * the game PLAYS rather than to how it is AIMED. Out of scope, and asserted
     * here so it is a decision rather than an oversight.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const friend = r.spawn(7, 5, 'player')
    const enemy = r.spawn(10, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 12, y: 5 })
    const victim = victimOf(r.run(4))
    expect(victim).not.toBe(friend.id)
    expect(victim).toBe(enemy.id)
  })

  it('two men equally far along the line break the tie on the lower id', () => {
    // The tie-break the rest of the sim uses, and a fact about the world rather
    // than about the order the scan happened to reach them in.
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const centre = r.at(9, 5)
    const first = r.spawnAt(centre.x, centre.z + 0.25, 'enemy')
    const second = r.spawnAt(centre.x, centre.z - 0.25, 'enemy')
    expect(first.id).toBeLessThan(second.id)
    r.combat.orderFire([shooter.id], { x: 12, y: 5 })
    expect(victimOf(r.run(4))).toBe(first.id)
  })
})

describe('the degenerate aim', () => {
  it('an order onto the shooter`s own tile hits nobody and produces no NaN', () => {
    /**
     * A zero-length direction. There is no line, so there is no corridor to be
     * inside — and a `Math.hypot` of zero used as a divisor would produce `NaN`,
     * which every comparison fails and therefore quietly makes the corridor test
     * pass for nobody... or, spelled the other way round, for everybody. Both
     * are silent.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    r.spawn(6, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 4, y: 5 })
    const shots = r.run(4)
    expect(shots.length).toBeGreaterThan(0)
    expect(victimOf(shots)).toBeNull()
    for (const shot of shots) {
      if (shot.type !== 'ShotFired') continue
      expect(Number.isFinite(shot.targetX)).toBe(true)
      expect(Number.isFinite(shot.targetZ)).toBe(true)
    }
  })
})

describe('the tracer and the damage cannot disagree', () => {
  it('the reported endpoint is the man who was hit', () => {
    /**
     * The property this ticket exists to create. Before it, `ShotFired` was
     * drawn down the ray and the victim was chosen by nearness to the click, so
     * the two were answers to different questions that happened to agree most of
     * the time. Now there is one ray.
     */
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    const enemy = r.spawn(9, 5, 'enemy')
    r.combat.orderFire([shooter.id], { x: 13, y: 5 })
    const shots = r.run(4)
    const first = shots[0]
    expect(first?.type).toBe('ShotFired')
    if (first === undefined || first.type !== 'ShotFired') throw new Error('no shot')
    expect(first.targetId).toBe(enemy.id)
    expect(first.targetX).toBeCloseTo(enemy.x, 6)
    expect(first.targetZ).toBeCloseTo(enemy.z, 6)
  })

  it('and a shot that found nobody still reports a point on its own line', () => {
    // Ticket 011a's clamp, unchanged: the round goes as far as the weapon
    // carries down the line the player pointed. It must not report the click.
    const r = rig()
    const shooter = r.spawn(4, 5, 'player')
    r.combat.orderFire([shooter.id], { x: 19, y: 5 })
    const shots = r.run(4)
    const first = shots[0]
    if (first === undefined || first.type !== 'ShotFired') throw new Error('no shot')
    expect(first.targetId).toBeNull()
    const travelled = Math.hypot(first.targetX - first.originX, first.targetZ - first.originZ)
    expect(travelled).toBeLessThanOrEqual(rifle().rangeTiles + 1e-6)
    expect(travelled).toBeGreaterThan(rifle().rangeTiles - 1)
  })
})

describe('a unit engaging on its own initiative is untouched', () => {
  it('still takes the nearest visible enemy, with no aim point at all', () => {
    /**
     * Ticket 011's rule, and this ticket must not disturb it: an auto-engaging
     * unit has no aim point to draw a ray through. The nearest man wins even
     * when a further one would be more "in front" of anything.
     */
    const level = asciiLevel(OPEN)
    const world = new World(level, { seed: 1 })
    world.addSystem(createCombatSystem(bakeNavGrid(level)))
    const spawn = (tx: number, ty: number, team: 'player' | 'enemy') => {
      const p = tileToWorld(tx, ty, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health: 1000 })
    }
    spawn(4, 5, 'player')
    const near = spawn(6, 5, 'enemy')
    spawn(9, 2, 'enemy')
    world.tick()
    const shots = world.drainEvents().filter((e) => e.type === 'ShotFired')
    expect(shots.length).toBeGreaterThan(0)
    const byPlayer = shots.filter((s) => s.type === 'ShotFired' && s.shooterId === 1)
    const first = byPlayer[0]
    if (first === undefined || first.type !== 'ShotFired') throw new Error('no player shot')
    expect(first.targetId).toBe(near.id)
  })
})
