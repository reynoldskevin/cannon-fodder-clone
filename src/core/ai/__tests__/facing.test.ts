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

describe('a man who has never moved or seen anything', () => {
  it('faces the default', () => {
    const r = rig(OPEN)
    const enemy = r.spawn(10, 5, 'enemy')
    r.run(4)
    const facing = r.ai.facingOf(enemy.id)
    expect(facing).toBeDefined()
    expect(angleTo(facing!, DEFAULT_ENEMY_FACING.dx, DEFAULT_ENEMY_FACING.dz)).toBeLessThan(1)
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
    const player = r.spawn(10, 8, 'player', 10_000) // due south, seven tiles
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
    const a = rig(OPEN)
    const enemyA = a.spawn(10, 5, 'enemy')
    a.spawn(10, 8, 'player', 10_000)
    const b = rig(OPEN)
    const enemyB = b.spawn(10, 5, 'enemy')
    b.spawn(10, 8, 'player', 10_000)
    b.ai.face(enemyB.id, 1, 0)
    a.run(1)
    b.run(1)
    expect(a.ai.facingOf(enemyA.id)).not.toEqual(b.ai.facingOf(enemyB.id))
    expect(a.world.stateHash()).toBe(b.world.stateHash())
  })
})
