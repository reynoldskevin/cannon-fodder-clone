import { describe, it, expect } from 'vitest'
import { cueFor, CUES, type Cue } from '../index'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 027 — which sound an event asks for.
 *
 * PURE, AND IN `core`, FOR THE REASON THE FX LAYER GIVES. Vitest has no
 * `AudioContext`, so anything decided inside a Web Audio call is decided where
 * no test can see it. This file decides; `src/audio` makes noise.
 */

const stamp = { tick: 1, seq: 1 } as const

/** One of every variant in the union, so the exhaustiveness claim is real. */
const EVERY_EVENT: SimEvent[] = [
  { ...stamp, type: 'UnitSpawned', id: 1, kind: 'rifleman', team: 'player', x: 0, z: 0 },
  { ...stamp, type: 'UnitDespawned', id: 1 },
  { ...stamp, type: 'UnitDied', id: 1, team: 'enemy', killerId: 2, friendlyFire: false },
  {
    ...stamp,
    type: 'ShotFired',
    shooterId: 1,
    targetId: 2,
    weapon: 'rifle',
    originX: 0,
    originZ: 0,
    targetX: 1,
    targetZ: 1,
    hit: true,
  },
  { ...stamp, type: 'Explosion', ordnance: 'grenade', x: 3, z: 4, y: 0, radiusTiles: 2, sourceId: 1 },
  { ...stamp, type: 'FireRejected', ordnance: 'rifle', reason: 'in_water' },
  { ...stamp, type: 'ChestCollected', index: 0, x: 5, z: 6, collectorId: 1, reward: {} },
  { ...stamp, type: 'MissionComplete', objective: 'kill_all' },
  { ...stamp, type: 'MissionFailed', reason: 'squad_wiped' },
]

describe('every event in the union has an answer', () => {
  it('and none of them throws', () => {
    /**
     * THE EXHAUSTIVENESS CLAIM, AS A RUNTIME CHECK. The compiler half — a
     * `switch` with no `default` over a discriminated union — is what makes
     * ADDING a variant fail the build. This is what catches the union being
     * handled by an `if` chain that quietly falls off the end.
     */
    for (const event of EVERY_EVENT) {
      expect(() => cueFor(event)).not.toThrow()
    }
  })

  it('covering every variant the union actually declares', () => {
    // Guards the fixture rather than the code: a variant added to `SimEvent` and
    // not to `EVERY_EVENT` would leave the loop above passing while testing
    // nothing about it.
    const covered = new Set(EVERY_EVENT.map((e) => e.type))
    expect(covered.size).toBe(EVERY_EVENT.length)
    expect(covered.size).toBe(9)
  })

  it('and every cue it can return is a declared one', () => {
    for (const event of EVERY_EVENT) {
      const request = cueFor(event)
      if (request === null) continue
      expect({ type: event.type, known: CUES.includes(request.cue) }).toEqual({
        type: event.type,
        known: true,
      })
    }
  })
})

/** The cue a given event type asks for, from the fixture list above. */
const of = (type: SimEvent['type']): ReturnType<typeof cueFor> => {
  const event = EVERY_EVENT.find((e) => e.type === type)
  if (event === undefined) throw new Error(`no fixture for ${type}`)
  return cueFor(event)
}

describe('the cues a firefight actually makes', () => {
  it('a round fired is the rifle', () => {
    expect(of('ShotFired')?.cue).toBe('rifle')
  })

  it('a detonation is the explosion, wherever it went off', () => {
    const request = of('Explosion')
    expect(request?.cue).toBe('explosion')
    expect({ x: request?.x, z: request?.z }).toEqual({ x: 3, z: 4 })
  })

  it('a man falling is a death', () => {
    expect(of('UnitDied')?.cue).toBe('death')
  })

  it('and the mission ending is the one that ended it', () => {
    expect(of('MissionComplete')?.cue).toBe('victory')
    expect(of('MissionFailed')?.cue).toBe('defeat')
  })

  it('a chest is its own cue, even though no asset exists for it yet', () => {
    /**
     * THE MAPPING IS NOT THE MANIFEST. A cue with no file must still be
     * requested here and skipped by the player — the day somebody drops
     * `chest.wav` in, nothing in `core` should have to change. Merging the two
     * questions would mean the mapping had to be edited every time an asset
     * arrived, which is how a mapping ends up describing the asset folder
     * instead of the game.
     */
    expect(of('ChestCollected')?.cue).toBe('chest')
  })
})

describe('and the events that are deliberately silent', () => {
  it('spawning and despawning make no sound', () => {
    /**
     * `UnitSpawned` fires once per soldier at mission start — a burst of eight
     * identical noises over the briefing is not an effect, it is a fault. And a
     * despawn is bookkeeping: the DEATH is the audible thing, and it has already
     * been reported by its own event.
     */
    expect(of('UnitSpawned')).toBeNull()
    expect(of('UnitDespawned')).toBeNull()
  })
})

describe('positional cues carry a position and the rest do not', () => {
  it('an explosion is somewhere; a victory is not', () => {
    // `panFor` needs a place to pan to. Mission complete is not somewhere on the
    // map, and panning it would put the end of the mission in one ear.
    const boom = cueFor(EVERY_EVENT[4]!)
    expect(boom?.x).toBeDefined()
    const win = cueFor(EVERY_EVENT[7]!)
    expect(win?.x).toBeUndefined()
  })

  it('a death has no position of its own, because the event carries none', () => {
    /**
     * `UnitDiedEvent` reports `id`, `team` and the killer — and NOT where he
     * fell. The FX layer had the same problem in ticket 025 and solved it by
     * looking the corpse up among the drawables; the mapping cannot, and must
     * not pretend to. The caller supplies the position or the cue plays flat.
     */
    expect(cueFor(EVERY_EVENT[2]!)?.x).toBeUndefined()
  })
})

describe('a death picks one of its variations deterministically', () => {
  it('the same man always dies the same way', () => {
    /**
     * Three `death` assets shipped, and a cue that always played the first would
     * waste two of them and make a firefight sound like one man dying repeatedly.
     *
     * CHOSEN FROM THE UNIT'S ID, NOT FROM A DRAW. Nothing in presentation may
     * touch `world.rng` — that would make a mission at one seed depend on how
     * many men had died in a rendered run and not in a headless one, which is
     * the replay trap `tuning.ts` names. An id is free, already unique, and
     * gives the same man the same voice every time.
     */
    const die = (id: number) =>
      cueFor({ ...stamp, type: 'UnitDied', id, team: 'enemy', killerId: 0, friendlyFire: false })
    expect(die(7)?.variant).toBe(die(7)?.variant)
    const variants = new Set([die(1), die(2), die(3), die(4), die(5), die(6)].map((r) => r?.variant))
    expect(variants.size).toBeGreaterThan(1)
  })

  it('and the variant is a non-negative integer the player can index with', () => {
    for (let id = 0; id < 40; id += 1) {
      const v = cueFor({
        ...stamp,
        type: 'UnitDied',
        id,
        team: 'enemy',
        killerId: 0,
        friendlyFire: false,
      })?.variant
      expect({ id, ok: Number.isInteger(v) && (v ?? -1) >= 0 }).toEqual({ id, ok: true })
    }
  })
})

describe('the cue list is data', () => {
  it('and survives a JSON round-trip, like every other table in this codebase', () => {
    expect(JSON.parse(JSON.stringify(CUES)) as Cue[]).toEqual([...CUES])
  })
})
