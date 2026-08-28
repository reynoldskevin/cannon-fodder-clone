import { describe, it, expect } from 'vitest'
import { rig, OPEN } from './rig'
import { DEFAULT_ENEMY_FACING } from '../tuning'

/**
 * Ticket 038 — where an enemy is looking, as simulation state.
 *
 * Before this, facing existed ONLY in the renderer: `render-state/facing.ts`
 * derives one of eight compass directions from an entity's movement vector for
 * drawing, with hysteresis so a stationary man keeps looking where he looked.
 * `core/ai` had no access to it and `Entity` carries no such field.
 *
 * It lives in the AI's `Memory` rather than on `Entity`, and that is deliberate:
 * `Entity`'s fields are readonly because nothing in the design changes them, and
 * `World.stateHash` folds it — a per-tick-mutating direction there would put
 * every unit's heading into the world hash for no gain. `Memory` is already
 * where per-unit AI state that outlives a tick lives.
 */

/** The angle between a facing and a direction, in degrees. */
const angleTo = (
  facing: { dx: number; dz: number },
  dx: number,
  dz: number,
): number => {
  const length = Math.hypot(dx, dz) * Math.hypot(facing.dx, facing.dz)
  const dot = (facing.dx * dx + facing.dz * dz) / length
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
}

/**
 * A deliberately NON-SQUARE arena, 24 wide by 12 tall, so its centre is tile
 * (11.5, 5.5).
 *
 * Non-square on purpose: a square grid cannot tell "toward the centre" apart
 * from an implementation that used one axis's midpoint for both, which is the
 * obvious slip and would put every enemy on a rectangular map — which is every
 * shipped map — looking somewhere nobody chose.
 */
const WIDE = '\n' + Array.from({ length: 12 }, () => '  ' + '.'.repeat(24)).join('\n') + '\n'

/** Where the level's middle is, in the same tile coordinates the fixtures use. */
const MIDDLE = { x: (24 - 1) / 2, y: (12 - 1) / 2 }

/** The default facing a man spawned at this tile settles on. */
const defaultFacingAt = (tileX: number, tileY: number): { dx: number; dz: number } => {
  const r = rig(WIDE)
  const enemy = r.spawn(tileX, tileY, 'enemy')
  r.run(1)
  const facing = r.ai.facingOf(enemy.id)
  if (facing === undefined) throw new Error('no facing')
  return facing
}

