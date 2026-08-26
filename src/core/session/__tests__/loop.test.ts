import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { FIXED_TIMESTEP, MAX_STEPS_PER_FRAME } from '../../world/gameloop'
import { WEAPONS, RIFLE } from '../../combat'

/** Read from the weapon table rather than pasted, so tuning it cannot rot this file. */
const RIFLE_RANGE_TILES = WEAPONS[RIFLE]!.rangeTiles

/**
 * Ticket 008a — driving the fixed-timestep loop from real frame deltas.
 *
 * Ticket 005 built the accumulator and tested it in isolation; nothing has ever
 * driven it. The interesting part is not the arithmetic — that is 005's — but
 * the ORDER of what happens around it: commands must be applied before the
 * systems that read them, and the frame's leftover alpha must be the one the
 * renderer is handed, or the interpolation smooths toward a state the sim has
 * not computed yet.
 */

describe('advance', () => {
  it('runs no step for a frame shorter than the timestep', () => {
    const s = createSession(makeLevel())
    const before = s.world.tickCount
    s.advance(FIXED_TIMESTEP / 4)
    expect(s.world.tickCount).toBe(before)
  })

  it('runs exactly one step for a frame of one timestep', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP)
    expect(s.world.tickCount).toBe(1)
  })

  it('runs the right number of steps for a long frame', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP * 4)
    expect(s.world.tickCount).toBe(4)
  })

  it('accumulates fractional frames into whole steps', () => {
    const s = createSession(makeLevel())
    for (let i = 0; i < 4; i++) s.advance(FIXED_TIMESTEP / 2)
    expect(s.world.tickCount).toBe(2)
  })

  it('clamps a very long frame rather than spiralling', () => {
    // The classic death: a backgrounded tab returns, the accumulator holds ten
    // seconds, the sim runs 600 steps, the frame takes longer than the last one,
    // and the accumulator grows again. The cap is the whole point.
    const s = createSession(makeLevel())
    s.advance(10)
    expect(s.world.tickCount).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME)
  })

  it('does not keep running the backlog on later frames', () => {
    const s = createSession(makeLevel())
    s.advance(10)
    const after = s.world.tickCount
    s.advance(FIXED_TIMESTEP)
    expect(s.world.tickCount).toBe(after + 1)
  })

  it('ignores a zero or negative frame', () => {
    const s = createSession(makeLevel())
    s.advance(0)
    s.advance(-1)
    expect(s.world.tickCount).toBe(0)
  })

  it('ignores a non-finite frame', () => {
    const s = createSession(makeLevel())
    expect(() => {
      s.advance(Number.NaN)
      s.advance(Number.POSITIVE_INFINITY)
    }).not.toThrow()
    expect(s.world.tickCount).toBe(0)
  })
})

