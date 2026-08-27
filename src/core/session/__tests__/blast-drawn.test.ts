import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSession, BLAST_ANIMATION, BLAST_FPS, BLAST_FRAMES } from '../index'
import { makeLevel, FLAT } from './fixture'

/**
 * Ticket 064 — a detonation you can see.
 *
 * SINCE TICKET 054 AN EXPLOSION HAS HAD NO PICTURE AT ALL. Three things used to
 * hang off the `Explosion` event and every one of them was a coloured
 * rectangle: the scorch decal went in 047, the death puff in 051, the orange
 * blast quad in 054. What was left was a camera shake and a sound — a
 * detonation you hear and feel and cannot see.
 *
 * THESE CASES GO THROUGH `renderEntities`, which is the seam the renderer
 * actually reads, and the same one ticket 053 put the in-flight round through.
 * Asserting on an internal blast list would test a private array.
 *
 * WHY THE BLAST IS A DRAWABLE AND NOT AN FX SPAWN. `fx-renderer.ts` draws
 * untextured additive quads and knows nothing about the atlas; the entity
 * renderer already draws atlas sprites, plays one-shot clips off
 * `animationStart` and corrects for the camera's elevation. Teaching all of
 * that to the FX layer would be a second entity renderer.
 */

const THROWER = () => makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [] })

/** Throw a grenade east and return the session. */
function lob(target = { x: 12, y: 7 }) {
  const s = createSession(THROWER())
  const id = s.selection()[0]
  if (id === undefined) throw new Error('no squad')
  s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target })
  return s
}

/** Advance one frame and return the drawables. */
function frame(s: ReturnType<typeof createSession>) {
  s.advance(1 / 60)
  s.events()
  return s.renderEntities(FLAT)
}

const blasts = <T extends { animation: string }>(drawn: readonly T[]): T[] =>
  drawn.filter((d) => d.animation === BLAST_ANIMATION)

/** Run until the grenade goes off, reporting the frame it happened on. */
function detonate(s: ReturnType<typeof createSession>): { at: number; x: number; z: number } {
  for (let f = 0; f < 400; f += 1) {
    s.advance(1 / 60)
    for (const event of s.events()) {
      if (event.type === 'Explosion') {
        s.renderEntities(FLAT)
        return { at: f, x: event.x, z: event.z }
      }
    }
    s.renderEntities(FLAT)
  }
  throw new Error('nothing ever went off')
}

describe('a detonation is drawn', () => {
  it('at all, which since ticket 054 it was not', () => {
    const s = lob()
    let seen = false
    for (let f = 0; f < 400 && !seen; f += 1) seen = blasts(frame(s)).length > 0
    expect(seen).toBe(true)
  })

  it('as the explosion sprite, on its own clip', () => {
    const s = lob()
    for (let f = 0; f < 400; f += 1) {
      const blast = blasts(frame(s))[0]
      if (blast !== undefined) {
        expect(blast.unit).toBe('explosion')
        expect(blast.animation).toBe(BLAST_ANIMATION)
        return
      }
    }
    throw new Error('never saw the blast')
  })

  it('and it appears on the frame the round goes off, not before', () => {
    /**
     * NOTHING IS DRAWN UNTIL SOMETHING DETONATES. A blast list seeded with an
     * entry, or one that drew the pending round's target, would put a fireball
     * on the ground for the whole flight.
     */
    const s = lob()
    const before: number[] = []
    for (let f = 0; f < 400; f += 1) {
      s.advance(1 / 60)
      const events = [...s.events()]
      const drawn = s.renderEntities(FLAT)
      if (events.some((e) => e.type === 'Explosion')) {
        expect(blasts(drawn).length).toBeGreaterThan(0)
        expect(before).toEqual([])
        return
      }
      if (blasts(drawn).length > 0) before.push(f)
    }
    throw new Error('nothing ever went off')
  })
})