describe('a man who has never moved or seen anything faces the middle of the level', () => {
  it('from the north edge he looks south', () => {
    expect(angleTo(defaultFacingAt(11, 0), 0, 1)).toBeLessThan(20)
  })

  it('from the south edge he looks north', () => {
    /**
     * THE WHOLE TICKET IN ONE PAIR. A fixed compass default cannot satisfy both
     * of these, and ticket 038's fixed south failed exactly here: five of level
     * 2's fifteen enemies stand south of the squad and spent the mission staring
     * off the bottom of the map.
     */
    expect(angleTo(defaultFacingAt(11, 11), 0, -1)).toBeLessThan(20)
  })

  it('from the west edge he looks east, and from the east edge west', () => {
    // The other axis, which a first draft that only handled north-south would
    // fail — and every shipped map is wider than it is tall.
    expect(angleTo(defaultFacingAt(0, 5), 1, 0)).toBeLessThan(20)
    expect(angleTo(defaultFacingAt(23, 5), -1, 0)).toBeLessThan(20)
  })

  it('and the direction really is at the middle, not merely inward', () => {
    // A corner. "Inward" is satisfied by any of a quarter-turn of directions
    // here; only one of them points at the centre.
    const facing = defaultFacingAt(0, 0)
    expect(angleTo(facing, MIDDLE.x - 0, MIDDLE.y - 0)).toBeLessThan(5)
  })

  it('and it is computed from BOTH dimensions, not one midpoint used twice', () => {
    /**
     * The slip this guards. On a 24 x 12 grid the two midpoints are 11.5 and
     * 5.5; using the x midpoint for both would put a man at (11, 11) looking at
     * (11.5, 11.5) — very nearly due EAST instead of due north — and every case
     * above except the west/east pair would still pass.
     */
    const facing = defaultFacingAt(11, 11)
    expect(facing.dz).toBeLessThan(-0.9)
  })

  it('and it is a unit vector', () => {
    for (const [x, y] of [[0, 0], [23, 11], [11, 0], [3, 8]]) {
      const f = defaultFacingAt(x!, y!)
      expect({ x, y, len: Math.hypot(f.dx, f.dz) }).toEqual({ x, y, len: expect.closeTo(1, 6) })
    }
  })

  it('and a man standing ON the middle gets a finite fallback rather than NaN', () => {
    /**
     * The offset is a zero vector there. A NaN facing loses every comparison it
     * enters, so that man would be blind in every direction — a far quieter and
     * worse failure than looking the wrong way.
     */
    const f = defaultFacingAt(12, 6) // the nearest whole tile to (11.5, 5.5)
    expect(Number.isFinite(f.dx) && Number.isFinite(f.dz)).toBe(true)
    expect(Math.hypot(f.dx, f.dz)).toBeCloseTo(1, 6)
  })

  it('and it is settled ONCE, not re-aimed every time he stops', () => {
    /**
     * It is a spawn POSTURE, not a behaviour. A man who walked north and halted
     * must keep looking north; recomputing on every idle tick would spin every
     * enemy in the game back toward the middle the moment he stopped walking,
     * which is neither what a soldier does nor what ticket 038's "an idle man
     * keeps the facing he had" says.
     */
    const r = rig(WIDE)
    const enemy = r.spawn(11, 10, 'enemy')
    r.ai.face(enemy.id, 0, 1) // pointed SOUTH, away from the middle
    r.run(60)
    expect(angleTo(r.ai.facingOf(enemy.id)!, 0, 1)).toBeLessThan(1)
  })

  it('and faces an AUTHORED direction when the level gave him one', () => {
    /**
     * `SpawnPoint.facing` has parsed since ticket 018 (`level/index.ts`) and the
     * session already turns it into a vector — but only to orient a SPRITE.
     * Checked against the shipped levels: eighteen enemies across level 1 and
     * level 2 and not one carries a `facing`, so this ticket cannot read an
     * authored direction off the map and has to supply a default.
     *
     * The hook still has to work, because it is the entire reason a fixed
     * default is acceptable: a level that wants a guard looking the other way
     * can say so today, with no code change.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.ai.face(enemy.id, 1, 0) // east
    r.run(4)
    expect(angleTo(r.ai.facingOf(enemy.id)!, 1, 0)).toBeLessThan(1)
  })

  it('and an authored facing is normalised, not taken at whatever length it came in', () => {
    // The cone test is a dot product; a facing of length 5 would scale it and
    // silently make that one guard blind or all-seeing.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.ai.face(enemy.id, 0, 7)
    r.run(2)
    const f = r.ai.facingOf(enemy.id)!
    expect(Math.hypot(f.dx, f.dz)).toBeCloseTo(1, 6)
  })

  it('and a degenerate authored facing is refused rather than stored', () => {
    // A zero vector has no direction to normalise and would produce NaN, which
    // loses every comparison — the man would be blind in all directions.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.ai.face(enemy.id, 0, 0)
    r.run(2)
    const f = r.ai.facingOf(enemy.id)!
    expect(Number.isFinite(f.dx) && Number.isFinite(f.dz)).toBe(true)
    expect(Math.hypot(f.dx, f.dz)).toBeCloseTo(1, 6)
  })
})

describe('what he looks at once something is happening', () => {
  it('an engaging man faces his target', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(12, 7, 'player', 10_000) // south-east, inside the arc
    r.run(30)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    const unit = r.world.get(enemy.id)!
    const mark = r.world.get(player.id)!
    expect(angleTo(r.ai.facingOf(enemy.id)!, mark.x - unit.x, mark.z - unit.z)).toBeLessThan(15)
  })

  it('a pursuing man faces where he is walking', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(10, 1, 'enemy')
    r.spawn(10, 8, 'player', 10_000) // due south, seven tiles
    r.run(20)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
    expect(angleTo(r.ai.facingOf(enemy.id)!, 0, 1)).toBeLessThan(20)
  })

  it('and an idle man keeps the facing he had rather than snapping back', () => {
    /**
     * A man who has stopped looking at something does not whip round to a
     * compass default. This is also what makes the mechanic legible: a guard the
     * squad lured east stays looking east, so the blind side stays where the
     * player last saw it go.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    const player = r.spawn(13, 7, 'player', 10_000)
    r.run(30)
    const facing = r.ai.facingOf(enemy.id)!
    expect(angleTo(facing, DEFAULT_ENEMY_FACING.dx, DEFAULT_ENEMY_FACING.dz)).toBeGreaterThan(5)
    r.world.despawn(player.id)
    r.run(400) // long enough for the pursue timeout to retire him to idle
    expect(r.ai.stateOf(enemy.id)).toBe('idle')
    const after = r.ai.facingOf(enemy.id)!
    expect(angleTo(after, facing.dx, facing.dz)).toBeLessThan(45)
  })

  it('and it is always a unit vector, whatever produced it', () => {
    // Every consumer — the cone, the renderer — assumes this.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 2, 'enemy')
    r.spawn(11, 6, 'player', 10_000)
    for (let i = 0; i < 8; i += 1) {
      r.run(20)
      const f = r.ai.facingOf(enemy.id)!
      expect(Math.hypot(f.dx, f.dz)).toBeCloseTo(1, 6)
    }
  })
})

describe('facing is deterministic, like everything else the machine decides', () => {
  it('two identical runs produce identical facings', () => {
    // It is state that outlives a tick, so it is exactly the sort of thing that
    // can pick up an iteration order or an rng draw by accident.
    const play = (): { dx: number; dz: number } => {
      const r = rig(OPEN)
      const enemy = r.spawn(10, 2, 'enemy')
      r.spawn(12, 6, 'player', 10_000)
      r.spawn(9, 7, 'player', 10_000)
      r.run(120)
      return r.ai.facingOf(enemy.id)!
    }
    expect(play()).toEqual(play())
  })

  it('and the world hash never learns about it', () => {
    /**
     * `Entity` gains no facing field and `World.stateHash` is unchanged — the
     * same bargain `combat`'s cooldown table makes. Two worlds whose units stand
     * in the same places hash the same however differently their enemies are
     * looking, because the hash is about the WORLD and facing is the AI's
     * private bookkeeping.
     */
    /**
     * NO PLAYER IN EITHER ARENA, which ticket 046 forced and which the case is
     * better for.
     *
     * There used to be one three tiles south of each enemy. He was incidental —
     * the two facings differ because B is turned east by hand, not because of
     * anything the player does — but at a four-tile awareness radius he stopped
     * being inert: B noticed him THROUGH the arc, turned to face him, and the two
     * facings converged, so the case failed on its own premise rather than on the
     * hash. Two empty arenas assert the same thing with nothing in them that can
     * move, which is what a hash comparison wants anyway.
     */
    const a = rig(OPEN)
    const enemyA = a.spawn(10, 5, 'enemy')
    const b = rig(OPEN)
    const enemyB = b.spawn(10, 5, 'enemy')
    b.ai.face(enemyB.id, 1, 0)
    a.run(1)
    b.run(1)
    expect(a.ai.facingOf(enemyA.id)).not.toEqual(b.ai.facingOf(enemyB.id))
    expect(a.world.stateHash()).toBe(b.world.stateHash())
  })
})