describe('alpha', () => {
  it('is in [0, 1)', () => {
    const s = createSession(makeLevel())
    for (const dt of [0.001, 0.008, FIXED_TIMESTEP, 0.05, 0.3, 7]) {
      const alpha = s.advance(dt)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('reports the fraction of a step already accumulated', () => {
    const s = createSession(makeLevel())
    expect(s.advance(FIXED_TIMESTEP / 2)).toBeCloseTo(0.5, 6)
  })

  it('is near zero straight after a whole number of steps', () => {
    const s = createSession(makeLevel())
    expect(s.advance(FIXED_TIMESTEP * 3)).toBeCloseTo(0, 6)
  })

  it('is not always the hardcoded 1 that main.ts used to pass', () => {
    // The specific regression: `built.entities.update(elapsed, 1)` was honest
    // while no sim existed and becomes a lie the moment one does — it pins every
    // frame to the latest tick and throws the interpolation away.
    const s = createSession(makeLevel())
    const alphas = [0.004, 0.011, 0.02].map((dt) => s.advance(dt))
    expect(alphas.every((a) => a === 1)).toBe(false)
  })
})

describe('commands are applied before the systems that read them', () => {
  it('a command pushed between frames takes effect on the next step', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP)
    expect(s.squad.targetOf(id)).toEqual({ x: 17, y: 7 })
  })

  it('drains the queue, so a command is applied exactly once', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP)
    expect(s.queue.size).toBe(0)
    // A second order that is never pushed must not somehow re-apply the first.
    s.squad.order([id], { x: 2, y: 1 })
    s.advance(FIXED_TIMESTEP * 10)
    expect(s.squad.targetOf(id)).toEqual({ x: 2, y: 1 })
  })

  it('moves the squad over a whole second of frames', () => {
    // The end-to-end shape of the ticket: push a command, run frames, look.
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    const startX = s.world.get(id)!.x
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    for (let f = 0; f < 120; f++) s.advance(1 / 60)
    expect(s.world.get(id)!.x).toBeGreaterThan(startX + 3)
  })

  it('applies commands queued during a multi-step frame at the first step', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    const startX = s.world.get(id)!.x
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    s.advance(FIXED_TIMESTEP * 5)

    // FIVE steps of movement, not one. If the order were applied after the
    // steps ran, the unit would not have moved at all this frame; if it were
    // applied once per frame but the steps ran first, it would have moved less.
    // At the default 3 tiles/sec a step is 0.05 tiles, so five is about 0.25.
    const moved = s.world.get(id)!.x - startX
    expect(moved).toBeGreaterThan(0.15)
    expect(moved).toBeLessThan(0.4)
    expect(s.squad.targetOf(id)).toEqual({ x: 17, y: 7 })
    expect(s.queue.size).toBe(0)
  })

  it('drops a command naming a unit that died earlier in the same frame', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.world.despawn(id)
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    expect(() => {
      s.advance(FIXED_TIMESTEP)
    }).not.toThrow()
    expect(s.squad.detachmentCount).toBe(0)
  })
})

describe('system order', () => {
  it('declares ai, then squad, then combat, then objectives', () => {
    // The AI joined the front of the list in ticket 012: a pursue order it gives
    // this tick must move the man this tick, and its halt must land before the
    // movement it cancels. `session/__tests__/ai-wiring.test.ts` is where that
    // order is asserted through `advance` rather than read off a constant.
    expect(createSession(makeLevel()).systemOrder).toEqual(['ai', 'squad', 'combat', 'ordnance', 'pickups', 'objectives'])
  })

  it('actually runs squad movement before combat', () => {
    /**
     * THE ASSERTION THAT MEANS SOMETHING. The one above compares a constant
     * against a literal and would survive the systems being registered in the
     * opposite order — it documents an intention, it does not test one.
     *
     * The observable consequence: a man who SHOOTS WHILE WALKING shoots from
     * where this tick's step put him, because combat reads the position squad
     * just wrote. With the systems the other way round he would shoot from where
     * he stood at the end of the previous tick — one step behind, every time.
     *
     * He is given a fire order as well as a move order, and needs to be: since
     * ticket 011a the player squad holds fire until told, so an earlier version
     * of this test — which pushed only the move and waited for a shot — became
     * unsatisfiable the moment that landed. Advancing while firing is the case
     * worth testing anyway; it is the original's whole feel.
     */
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [{ x: 16, y: 7 }] })
    const s = createSession(level)
    const shooter = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [shooter], target: { x: 16, y: 7 } })
    s.queue.push({
      type: 'fire',
      unitIds: [shooter],
      ordnance: 'rifle',
      target: { x: 16, y: 7 },
    })

    // `ShotFired` carries `originX` BY VALUE, which is what makes this robust:
    // it survives the shooter dying to return fire on the same tick (these two
    // kill each other simultaneously — one hit point each), and it has no float
    // boundary to sit exactly on, unlike "is the distance <= range".
    let beforeX = s.world.get(shooter)!.x
    let origin = Number.NaN
    let afterX = Number.NaN
    for (let t = 0; t < 400 && Number.isNaN(origin); t++) {
      s.advance(FIXED_TIMESTEP)
      const shot = s.events().find((e) => e.type === 'ShotFired' && e.shooterId === shooter)
      if (shot && shot.type === 'ShotFired') {
        origin = shot.originX
        // May be undefined: these two kill each other on the same tick.
        afterX = s.world.get(shooter)?.x ?? Number.NaN
      } else {
        beforeX = s.world.get(shooter)?.x ?? beforeX
      }
    }

    expect(Number.isNaN(origin)).toBe(false) // he really did fire while walking
    expect(RIFLE_RANGE_TILES).toBeGreaterThan(0) // the fixture is a real weapon

    // He was still walking when he fired, so the two system orders give
    // DIFFERENT origins: squad-then-combat shoots from after this tick's step,
    // the other way round shoots from where he stood at the end of the previous
    // tick. One step at 3 tiles/sec is 0.05 — far bigger than any float slop.
    expect(origin).toBeGreaterThan(beforeX)
    expect(origin - beforeX).toBeCloseTo(0.05, 6)

    // And if he survived the exchange, the origin is exactly where he now is.
    if (!Number.isNaN(afterX)) expect(origin).toBe(afterX)
  })
})

