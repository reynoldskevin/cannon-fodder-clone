import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { createFxBuffer } from '../../render-state/fx'
import { shakeFor } from '../../view/shake'

/**
 * Ticket 025 — feeding the FX layer cannot change a mission.
 *
 * THIS IS WHY THE WHOLE LAYER COULD BE ADDED IN MILESTONE 4 AT ALL. The claim
 * "FX subscribe to events only" is what lets a purely visual system land after
 * the sim is finished and after every balance decision has been made; if it were
 * false, every FX tuning change would be a balance change and this ticket would
 * have needed to run before 011, 012 and 015 rather than after them.
 *
 * WHAT THIS ACTUALLY PINS, STATED HONESTLY. It runs the same mission twice and
 * pumps every event into live FX buffers on one of the runs, so it catches a
 * side channel OUT of the FX modules — a buffer that reached into a global, a
 * `visible` that was not the pure query it is documented to be, a `shakeFor`
 * that mutated something on the way past.
 *
 * IT DOES NOT CATCH A BAD WIRING IN `main.ts`, and it would be worth very little
 * if that were claimed for it: both runs call `s.events()` identically, so a
 * frame loop that drained the bus for the FX layer and starved the objectives
 * system — the failure ticket 012's own comment warns about, since `drainEvents`
 * empties the bus — is invisible from here. That risk lives in `src/app`, which
 * has no test harness on this project at all.
 *
 * The module boundary itself is guaranteed elsewhere and better: `eslint.config.js`
 * forbids `core/render-state` and `core/view` from importing `core/combat`,
 * `core/ordnance` or `core/world`, and that is a compile-time fact rather than a
 * sampled one.
 *
 * THAT RULE EXISTS BECAUSE THIS COMMENT ASSERTED IT BEFORE IT WAS TRUE. An
 * earlier draft claimed the lint already covered it; adversarial review checked
 * by adding `import { ORDNANCE }` to `core/render-state/fx.ts` and got a clean
 * lint and a green suite — the config only ever restricted the SIBLING layers
 * (render/app/ui/input/audio) and `three`. Nothing in the tree violated the
 * boundary, and nothing enforced it either, which is the combination this
 * project has learned to treat as a defect in its own right. The rule was added
 * rather than the sentence softened.
 */

const script = () =>
  makeLevel({
    avatars: [
      { x: 6, y: 9 },
      { x: 7, y: 9 },
    ],
    enemies: [
      { x: 12, y: 9 },
      { x: 13, y: 6 },
    ],
  })

const FRAMES = 400

/** Run a mission, optionally pumping every event into a live FX buffer. */
function play(seed: number, withFx: boolean): { hash: number; deaths: number; booms: number } {
  const s = createSession(script(), { seed })
  const effects = createFxBuffer()
  const scars = createFxBuffer({ capacity: 128 })
  let deaths = 0
  let booms = 0
  let clock = 0
  /**
   * A GRENADE IS THROWN ON PURPOSE. Without it the `Explosion` branch below is
   * dead code and this suite would report that it covers the burst, the decal
   * and the shake while never once producing any of them — the vacuous-fixture
   * trap this project has hit repeatedly. `booms` is asserted, not assumed.
   */
  const thrower = s.world.entities.find((e) => e.team === 'player')
  for (let frame = 0; frame < FRAMES; frame += 1) {
    if (frame === 30 && thrower !== undefined) {
      s.queue.push({ type: 'fire', unitIds: [thrower.id], ordnance: 'grenade', target: { x: 12, y: 9 } })
    }
    s.advance(1 / 60)
    clock += 1 / 60
    for (const event of s.events()) {
      if (event.type === 'UnitDied') deaths += 1
      if (event.type === 'Explosion') booms += 1
      if (!withFx) continue
      // Exactly what `main.ts` does with a drained batch.
      if (event.type === 'ShotFired') {
        effects.add({ kind: 'muzzle', x: event.originX, z: event.originZ, scale: 1 }, clock)
      } else if (event.type === 'Explosion') {
        effects.add({ kind: 'burst', x: event.x, z: event.z, scale: event.radiusTiles }, clock)
        scars.add({ kind: 'decal', x: event.x, z: event.z, scale: event.radiusTiles }, clock)
        // The shake request too, since that is the one FX number computed from
        // event data rather than merely stored.
        void shakeFor(Math.hypot(event.x, event.z), event.radiusTiles)
      } else if (event.type === 'UnitDied') {
        effects.add({ kind: 'death', x: 0, z: 0, scale: 1 }, clock)
      }
    }
    // Read them back every frame, as a renderer would. `visible` is documented
    // as a pure query; if it were not, this is where the difference would enter.
    if (withFx) {
      effects.visible(clock)
      scars.visible(clock)
    }
  }
  return { hash: s.world.stateHash(), deaths, booms }
}

describe('a mission runs identically whether or not anybody is drawing it', () => {
  it('the same seed produces the same world, fed and unfed', () => {
    for (const seed of [1, 2, 3, 7]) {
      const quiet = play(seed, false)
      const drawn = play(seed, true)
      expect({ seed, hash: drawn.hash }).toEqual({ seed, hash: quiet.hash })
    }
  })

  it('and the fixture actually produces a firefight, or this proves nothing', () => {
    /**
     * THE CONTROL. Two missions in which nothing ever happens hash the same
     * however the FX layer is wired, so the comparison above is only worth
     * anything if the script fires rounds and kills men.
     */
    const run = play(1, true)
    expect(run.deaths).toBeGreaterThan(0)
    // And the grenade really detonated, so the burst/decal/shake path above was
    // exercised rather than skipped.
    expect(run.booms).toBeGreaterThan(0)
  })

  it('and different seeds still diverge, so the hash is watching something', () => {
    // Guards the other way: a `stateHash` that returned a constant would make
    // every assertion above pass forever.
    const a = play(1, true).hash
    const b = play(9, true).hash
    expect(a).not.toBe(b)
  })
})