describe('a man walking his beat looks where he is going', () => {
  /**
   * THE HOLE ADVERSARIAL REVIEW FOUND, and it is the ticket's own decisive
   * criterion inverted.
   *
   * A patrol runs inside the machine's IDLE branch — `patrolStep` is on the
   * `next === IDLE` tail — so a facing rule written as "engage, pursue or alert"
   * skips it entirely. Measured on the first draft: a guard routed due north
   * walked five and a half tiles with a player standing in plain sight three to
   * eight tiles directly ahead, never acquired him, and would have noticed only
   * at the awareness exception, which was two tiles then and is four now.
   *
   * And because the renderer now takes an enemy's sprite direction from the
   * simulation, he was DRAWN facing south the whole way — walking backwards up
   * the map. That is worse than the pre-038 behaviour it replaced, where
   * movement drove the sprite and at least looked right.
   *
   * The rule is therefore about MOVEMENT, not about a list of states: if he took
   * a step this tick, he is looking along it.
   */
  it('faces along his route rather than keeping his spawn facing', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(10, 8, 'enemy')
    r.ai.assignPatrol(enemy.id, [
      { x: 10, y: 1 },
      { x: 10, y: 8 },
    ])
    r.run(60)
    const before = r.world.get(enemy.id)!.z
    r.run(20)
    // He really is walking north, or this asserts nothing.
    expect(r.world.get(enemy.id)!.z).toBeLessThan(before)
    expect(r.ai.facingOf(enemy.id)!.dz).toBeLessThan(0)
  })

  /**
   * REMOVED IN TICKET 086: "and therefore notices a man standing on his beat
   * ahead of him".
   *
   * It asserted that a patrolling guard, having turned to face his route, then
   * ACQUIRED a man standing on it — at a gap deliberately set beyond
   * `DEFAULT_AWARENESS_RADIUS_TILES + 2` so that only the forward arc could
   * explain the sighting. Sight is all round now: he notices that man whichever
   * way he is pointed, so the case would still pass while proving nothing about
   * facing, which is what this file is for. What it really guarded — that a
   * routed man turns along his route rather than keeping his spawn pose — is the
   * case directly above, and that still means something.
   */

  it('but a man standing still on his post keeps the facing he had', () => {
    // The guard on the fix: "face where you moved" must not become "face
    // nowhere when you stop", which would leave a standing sentry drawn pointing
    // nowhere.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.ai.face(enemy.id, 1, 0)
    r.run(90)
    expect(angleTo(r.ai.facingOf(enemy.id)!, 1, 0)).toBeLessThan(1)
  })
})