describe('how many steps the frame ran', () => {
  /**
   * WHY THE CALLER NEEDS THIS, and it is not bookkeeping.
   *
   * `EntityRenderer.setEntities` keeps a previous/current pair and its own
   * docstring says "called once per SIM tick, not per frame". Above 60 Hz most
   * display frames run ZERO steps, so a caller that pushes render state every
   * frame makes `previous` and `current` the same list — and then `alpha`
   * interpolates a state with itself. The sprite freezes on a tick and jumps to
   * the next, which is precisely the judder the fixed timestep and the alpha
   * exist to remove. Passing a real alpha while destroying what it blends is
   * the worst kind of green: every acceptance criterion met, nothing fixed.
   *
   * So the session has to say whether a step ran, and the render loop has to
   * only push new state when one did.
   */
  it('reports zero for a frame too short to step', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP / 4)
    expect(s.stepsLastAdvance).toBe(0)
  })

  it('reports one for a frame of exactly one step', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP)
    expect(s.stepsLastAdvance).toBe(1)
  })

  it('reports the count for a multi-step frame', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP * 3)
    expect(s.stepsLastAdvance).toBe(3)
  })

  it('reports the clamped count for a very long frame', () => {
    const s = createSession(makeLevel())
    s.advance(10)
    expect(s.stepsLastAdvance).toBe(MAX_STEPS_PER_FRAME)
  })

  it('agrees with how far the world actually ticked', () => {
    const s = createSession(makeLevel())
    let expected = 0
    for (const dt of [0.004, 0.02, 0.004, 0.05, 0.3, 0.001, 1 / 60]) {
      s.advance(dt)
      expected += s.stepsLastAdvance
      expect(s.world.tickCount).toBe(expected)
    }
  })

  it('goes back to zero on a frame that steps nothing after one that did', () => {
    // The stale-count trap: leaving the previous frame's count in place makes a
    // zero-step frame look like a stepping one, which is the same bug again.
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP * 2)
    expect(s.stepsLastAdvance).toBe(2)
    s.advance(FIXED_TIMESTEP / 8)
    expect(s.stepsLastAdvance).toBe(0)
  })

  it('is zero after a frame that is ignored outright', () => {
    const s = createSession(makeLevel())
    s.advance(FIXED_TIMESTEP)
    s.advance(Number.NaN)
    expect(s.stepsLastAdvance).toBe(0)
  })
})