describe('and it is drawn where the round landed', () => {
  it('at the explosion`s own x and z', () => {
    /**
     * THE EVENT CARRIES THE POINT OF IMPACT and the blast has to use it. Drawing
     * at the THROWER, or at the tile centre the order named, would be a fireball
     * next to the crater rather than in it — and on a fixture that throws in a
     * straight line, "next to" can be metres.
     */
    const s = lob()
    const bang = detonate(s)
    const blast = blasts(s.renderEntities(FLAT))[0]
    expect(blast).toBeDefined()
    expect(blast?.x).toBeCloseTo(bang.x, 6)
    expect(blast?.z).toBeCloseTo(bang.z, 6)
  })

  it('and on the ground, whatever height the round went off at', () => {
    /**
     * `ExplosionEvent.y` IS THE HEIGHT THE ROUND WAS AT, and it is deliberately
     * NOT used. A grenade that detonates on its fuse rather than on impact goes
     * off in the air, and a fireball hanging above the ground reads as a bug;
     * the blast belongs where the damage is. `FLAT` puts the terrain at 0.
     */
    const s = lob()
    detonate(s)
    expect(blasts(s.renderEntities(FLAT))[0]?.y).toBe(0)
  })

  it('and it does not turn, however the round was travelling', () => {
    // The rocket's art has a nose and is rotated to point along its flight
    // (ticket 055). A fireball has no heading, and a blast that inherited the
    // round's would spin the explosion by the angle the shot came in at.
    const s = lob()
    detonate(s)
    const blast = blasts(s.renderEntities(FLAT))[0]
    expect({ dx: blast?.dx, dz: blast?.dz }).toEqual({ dx: 0, dz: 0 })
  })
})

describe('and it plays once and stops', () => {
  it('is drawn for exactly as long as its three frames take to play', () => {
    /**
     * THE CLIP IS `BLAST_FRAMES / BLAST_FPS` SECONDS — 0.25s, which at the fixed
     * 60Hz step is 15 ticks — and the blast has to be drawn on every one of
     * them. One tick short and the last drawing of the explosion, the big one,
     * is never seen; one tick long and a burnt-out fireball is held on screen.
     *
     * COUNTED RATHER THAN WALKED, because the detonation frame is the FIRST tick
     * of the fifteen and `detonate` has already consumed it — a loop that then
     * asked for fifteen MORE would be asking for sixteen and would fail on a
     * correct implementation. Counting every frame the blast appears on is exact
     * in both directions and does not have to know where the walk started.
     */
    const s = lob()
    detonate(s)
    let drawn = 1 // the detonation frame itself, already drawn by `detonate`
    for (let f = 0; f < 120; f += 1) drawn += blasts(frame(s)).length
    expect(drawn).toBe(Math.round(BLAST_FRAMES / BLAST_FPS / (1 / 60)))
  })

  it('and is gone once they have played', () => {
    /**
     * A ONE-SHOT CLIP HOLDS ITS LAST FRAME FOREVER. `entity-renderer.ts` does
     * not remove anything — a blast left in the list would sit on the field as a
     * permanent fireball, exactly as the corpses ticket 049 deliberately left
     * behind do, which is right for a body and wrong for a bang.
     */
    const s = lob()
    detonate(s)
    for (let f = 0; f < 240; f += 1) frame(s)
    expect(blasts(s.renderEntities(FLAT))).toHaveLength(0)
  })

  it('and its animation starts when it went off, not at zero', () => {
    /**
     * `animationStart` IS WHAT MAKES THE CLIP PLAY FROM ITS FIRST FRAME. Left at
     * 0, the renderer computes the phase from the mission clock instead, and a
     * blast at 40 seconds opens on whatever frame the cycle happens to be on —
     * usually the last one, so the explosion plays its ending.
     */
    const s = lob()
    detonate(s)
    const blast = blasts(s.renderEntities(FLAT))[0]
    expect(blast?.animationStart).toBeGreaterThan(0)
  })
})

