import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { World } from '../world'
import type { SimEvent } from '../events'
import { makeLevel } from './fixture'

/**
 * Ticket 005 — the determinism guarantee itself.
 *
 * This is the acceptance criterion the whole architecture rests on: "given the
 * same seed, level and command sequence, two `World` instances produce identical
 * state and identical event streams". Everything in `core/` is unit tested on
 * the strength of that promise.
 *
 * THE TRAP THIS SUITE AVOIDS. A `World` with no systems registered does nothing
 * when ticked, so "two empty worlds agree after 600 ticks" is true of any
 * implementation, including a broken one — it is a vacuous test that would pass
 * while `Math.random()` ran loose inside the tick. So these tests register a
 * real system that draws from the rng, mutates entities, spawns, despawns and
 * emits events. `addSystem` is the same seam tickets 006/007/011/012 plug into,
 * so this exercises the actual composition rather than a mock of it.
 */

type Team = 'player' | 'enemy'

/**
 * A stand-in for the systems that land in later tickets: it moves every entity
 * by an rng-jittered step, occasionally kills one, occasionally reinforces, and
 * emits events throughout. Deliberately noisy — determinism is only interesting
 * over a stream that has plenty of opportunity to diverge.
 */
function turbulence(world: World): void {
  for (const e of world.entities) {
    e.x += world.rng.range(-0.5, 0.5)
    e.z += world.rng.range(-0.5, 0.5)
    e.health -= world.rng.next() < 0.02 ? 1 : 0
  }
  // Deaths, resolved in a stable order so the event stream is a function of the
  // simulation rather than of iteration accidents.
  for (const e of [...world.entities]) {
    if (e.health <= 0) {
      world.emit({ type: 'UnitDied', id: e.id, team: e.team, killerId: null, friendlyFire: false })
      world.despawn(e.id)
    }
  }
  if (world.rng.next() < 0.05) {
    const team: Team = world.rng.next() < 0.5 ? 'player' : 'enemy'
    world.spawn({ kind: 'rifleman', team, x: world.rng.range(-8, 8), z: world.rng.range(-8, 8) })
  }
  if (world.rng.next() < 0.1) {
    const target = world.entities[world.rng.int(world.entities.length)]
    if (target) {
      world.emit({
        type: 'ShotFired',
        shooterId: target.id,
        targetId: null,
        weapon: 'rifle',
        originX: target.x,
        originZ: target.z,
        targetX: target.x + 1,
        targetZ: target.z,
        // Required since ticket 011b. This event is noise on the bus, not a shot
        // anything resolves, so the value is arbitrary and only has to be fixed.
        hit: true,
      })
    }
  }
}

function runMission(seed: number, ticks: number): { hash: number; events: SimEvent[] } {
  const world = new World(makeLevel(), { seed })
  world.spawnFromLevel()
  world.addSystem(turbulence)
  const events: SimEvent[] = []
  for (let i = 0; i < ticks; i++) {
    world.tick()
    events.push(...world.drainEvents())
  }
  return { hash: world.stateHash(), events }
}

describe('determinism', () => {
  it('two worlds with the same seed reach the same state after 600 ticks', () => {
    const a = runMission(1234, 600)
    const b = runMission(1234, 600)
    expect(a.hash).toBe(b.hash)
  })

  it('two worlds with the same seed emit identical event streams', () => {
    const a = runMission(1234, 600)
    const b = runMission(1234, 600)
    expect(a.events).toEqual(b.events)
  })

  it('actually produces a substantial event stream — the run is not trivially empty', () => {
    // Guards this whole suite against passing by doing nothing.
    const { events } = runMission(1234, 600)
    expect(events.length).toBeGreaterThan(20)
    expect(new Set(events.map((e) => e.type)).size).toBeGreaterThan(1)
  })

  it('different seeds diverge', () => {
    const a = runMission(1, 600)
    const b = runMission(2, 600)
    expect(a.hash).not.toBe(b.hash)
  })

  it('different seeds produce different event streams', () => {
    const a = runMission(1, 600)
    const b = runMission(2, 600)
    expect(a.events).not.toEqual(b.events)
  })

  it('agrees tick by tick, not merely at the end', () => {
    // An implementation that converged at tick 600 by accident would pass the
    // endpoint check. Compare the whole trajectory.
    const build = (seed: number) => {
      const w = new World(makeLevel(), { seed })
      w.spawnFromLevel()
      w.addSystem(turbulence)
      return w
    }
    const a = build(77)
    const b = build(77)
    for (let i = 0; i < 300; i++) {
      a.tick()
      b.tick()
      expect(a.stateHash()).toBe(b.stateHash())
      expect(a.drainEvents()).toEqual(b.drainEvents())
    }
  })

  it('is unaffected by how often events are drained', () => {
    // Presentation may skip a drain on a dropped frame. That must not feed back
    // into the simulation.
    const drainEvery = (n: number) => {
      const w = new World(makeLevel(), { seed: 55 })
      w.spawnFromLevel()
      w.addSystem(turbulence)
      for (let i = 0; i < 400; i++) {
        w.tick()
        if (i % n === 0) w.drainEvents()
      }
      return w.stateHash()
    }
    expect(drainEvery(1)).toBe(drainEvery(7))
  })

  it('is unaffected by reading stateHash mid-run', () => {
    // An observer must not perturb the system — e.g. by drawing from the rng.
    const w1 = new World(makeLevel(), { seed: 8 })
    w1.spawnFromLevel()
    w1.addSystem(turbulence)
    for (let i = 0; i < 200; i++) {
      w1.tick()
      w1.stateHash()
      w1.drainEvents()
    }
    const w2 = new World(makeLevel(), { seed: 8 })
    w2.spawnFromLevel()
    w2.addSystem(turbulence)
    for (let i = 0; i < 200; i++) {
      w2.tick()
      w2.drainEvents()
    }
    expect(w1.stateHash()).toBe(w2.stateHash())
  })

  it('gives the same result whether or not an unrelated world exists', () => {
    // Catches module-level shared state — a singleton rng, a global id counter.
    const solo = runMission(31, 200)
    const noise = new World(makeLevel(), { seed: 999 })
    noise.spawnFromLevel()
    noise.addSystem(turbulence)
    for (let i = 0; i < 500; i++) noise.tick()
    const withNoise = runMission(31, 200)
    expect(withNoise.hash).toBe(solo.hash)
    expect(withNoise.events).toEqual(solo.events)
  })
})

