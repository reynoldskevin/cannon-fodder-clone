import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'

/**
 * Ticket 053 — a round in the air is drawn.
 *
 * ORDNANCE HAS FLOWN SINCE TICKET 015 AND NOBODY EVER LOOKED. Projectiles are
 * integrated once per tick, carry a world position whose `y` is height above the
 * ground plane, and are handed out by `inFlight()` — whose header says in as many
 * words that it exists FOR THE RENDERER, and which nothing has ever called. A
 * thrown grenade was invisible from the hand to the detonation, so the arc, the
 * fuse and the airburst were all happening and none of them was on screen.
 *
 * These cases go through `renderEntities`, which is the seam the renderer
 * actually reads. Asserting `inFlight()` alone would test ticket 015 again.
 */

const THROWER = () => makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [] })

/** Throw a grenade and report the session, the thrower and the target tile. */
function lob() {
  const s = createSession(THROWER())
  const id = s.selection()[0]
  if (id === undefined) throw new Error('no squad')
  const target = { x: 12, y: 7 }
  s.queue.push({ type: 'fire', unitIds: [id], ordnance: 'grenade', target })
  return { s, id, target }
}

/** Advance one frame and return the drawables. */
function frame(s: ReturnType<typeof createSession>) {
  s.advance(1 / 60)
  s.events()
  return s.renderEntities(FLAT)
}

/** Every drawable that is a round in the air. */
const rounds = (drawn: readonly { unit: string }[]) =>
  drawn.filter((d) => d.unit === 'grenade' || d.unit === 'rocket')

describe('a grenade is on screen between the hand and the bang', () => {
  it('is drawn at all, which it never was before', () => {
    const { s } = lob()
    let seen = false
    for (let f = 0; f < 240 && !seen; f += 1) seen = rounds(frame(s)).length > 0
    expect(seen).toBe(true)
  })

  it('as its own sprite, named by the ordnance it was launched as', () => {
    /**
     * THE UNIT NAME IS THE ORDNANCE NAME, so a rocket cannot be drawn as a
     * grenade and new ordnance needs no table here — it needs art with a matching
     * filename. `OrdnanceSpec.name` is `'grenade'` and `'rocket'`, and
     * `tools/spritegen` packs props under their own filenames.
     */
    const { s } = lob()
    for (let f = 0; f < 240; f += 1) {
      const round = rounds(frame(s))[0]
      if (round !== undefined) {
        expect(round.unit).toBe('grenade')
        return
      }
    }
    throw new Error('never saw the grenade')
  })

  it('and it is gone once it has gone off', () => {
    // The detonation is the end of it. A round still drawn after its `Explosion`
    // would be a grenade lying in mid-air over the crater it made.
    const { s } = lob()
    let exploded = false
    for (let f = 0; f < 400 && !exploded; f += 1) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'Explosion') exploded = true
      s.renderEntities(FLAT)
    }
    expect(exploded).toBe(true)
    for (let f = 0; f < 30; f += 1) frame(s)
    expect(rounds(s.renderEntities(FLAT))).toHaveLength(0)
  })
})

describe('and it is drawn where it actually is', () => {
  it('above the ground, and by a height that changes as it flies', () => {
    /**
     * THE ARC IS THE POINT. `RenderEntity.y` is where the sprite's feet sit, so a
     * projectile whose `y` was left at the terrain height would slide along the
     * floor to its target — which is both wrong and indistinguishable, on screen,
     * from the ordnance not arcing at all.
     *
     * `FLAT` puts the ground at 0 everywhere, so every height here is the
     * projectile's own.
     */
    const { s } = lob()
    const heights: number[] = []
    for (let f = 0; f < 400; f += 1) {
      const round = rounds(frame(s))[0] as { y: number } | undefined
      if (round !== undefined) heights.push(round.y)
    }
    expect(heights.length).toBeGreaterThan(5)
    expect(Math.max(...heights)).toBeGreaterThan(0)
    // It does not merely sit at one height: a constant would satisfy the check
    // above and would not be an arc.
    expect(new Set(heights).size).toBeGreaterThan(3)
  })

  it('and it travels, rather than hanging over the thrower', () => {
    const { s } = lob()
    const xs: number[] = []
    for (let f = 0; f < 400; f += 1) {
      const round = rounds(frame(s))[0] as { x: number } | undefined
      if (round !== undefined) xs.push(round.x)
    }
    expect(xs.length).toBeGreaterThan(5)
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs) + 1)
  })
})

describe('a round cannot be mistaken for anything else on the field', () => {
  it('its id collides with no soldier, no prop and no scenery', () => {
    /**
     * THE TRAP, AND IT IS A REAL ONE. `ordnance/system.ts` issues projectile ids
     * from its own counter starting at 1 — the SAME numbers `World` issues to
     * soldiers. The renderer keys facing memory and animation phase on id, so an
     * unoffset grenade with id 3 would share both with soldier 3: the man would
     * inherit the grenade's facing and the grenade the man's.
     *
     * `session/index.ts` already solves this twice, for props and for scenery,
     * with id bases far above anything the simulation issues. This is the third.
     */
    const { s } = lob()
    for (let f = 0; f < 400; f += 1) {
      const drawn = frame(s)
      const flying = rounds(drawn)
      if (flying.length === 0) continue
      const others = drawn.filter((d) => !rounds([d]).length).map((d) => d.id)
      for (const round of flying as { id: number }[]) {
        expect(others).not.toContain(round.id)
        // Above every id space in the game: sim ids from 1, scenery from
        // 1,000,000, props from 2,000,000.
        // 2,000,000 is `PROP_ID_BASE`, the highest base the session itself
        // issues from; scenery sits at 1,000,000. Spelled out rather than
        // imported because `src/render` is off-limits to `src/core`.
        expect(round.id).toBeGreaterThan(2_000_000)
      }
      return
    }
    throw new Error('never saw the grenade')
  })

  it('and every round in the air has a distinct one', () => {
    // Two grenades in the air at once must not be one drawable. The pouch and
    // the cooldown allow it; the ids come from a counter that only rises.
    const s = createSession(makeLevel({ avatars: [{ x: 4, y: 7 }], enemies: [] }))
    const id = s.selection()[0]
    if (id === undefined) throw new Error('no squad')
    let most = 0
    for (let f = 0; f < 400; f += 1) {
      if (f % 40 === 0) {
        s.queue.push({
          type: 'fire',
          unitIds: [id],
          ordnance: 'grenade',
          target: { x: 8 + (f % 3), y: 7 },
        })
      }
      const flying = rounds(frame(s)) as { id: number }[]
      most = Math.max(most, flying.length)
      expect(new Set(flying.map((r) => r.id)).size).toBe(flying.length)
    }
    expect(most).toBeGreaterThan(0)
  })
})

describe('and drawing it changes nothing about the mission', () => {
  it('a thrown grenade hashes the same whether or not it was drawn', () => {
    /**
     * `renderEntities` is a pure read and `inFlight()` is documented as a
     * SNAPSHOT. A drawable built by mutating the projectile list — or by
     * advancing anything to build it — would show up here and nowhere else.
     */
    const play = (draw: boolean): number => {
      const { s } = lob()
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