describe('the small guarantees the code claims out loud', () => {
  it('`face` works on a man the machine already knows, not only before his first tick', () => {
    /**
     * HALF THE PUBLIC API WAS UNEXERCISED. Every caller in the codebase — the
     * session's spawn seeding, this rig — calls `face` BEFORE the first tick,
     * when no `Memory` exists yet and the value lands in the pending map. Making
     * `face` a no-op for a unit that already has a memory survived the whole
     * suite, which review demonstrated by doing exactly that.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.run(30)
    r.ai.face(enemy.id, -1, 0)
    r.run(2)
    expect(angleTo(r.ai.facingOf(enemy.id)!, -1, 0)).toBeLessThan(1)
  })

  it('`facingOf` hands back a copy, not a live reference into the machine', () => {
    // The comment on `facingOf` promises this; nothing checked it. A shared
    // mutable object makes two reads compare equal forever, so any test that
    // sampled a facing before and after would silently stop being able to see a
    // change — including several in this file.
    const r = rig(OPEN)
    const enemy = r.spawn(10, 2, 'enemy')
    r.spawn(10, 8, 'player', 10_000)
    // One tick first: a unit has no `Memory` — and therefore no facing — until
    // the machine has stepped it once, which is why `facingOf` is optional.
    r.run(1)
    const before = r.ai.facingOf(enemy.id)!
    r.run(60)
    const after = r.ai.facingOf(enemy.id)!
    expect(before).not.toBe(after)
    // And the first read was not retroactively rewritten by the second.
    expect(Math.hypot(before.dx, before.dz)).toBeCloseTo(1, 6)
  })

  it('the movement baseline is refreshed in every state, including `engage`', () => {
    /**
     * `turn` refreshes the track on EVERY tick rather than only in the states
     * that read it, and says so — but review moved the refresh inside the branch
     * and all 2099 tests stayed green.
     *
     * The failure it guards: a man who stands still through a firefight has a
     * baseline frozen where he entered `engage`. The first tick he drops back to
     * `pursue`, his "travel since last tick" is measured from there instead of
     * from where he actually is, so he snaps to a heading he never walked. Here
     * he engages a man to the south, then has to pursue one to the WEST — a
     * stale baseline points him somewhere neither man is.
     */
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    const south = r.spawn(10, 8, 'player', 10_000)
    r.run(60)
    expect(r.ai.stateOf(enemy.id)).toBe('engage')
    r.world.despawn(south.id)
    r.spawn(2, 5, 'player', 10_000) // due west, well outside the closing distance
    r.ai.face(enemy.id, -1, 0) // he turns to the noise; the arc lets him see it
    r.run(40)
    expect(r.ai.stateOf(enemy.id)).toBe('pursue')
    // He is walking west, so that is where he must be looking.
    expect(r.ai.facingOf(enemy.id)!.dx).toBeLessThan(0)
  })
})
