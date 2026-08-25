import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { worldToTile } from '../../view/projection'

/**
 * Ticket 012 — the AI, wired into a real session.
 *
 * ASSERTED THROUGH `advance`, not by reading options back off the session. The
 * thing that can break here is the WIRING: a session that builds the AI
 * correctly and then forgets to register it, or registers it after combat, or
 * leaves `autoEngageTeams: ['enemy']` in place so that the enemy shoots for a
 * reason nobody chose, would satisfy any test that inspected its configuration.
 * Every case below watches what actually happens to units over ticks.
 *
 * THE DOUBLE-SOURCE TRAP has its own case, because it is the specific mistake
 * this ticket is most likely to leave behind. Auto-engage and the state machine
 * both make an enemy shoot; leave both switched on and every firing assertion
 * in `src/core/ai` still passes while the machine's `engage`/`pursue`
 * bookkeeping quietly means nothing.
 */

/** Player and enemy in plain sight of one another, three tiles apart. */
const facingOff = () => makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 11, y: 7 }] })

/** Player and enemy on the same row, eleven tiles apart: seen, out of range. */
const acrossTheField = () => makeLevel({ avatars: [{ x: 3, y: 7 }], enemies: [{ x: 14, y: 7 }] })

function fired(s: ReturnType<typeof createSession>, frames: number): number[] {
  const ids: number[] = []
  for (let f = 0; f < frames; f += 1) {
    s.advance(1 / 60)
    for (const e of s.events()) if (e.type === 'ShotFired') ids.push(e.shooterId)
  }
  return ids
}

describe('the AI runs inside the session', () => {
  it('is registered, before squad and combat', () => {
    // Order is a decision, not an accident: the AI's pursue order must move the
    // man on the tick it is given, and its halt must land before the movement it
    // cancels. Combat stays last, so a unit shoots from where it now stands.
    const s = createSession(facingOff())
    expect(s.systemOrder).toEqual(['ai', 'squad', 'combat'])
  })

  it('the enemy still shoots back', () => {
    const s = createSession(facingOff())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    expect(fired(s, 200)).toContain(enemy)
  })

  it('the player squad still holds its fire', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    expect(fired(s, 200)).not.toContain(player)
  })
})

describe('the enemy shoots because the machine said so', () => {
  /**
   * FINDING A DISCRIMINATOR TOOK SOME LOOKING, and it is worth writing down why.
   *
   * Auto-engage and the state machine produce the SAME ROUNDS: both fire at the
   * nearest visible target inside the weapon's range, on cooldown. No count of
   * shots, no damage assertion and no positional test can tell them apart, so a
   * suite built only on those would go green with both mechanisms live and the
   * `engage`/`pursue` bookkeeping meaning nothing.
   *
   * Two things do separate them, and both are used below:
   *
   *   1. `isFiring` reports STANDING ORDERS ONLY. Auto-engage sets none — it
   *      decides afresh each tick — so an auto-engaging unit reads `false` while
   *      shooting. The AI shoots by issuing `orderFire`, exactly as the player's
   *      pointer does, so an engaged enemy reads `true`.
   *   2. `CombatSystem` never moves anybody. An enemy that closes the distance
   *      is being driven by something else, and the AI is the only candidate.
   */
  it('an engaged enemy holds a standing fire order', () => {
    const s = createSession(facingOff())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    for (let f = 0; f < 30; f += 1) s.advance(1 / 60)
    expect(s.combat.isFiring(enemy)).toBe(true)
  })

  it('an enemy with no target holds none', () => {
    // The other half, so the assertion above is not just "isFiring returns true".
    const s = createSession(acrossTheField())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    s.advance(1 / 60)
    expect(s.combat.isFiring(enemy)).toBe(false)
  })

  it('an enemy that cannot see is an enemy that does not fire', () => {
    const blocked = new Set<string>()
    for (let y = 0; y < 15; y += 1) blocked.add(`10,${y}`)
    const level = makeLevel({
      avatars: [{ x: 8, y: 7 }],
      enemies: [{ x: 12, y: 7 }],
      blocked,
    })
    const s = createSession(level)
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    expect(fired(s, 200)).not.toContain(enemy)
  })

  it('an enemy that can see but cannot reach walks toward the player', () => {
    // THE MOVEMENT IS THE PROOF. Auto-engage cannot produce it — `CombatSystem`
    // never moves anybody. An enemy that closes the distance is an enemy being
    // driven by the state machine, and nothing else in the session can do it.
    const s = createSession(acrossTheField())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!
    const startX = enemy.x
    for (let f = 0; f < 60; f += 1) s.advance(1 / 60)
    expect(s.world.get(enemy.id)!.x).toBeLessThan(startX - 1)
  })

  it('and having closed, opens fire', () => {
    const s = createSession(acrossTheField())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    expect(fired(s, 400)).toContain(enemy)
  })
})

describe('the player squad is still the player`s', () => {
  it('a move order is carried out with enemies on the map', () => {
    // The AI shares one `SquadSystem` with the pointer. If it ever ordered a
    // player unit, the squad would be pulled off the march the owner gave it.
    const level = acrossTheField()
    const s = createSession(level)
    const player = s.selection()[0]!
    const start = worldToTile(s.world.get(player)!.x, s.world.get(player)!.z, level.size)
    s.queue.push({ type: 'move', unitIds: [player], target: { x: 3, y: 13 } })
    for (let f = 0; f < 120; f += 1) s.advance(1 / 60)
    const now = worldToTile(s.world.get(player)!.x, s.world.get(player)!.z, level.size)
    // Asserted in TILE space, and via `worldToTile` rather than by assuming which
    // way z runs — the half-tile convention in `core/view/projection` has cost
    // this project two review cycles already.
    expect({ from: start.y, movedSouth: now.y > start.y + 1 }).toEqual({ from: 7, movedSouth: true })
  })

  it('a fire order is still obeyed', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [player], ordnance: 'rifle', target: { x: 11, y: 7 } })
    expect(fired(s, 120)).toContain(player)
  })
})