describe('who shoots without being told', () => {
  /**
   * The owner's call: the player squad holds fire until right-clicked, and the
   * enemy shoots back.
   *
   * WHAT MAKES THE ENEMY SHOOT CHANGED IN TICKET 012 AND THIS TEST DID NOT, which
   * is the point of having written it through `advance` in the first place. It
   * used to be `CombatSystem`'s auto-engage; it is now the AI's state machine
   * issuing a standing fire order, and the session passes `autoEngageTeams: []`
   * so that exactly one of the two decides. The behaviour the player sees is the
   * same, so the assertion is the same.
   *
   * Asserted through `advance` rather than by inspecting the combat system's
   * options, because the thing that can break is the WIRING — a session that
   * builds the policy correctly and then registers a differently-configured
   * system would pass any test that read the option back.
   */
  const facingOff = () =>
    makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })

  it('the player squad does not fire on its own', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    const fired: number[] = []
    for (let f = 0; f < 200; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'ShotFired') fired.push(e.shooterId)
    }
    expect(fired).not.toContain(player)
  })

  it('the enemy does', () => {
    const s = createSession(facingOff())
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    const fired: number[] = []
    for (let f = 0; f < 200; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'ShotFired') fired.push(e.shooterId)
    }
    expect(fired).toContain(enemy)
  })

  it('the player squad fires when a fire command is queued', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    s.queue.push({ type: 'fire', unitIds: [player], ordnance: 'rifle', target: { x: 10, y: 7 } })
    const fired: number[] = []
    for (let f = 0; f < 60; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'ShotFired') fired.push(e.shooterId)
    }
    expect(fired).toContain(player)
  })

  it('and stops when the cease-fire arrives', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    // A target that survives the exchange, so the test is about the order
    // rather than about who died first.
    const tough = s.world.entities.find((e) => e.team === 'enemy')!
    tough.health = 100_000
    s.queue.push({ type: 'fire', unitIds: [player], ordnance: 'rifle', target: { x: 10, y: 7 } })
    for (let f = 0; f < 120; f++) {
      s.advance(1 / 60)
      s.events()
    }
    s.queue.push({ type: 'ceaseFire', unitIds: [player] })
    s.advance(1 / 60)
    s.events()

    const after: number[] = []
    for (let f = 0; f < 200; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'ShotFired') after.push(e.shooterId)
    }
    expect(after).not.toContain(player)
  })

  it('keeps firing while advancing — a move order is not a cease-fire', () => {
    const s = createSession(facingOff())
    const player = s.selection()[0]!
    const tough = s.world.entities.find((e) => e.team === 'enemy')!
    tough.health = 100_000
    s.queue.push({ type: 'fire', unitIds: [player], ordnance: 'rifle', target: { x: 10, y: 7 } })
    s.queue.push({ type: 'move', unitIds: [player], target: { x: 8, y: 3 } })
    const fired: number[] = []
    for (let f = 0; f < 200; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'ShotFired') fired.push(e.shooterId)
    }
    expect(fired).toContain(player)
  })
})

describe('events', () => {
  it('hands back what the tick emitted, then empties', () => {
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })
    const s = createSession(level)
    let sawShot = false
    // Ninety frames rather than thirty: this loop only exists to reach the first
    // shot, and the enemy now holds fire for a 45-tick beat after engaging
    // (ticket 012a). Nothing about what is asserted has moved — the events of
    // the frame that fired are still handed back once and then drained.
    for (let f = 0; f < 90 && !sawShot; f++) {
      s.advance(1 / 60)
      sawShot = s.events().some((e) => e.type === 'ShotFired')
    }
    expect(sawShot).toBe(true)
    // Drained: asking again in the same frame yields nothing.
    expect(s.events()).toEqual([])
  })

  it('does not lose the events of a multi-step frame', () => {
    // The hazard: draining inside the step loop and overwriting the buffer each
    // time, so a frame that ran eight steps reports only the eighth step's
    // events. Compared against the same eight steps run one frame at a time,
    // which cannot lose anything.
    const level = () => makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })

    const oneBig = createSession(level())
    oneBig.advance(FIXED_TIMESTEP * 8)
    const fromOneFrame = oneBig.events()

    const eightSmall = createSession(level())
    const fromEightFrames = []
    for (let i = 0; i < 8; i++) {
      eightSmall.advance(FIXED_TIMESTEP)
      fromEightFrames.push(...eightSmall.events())
    }

    expect(fromOneFrame.length).toBeGreaterThan(0) // non-vacuous
    expect(fromOneFrame.map((e) => e.type)).toEqual(fromEightFrames.map((e) => e.type))
  })
})
