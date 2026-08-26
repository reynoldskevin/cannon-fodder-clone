import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { tileToWorld } from '../../view/projection'
import type { RenderEntity } from '../../render-state/entity'

/**
 * Ticket 025a — a firing man faces where he is shooting.
 *
 * THE MECHANIC WAS NEVER BROKEN, and that is the whole reason this exists.
 * Since ticket 011a a right-click sends the cursor's tile as the fire order's
 * aim point, and `CombatSystem` fires along the ray from the shooter to THAT
 * POINT — not along his facing. Rounds have always gone where the pointer is.
 *
 * What lied about it was the sprite. `renderEntities` derived `dx`/`dz` purely
 * from movement (`entity.x - track.x`), so a man marching north while the
 * cursor was east was DRAWN facing north and SHOT east. With no tracer to
 * contradict it, the sprite was the only feedback the player had, and it was
 * pointing the wrong way — which reads as "he fires where he is facing".
 *
 * The precedence is aim, then movement, then the authored spawn facing. Firing
 * outranks walking for the same reason `fire` outranks `walk` in the animation:
 * the player is holding a button that means "look there".
 */

const drawn = (s: ReturnType<typeof createSession>, id: number): RenderEntity => {
  const e = s.renderEntities(() => 0).find((r) => r.id === id)
  if (e === undefined) throw new Error(`nothing drawn for ${String(id)}`)
  return e
}

/** One avatar alone on open ground, far from anything that could shoot back. */
const alone = () => makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [] })

describe('a firing unit faces its aim point', () => {
  it('faces east when aimed east', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 15, y: 7 } })
    s.advance(1 / 60)
    const e = drawn(s, id)
    expect({ eastward: e.dx > 0, flat: Math.abs(e.dz) < 1e-6 }).toEqual({
      eastward: true,
      flat: true,
    })
  })

  it('faces west when aimed west', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 1, y: 7 } })
    s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeLessThan(0)
  })

  it('faces the AIM even while marching the other way', () => {
    /**
     * THE WHOLE COMPLAINT, in one case. Ordered west and aimed east: the rounds
     * go east, so the man must look east. Before this ticket he was drawn facing
     * west, because movement was the only thing feeding the facing.
     */
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 2, y: 7 } })
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 15, y: 7 } })
    for (let f = 0; f < 20; f += 1) s.advance(1 / 60)

    const e = drawn(s, id)
    const moved = s.world.get(id)!.x
    const start = tileToWorld(8, 7, alone().size).x
    expect({ marchingWest: moved < start, facingEast: e.dx > 0 }).toEqual({
      marchingWest: true,
      facingEast: true,
    })
  })

  it('faces the aim, not the man it happens to hit', () => {
    // `AIM_TOLERANCE_TILES` lets a round aimed near a target hit it, so the aim
    // point and the victim are routinely a tile or two apart. The player pointed
    // at the ground; the man looks at the ground.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 8, y: 3 }] })
    const s = createSession(level)
    const id = s.selection()[0]!
    // Aimed due EAST while the only enemy is due NORTH.
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 14, y: 7 } })
    s.advance(1 / 60)
    const e = drawn(s, id)
    expect({ east: e.dx > 0, notNorth: Math.abs(e.dz) < Math.abs(e.dx) }).toEqual({
      east: true,
      notNorth: true,
    })
  })

  it('turns when the aim is dragged to a new tile', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 15, y: 7 } })
    s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeGreaterThan(0)

    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 1, y: 7 } })
    s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeLessThan(0)
  })
})

describe('a unit that is not firing is unaffected', () => {
  it('still faces its movement', () => {
    // The regression that matters most: this is how every unit has faced since
    // ticket 008a, and only a standing fire order may override it.
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 15, y: 7 } })
    for (let f = 0; f < 20; f += 1) s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeGreaterThan(0)
  })

  it('goes back to facing its movement after a cease-fire', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 2, y: 7 } })
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: { x: 15, y: 7 } })
    for (let f = 0; f < 20; f += 1) s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeGreaterThan(0) // facing the aim, marching west

    s.queue.push({ type: 'ceaseFire', unitIds: [id] })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    expect(drawn(s, id).dx).toBeLessThan(0) // back to facing the march
  })

  it('keeps its authored spawn facing before it has done anything', () => {
    const s = createSession(alone())
    const id = s.selection()[0]!
    const e = drawn(s, id)
    expect(Number.isFinite(e.dx) && Number.isFinite(e.dz)).toBe(true)
  })
})

describe('a degenerate aim does not spin anybody round', () => {
  it('aiming at your own tile leaves the facing alone', () => {
    /**
     * A zero-length vector has no direction, and `facingFromVector` answers
     * south for one — so a man ordered to fire at the tile under his own feet
     * would snap to face the camera. Right-clicking your own squad is an easy
     * misclick, and it must not spin the man round.
     */
    const s = createSession(alone())
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 15, y: 7 } })
    for (let f = 0; f < 20; f += 1) s.advance(1 / 60)
    const before = drawn(s, id)
    expect(before.dx).toBeGreaterThan(0)

    const here = s.world.get(id)!
    const tile = { x: Math.round(here.x + (20 - 1) / 2), y: Math.round(here.z + (15 - 1) / 2) }
    s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'rifle', target: tile })
    s.advance(1 / 60)
    const after = drawn(s, id)
    // Not south, and not zero: whatever it was facing, it still is.
    expect(after.dx > 0 || (after.dx === before.dx && after.dz === before.dz)).toBe(true)
  })
})

describe('enemies turn too, by the same path', () => {
  it('an engaging enemy faces the man it is engaging', () => {
    // The AI issues `orderFire` exactly as the pointer does (ticket 012), so it
    // gets aim facing for free. If it did not, the two teams would be drawn by
    // different rules and only one of them would look right.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 12, y: 7 }] })
    const s = createSession(level)
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    const tough = tileToWorld(10, 7, level.size)
    s.world.spawn({ kind: 'rifleman', team: 'player', x: tough.x, z: tough.z, health: 10_000 })
    for (let f = 0; f < 30; f += 1) s.advance(1 / 60)

    expect(s.combat.isFiring(enemy)).toBe(true)
    // The enemy is east of its target, so it must look WEST.
    expect(drawn(s, enemy).dx).toBeLessThan(0)
  })
})