describe('and two bangs are two blasts', () => {
  it('never one', () => {
    /**
     * TWO THROWERS, NOT ONE THROWING TWICE, AND MUTATION TESTING IS WHY.
     *
     * The first version of this case had one man lobbing a grenade every 30
     * frames and asserted that the live blasts had distinct ids. A blast lives
     * 15 ticks, so no two were EVER alive at the same moment — the set it
     * checked never held more than one element, and hardcoding `seq: 1` for
     * every blast in the session passed the whole suite. The assertion was
     * true and vacuous.
     *
     * Two men on adjacent tiles throwing the same distance land together:
     * measured, both blasts are on screen for frames 39-53. `expect(most)` is
     * the non-vacuity check, and it is what makes the id comparison mean
     * something.
     */
    const s = createSession(
      makeLevel({ avatars: [{ x: 4, y: 7 }, { x: 4, y: 9 }], enemies: [] }),
    )
    const ids = s.selection()
    const [first, second] = ids
    if (first === undefined || second === undefined) throw new Error('need two throwers')
    s.queue.push({ type: 'fire', unitIds: [first], ordnance: 'grenade', target: { x: 12, y: 7 } })
    s.queue.push({ type: 'fire', unitIds: [second], ordnance: 'grenade', target: { x: 12, y: 9 } })

    let most = 0
    for (let f = 0; f < 300; f += 1) {
      const live = blasts(frame(s))
      most = Math.max(most, live.length)
      // Two craters, two ids. A blast keyed on the tick, or on anything the two
      // share, would collapse them into one drawable.
      expect(new Set(live.map((b) => b.id)).size).toBe(live.length)
    }
    // The whole point: there really were two at once.
    expect(most).toBe(2)
  })

  it('and a blast`s id collides with nothing else on the field', () => {
    /**
     * THE SAME TRAP TICKET 053 DOCUMENTED FOR THE ROUND, one id space along. The
     * renderer keys facing memory and animation phase on id, so a blast sharing
     * a number with a soldier would hand the man the fireball's animation phase.
     *
     * Sim ids start at 1, scenery at 1,000,000, props at 2,000,000 and rounds in
     * flight at 3,000,000. Spelled out rather than imported because `src/render`
     * is off-limits to `src/core`.
     */
    const s = lob()
    detonate(s)
    const drawn = s.renderEntities(FLAT)
    const live = blasts(drawn)
    expect(live.length).toBeGreaterThan(0)
    const others = drawn.filter((d) => d.animation !== BLAST_ANIMATION).map((d) => d.id)
    for (const blast of live) {
      expect(others).not.toContain(blast.id)
      expect(blast.id).toBeGreaterThan(3_000_000)
    }
  })
})

describe('and drawing it changes nothing about the mission', () => {
  it('a bombardment hashes the same whether or not anybody drew it', () => {
    /**
     * `renderEntities` IS A PURE READ. The blast list is written from the event
     * drain, which happens either way; a list built or pruned inside
     * `renderEntities` would show up here and nowhere else.
     */
    const play = (draw: boolean): number => {
      const s = lob()
      for (let f = 0; f < 400; f += 1) {
        s.advance(1 / 60)
        s.events()
        if (draw) s.renderEntities(FLAT)
      }
      return s.world.stateHash()
    }
    expect(play(true)).toBe(play(false))
  })
})

describe('the timing agrees with the art it is timing', () => {
  it('the shipped manifest and the session tell the same story', () => {
    /**
     * A CONTRACT TEST ACROSS A REAL WIRE, and the reason it exists rather than
     * two suites that each assume the other.
     *
     * `tools/spritegen` writes the clip's fps into `sprites.manifest.json`;
     * `core/session` decides how many TICKS to keep a blast alive. Neither can
     * see the other, and both are internally consistent whatever number they
     * hold: if spritegen says 12fps and the session budgets for 24, the blast is
     * cut off halfway through its second frame; the other way round and it
     * freezes on the fireball for a quarter of a second. Nothing raises either
     * way — you have to be looking at it.
     *
     * READ FROM THE GENERATED FILE THE GAME ACTUALLY LOADS, not from a rebuild
     * and not from the source constants: this is about what shipped.
     */
    const manifestPath = resolve(__dirname, '../../../../public/generated/sprites/sprites.manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      effects?: Record<string, { fps: number; frames: unknown[] }>
    }
    const explosion = manifest.effects?.['explosion']
    expect(explosion).toBeDefined()
    expect(explosion?.fps).toBe(BLAST_FPS)
    expect(explosion?.frames).toHaveLength(BLAST_FRAMES)
  })
})