describe('no Math.random in core', () => {
  const CORE_DIR = join(process.cwd(), 'src', 'core')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue
        out.push(...sourceFiles(full))
      } else if (entry.endsWith('.ts')) {
        out.push(full)
      }
    }
    return out
  }

  /**
   * Comments are stripped before scanning. `render-state/scenery.ts` documents
   * *why* it hashes tile coordinates instead of calling `Math.random()`, and a
   * scan that failed on that sentence would be pressuring the code to stop
   * explaining itself — the opposite of what this rule is for.
   */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  }

  it('finds core source files to scan', () => {
    // If the scan silently found nothing, the assertions below would be vacuous.
    expect(sourceFiles(CORE_DIR).length).toBeGreaterThan(5)
  })

  it('strips comments before scanning, and still sees real code', () => {
    // Guards the stripper itself: too greedy and every assertion below passes
    // trivially on an empty string.
    const all = sourceFiles(CORE_DIR).map(code).join('\n')
    expect(all).toMatch(/export\s+function|export\s+const|export\s+class/)
  })

  it('contains no Math.random() call anywhere in src/core', () => {
    const offenders = sourceFiles(CORE_DIR).filter((f) => /Math\s*\.\s*random\s*\(/.test(code(f)))
    expect(offenders).toEqual([])
  })

  it('contains no Date.now() in src/core — wall-clock time breaks replay too', () => {
    const offenders = sourceFiles(CORE_DIR).filter((f) =>
      /Date\s*\.\s*now\s*\(|new\s+Date\s*\(/.test(code(f)),
    )
    expect(offenders).toEqual([])
  })
})

describe('tick hot path allocation', () => {
  it('does not grow the heap materially over a long steady-state run', () => {
    // A world at steady state — no spawns, no deaths, no events — must not
    // allocate per tick. The classic violations (a fresh array of entities per
    // tick, a new vector per entity per step) would put hundreds of thousands
    // of objects through the nursery over this run; the threshold is loose
    // enough to be immune to ordinary GC noise but nowhere near loose enough to
    // hide that.
    const w = new World(makeLevel(), { seed: 4 })
    for (let i = 0; i < 40; i++) {
      w.spawn({ kind: 'rifleman', team: i % 2 ? 'player' : 'enemy', x: i, z: i })
    }
    w.addSystem((world) => {
      for (const e of world.entities) {
        e.x += 0.001
        e.z -= 0.001
      }
    })
    w.drainEvents()

    for (let i = 0; i < 5000; i++) {
      w.tick()
      w.drainEvents()
    }
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < 40000; i++) {
      w.tick()
      w.drainEvents()
    }
    const grown = process.memoryUsage().heapUsed - before
    expect(grown).toBeLessThan(24 * 1024 * 1024)
  })

  it('returns the same empty-event array every steady tick', () => {
    const w = new World(makeLevel(), { seed: 4 })
    w.spawn({ kind: 'rifleman', team: 'player', x: 0, z: 0 })
    w.drainEvents()
    w.tick()
    const a = w.drainEvents()
    w.tick()
    const b = w.drainEvents()
    expect(a).toBe(b)
    expect(a).toHaveLength(0)
  })
})
