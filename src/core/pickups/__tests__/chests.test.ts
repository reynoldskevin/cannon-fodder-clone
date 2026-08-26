import { describe, it, expect } from 'vitest'
import { World } from '../../world/world'
import { asciiLevel } from '../../pathing/__tests__/ascii'
import { tileToWorld } from '../../view/projection'
import { createArmoury } from '../../armoury'
import { createPickupSystem, DEFAULT_COLLECT_RADIUS_TILES } from '../index'
import type { LevelData, SpawnPoint } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 017 — loot chests.
 *
 * THIS TICKET IS THE MIDDLE OF SOMETHING ALREADY BUILT AT BOTH ENDS. Ticket 013
 * left `ObjectiveSystem.collectChest()` with a docstring saying chests are 017's
 * problem and nothing collects one yet; ticket 016 left `Armoury.grant` written
 * precisely so this would be a caller rather than a redesign. Neither changes
 * here, and a test that had to modify either would be evidence the seam was
 * wrong.
 *
 * CHESTS ARE NOT ENTITIES. `World.spawnFromLevel` draws that line itself — props
 * and chests are "drawn and collided with, not simulated as combatants", and an
 * entity in the live array goes through the AI's target scan every tick. So they
 * live in this system's own array, like projectiles, and are read out through a
 * snapshot.
 */

const OPEN = `
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
  ....................
`

/** A level with chests at the given tiles. `reward` rides along as open data. */
function levelWithChests(chests: readonly SpawnPoint[]): LevelData {
  const base = asciiLevel(OPEN)
  return { ...base, spawns: { ...base.spawns, chests } }
}

/** Counts the objective system was told about, without needing the real one. */
function spyObjectives() {
  let collected = 0
  return {
    collectChest(): void {
      collected += 1
    },
    get collected(): number {
      return collected
    },
  }
}

function rig(chests: readonly SpawnPoint[], radiusTiles?: number) {
  const level = levelWithChests(chests)
  const world = new World(level, { seed: 1 })
  const armoury = createArmoury({ starting: { grenade: 0, rocket: 0 } })
  const objectives = spyObjectives()
  const pickups = createPickupSystem(
    level,
    radiusTiles === undefined
      ? { objectives, armoury }
      : { objectives, armoury, radiusTiles },
  )
  world.addSystem(pickups)
  const events: SimEvent[] = []
  return {
    world,
    armoury,
    objectives,
    pickups,
    level,
    at: (x: number, y: number) => tileToWorld(x, y, level.size),
    /** A man standing exactly on a tile centre. */
    spawn(tileX: number, tileY: number, team: 'player' | 'enemy' = 'player', health = 10) {
      const p = tileToWorld(tileX, tileY, level.size)
      return world.spawn({ kind: 'rifleman', team, x: p.x, z: p.z, health })
    },
    run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) {
        world.tick()
        events.push(...world.drainEvents())
      }
    },
    events,
    collections: () => events.filter((e) => e.type === 'ChestCollected'),
  }
}

describe('a chest is taken by standing on it', () => {
  it('is there to begin with', () => {
    // Without this, every "it was collected" case below is satisfied by a system
    // that never loaded any chests at all.
    const r = rig([{ x: 5, y: 5 }])
    expect(r.pickups.remaining()).toHaveLength(1)
  })

  it('is gone once a man reaches it', () => {
    const r = rig([{ x: 5, y: 5 }])
    r.spawn(5, 5)
    r.run(2)
    expect(r.pickups.remaining()).toHaveLength(0)
  })

  it('is left alone while nobody is near', () => {
    const r = rig([{ x: 5, y: 5 }])
    r.spawn(18, 9)
    r.run(60)
    expect(r.pickups.remaining()).toHaveLength(1)
    expect(r.collections()).toHaveLength(0)
  })

  it('is taken from a tile away, not only from exactly on top', () => {
    // A squad halts where it halts. Requiring the man to stand on the chest's
    // exact centre would make collection feel like a bug.
    const r = rig([{ x: 5, y: 5 }])
    r.spawn(6, 5)
    r.run(2)
    expect(r.pickups.remaining()).toHaveLength(0)
  })

  it('is not taken from across the field', () => {
    const r = rig([{ x: 5, y: 5 }], 1)
    r.spawn(9, 5)
    r.run(10)
    expect(r.pickups.remaining()).toHaveLength(1)
  })

  it('uses the radius it was given', () => {
    // Same geometry, two radii. If the option were ignored these would agree.
    const near = rig([{ x: 5, y: 5 }], 1)
    near.spawn(8, 5)
    near.run(5)
    const far = rig([{ x: 5, y: 5 }], 4)
    far.spawn(8, 5)
    far.run(5)
    expect({ near: near.pickups.remaining().length, far: far.pickups.remaining().length }).toEqual({
      near: 1,
      far: 0,
    })
  })

  it('has a default radius that is generous but not a magnet', () => {
    // At least a tile, because a squad halts where it halts and asking a man to
    // stand on the chest's exact centre would make collection feel like a bug.
    // No more than three, or chests start collecting themselves from across a
    // clearing and the player never learns where they were.
    expect(DEFAULT_COLLECT_RADIUS_TILES).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_COLLECT_RADIUS_TILES).toBeLessThanOrEqual(3)
  })

  it('measures a circle, not a square', () => {
    // Chebyshev would let a man collect from the corner of a square envelope,
    // which players find by standing at them — the same argument `inRange` makes.
    const r = rig([{ x: 5, y: 5 }], 2)
    r.spawn(7, 7) // 2.83 tiles away
    r.run(5)
    expect(r.pickups.remaining()).toHaveLength(1)
  })
})

describe('exactly once', () => {
  it('a whole squad standing on one chest collects it once', () => {
    /**
     * THE NORMAL CASE, NOT AN EDGE ONE. A detachment moves together and arrives
     * together, so five men in range on the same tick is what ordinarily
     * happens. Awarding per man in range would quintuple every chest in the
     * game, and the bug would look like generous loot rather than a defect.
     */
    const r = rig([{ x: 5, y: 5, reward: { grenade: 2 } }])
    for (let i = 0; i < 5; i += 1) r.spawn(5, 5)
    r.run(5)
    expect(r.collections()).toHaveLength(1)
    expect(r.armoury.count('grenade')).toBe(2)
    expect(r.objectives.collected).toBe(1)
  })

  it('is not collected again on later ticks', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: 1 } }])
    r.spawn(5, 5)
    r.run(120)
    expect(r.collections()).toHaveLength(1)
    expect(r.armoury.count('grenade')).toBe(1)
  })

  it('credits the lowest entity id in range', () => {
    // A fact about the world rather than about loop order — the same tie-break
    // `CombatSystem.pickTarget` uses, and the reason two identical missions
    // agree about who picked what up.
    const r = rig([{ x: 5, y: 5 }])
    const first = r.spawn(5, 5)
    r.spawn(5, 5)
    r.spawn(5, 5)
    r.run(2)
    const taken = r.collections()[0]
    if (taken?.type !== 'ChestCollected') throw new Error('nothing collected')
    expect(taken.collectorId).toBe(first.id)
  })

  it('collects two separate chests separately', () => {
    const r = rig([
      { x: 3, y: 3, reward: { grenade: 1 } },
      { x: 8, y: 8, reward: { rocket: 1 } },
    ])
    r.spawn(3, 3)
    r.spawn(8, 8)
    r.run(5)
    expect(r.collections()).toHaveLength(2)
    expect({ g: r.armoury.count('grenade'), k: r.armoury.count('rocket') }).toEqual({ g: 1, k: 1 })
    expect(r.objectives.collected).toBe(2)
  })

  it('reports chests in level order, so two runs agree', () => {
    const r = rig([
      { x: 3, y: 3 },
      { x: 8, y: 8 },
      { x: 1, y: 9 },
    ])
    expect(r.pickups.remaining().map((c) => `${String(c.tileX)},${String(c.tileY)}`)).toEqual([
      '3,3',
      '8,8',
      '1,9',
    ])
  })
})

describe('who may collect', () => {
  it('an enemy walking over one takes nothing', () => {
    // Otherwise an ammo crate is something the AI denies you by accident, which
    // reads as the chest having despawned on its own.
    const r = rig([{ x: 5, y: 5, reward: { grenade: 3 } }])
    r.spawn(5, 5, 'enemy')
    r.run(30)
    expect(r.pickups.remaining()).toHaveLength(1)
    expect(r.armoury.count('grenade')).toBe(0)
  })

  it('a player standing beside that enemy still collects it', () => {
    // The control: a system that collected for nobody would pass the case above.
    const r = rig([{ x: 5, y: 5, reward: { grenade: 3 } }])
    r.spawn(5, 5, 'enemy')
    r.spawn(5, 5, 'player')
    r.run(5)
    expect(r.armoury.count('grenade')).toBe(3)
  })

  it('a dead man collects nothing', () => {
    const r = rig([{ x: 5, y: 5 }])
    const man = r.spawn(5, 5)
    r.world.despawn(man.id)
    r.run(10)
    expect(r.pickups.remaining()).toHaveLength(1)
  })
})

describe('the reward is level data', () => {
  it('grants exactly what the document says', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: 2, rocket: 3 } }])
    r.spawn(5, 5)
    r.run(2)
    expect({ g: r.armoury.count('grenade'), k: r.armoury.count('rocket') }).toEqual({ g: 2, k: 3 })
  })

  it('two chests with different rewards give different things', () => {
    // The proof it is read rather than assumed: a hardcoded reward would make
    // these agree.
    const r = rig([
      { x: 2, y: 2, reward: { grenade: 5 } },
      { x: 8, y: 2, reward: { rocket: 1 } },
    ])
    r.spawn(2, 2)
    r.run(3)
    const afterFirst = { g: r.armoury.count('grenade'), k: r.armoury.count('rocket') }
    r.spawn(8, 2)
    r.run(3)
    expect(afterFirst).toEqual({ g: 5, k: 0 })
    expect({ g: r.armoury.count('grenade'), k: r.armoury.count('rocket') }).toEqual({ g: 5, k: 1 })
  })

  it('carries the reward on the event, so a kill feed needs no lookup', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: 2 } }])
    r.spawn(5, 5)
    r.run(2)
    const taken = r.collections()[0]
    if (taken?.type !== 'ChestCollected') throw new Error('nothing collected')
    expect(taken.reward).toEqual({ grenade: 2 })
  })

  it('reports on the event what was actually granted, not what was offered', () => {
    /**
     * A KILL FEED READS THIS AND NOTHING ELSE. `Armoury.grant` refuses negative,
     * fractional and non-finite amounts (ticket 016), so a chest whose table
     * says `{ grenade: -5 }` hands over nothing — and an event that echoed the
     * table verbatim would have the feed announce "+ -5 grenades" while the
     * pouch did not move. The event is the only channel presentation has; it has
     * to describe what happened, not what was asked for.
     */
    const r = rig([{ x: 5, y: 5, reward: { grenade: -5, rocket: 2 } }])
    r.spawn(5, 5)
    r.run(2)
    const taken = r.collections()[0]
    if (taken?.type !== 'ChestCollected') throw new Error('nothing collected')
    expect(taken.reward).toEqual({ rocket: 2 })
    expect(r.armoury.count('grenade')).toBe(0)
    expect(r.armoury.count('rocket')).toBe(2)
  })

  it('names the chest and where it stood, because it is gone by the time anyone looks', () => {
    // The whole reason position rides on the event: a consumer that tried to
    // look the chest up to draw a sparkle would find it already collected.
    const r = rig([
      { x: 2, y: 2 },
      { x: 7, y: 4 },
    ])
    r.spawn(7, 4)
    r.run(2)
    const taken = r.collections()[0]
    if (taken?.type !== 'ChestCollected') throw new Error('nothing collected')
    const where = r.at(7, 4)
    expect({ index: taken.index, x: taken.x, z: taken.z }).toEqual({
      index: 1,
      x: where.x,
      z: where.z,
    })
  })

  it('a chest keeps its index after an earlier one is taken', () => {
    // `index` is how a renderer pools chest meshes. Renumbering the survivors on
    // every collection would make the models jump between positions.
    const r = rig([
      { x: 2, y: 2 },
      { x: 7, y: 4 },
      { x: 9, y: 9 },
    ])
    r.spawn(2, 2)
    r.run(2)
    expect(r.pickups.remaining().map((c) => c.index)).toEqual([1, 2])
  })

  it('remaining carries each chest`s reward', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: 2 } }])
    expect(r.pickups.remaining()[0]?.reward).toEqual({ grenade: 2 })
  })

  it('a caller cannot edit the reward out from under the system', () => {
    // The aliasing rule one level down, and the one the fresh-array check misses:
    // handing back the system's own reward object lets a renderer that pokes at
    // it change what the next man to walk over the chest receives.
    const r = rig([{ x: 5, y: 5, reward: { grenade: 2 } }])
    const held = r.pickups.remaining()[0]?.reward as Record<string, number>
    held.grenade = 999
    r.spawn(5, 5)
    r.run(2)
    expect(r.armoury.count('grenade')).toBe(2)
  })

  it('a chest naming no reward still gives something', () => {
    // An unannotated chest is an authoring omission, not an empty box: a chest
    // that gave nothing would read as broken rather than as empty.
    const r = rig([{ x: 5, y: 5 }])
    r.spawn(5, 5)
    r.run(2)
    const granted = r.armoury.count('grenade') + r.armoury.count('rocket')
    expect(granted).toBeGreaterThan(0)
  })

  it('needs no schemaVersion bump to carry one', () => {
    /**
     * `SpawnPoint` is already open (`[field: string]: unknown`) and `core/level`
     * deep-copies unknown fields verbatim — the extension point its own header
     * describes. If this ticket had needed a schema change, the schema's promise
     * about tile ids, objective types and archetypes would have been worth less
     * than it claims.
     */
    const r = rig([{ x: 5, y: 5, reward: { grenade: 1 } }])
    expect(r.level.schemaVersion).toBe(asciiLevel(OPEN).schemaVersion)
  })
})

describe('hostile reward data, because a level document is hand-authored', () => {
  it('a negative reward does not confiscate rounds', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: -5 } }])
    r.armoury.grant('grenade', 3)
    r.spawn(5, 5)
    r.run(2)
    expect(r.armoury.count('grenade')).toBe(3)
  })

  it('a fractional reward does not bank half a grenade', () => {
    const r = rig([{ x: 5, y: 5, reward: { grenade: 1.5 } }])
    r.spawn(5, 5)
    r.run(2)
    expect(Number.isInteger(r.armoury.count('grenade'))).toBe(true)
  })

  it('a non-finite reward does not become infinite ammo', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = rig([{ x: 5, y: 5, reward: { grenade: bad } }])
      r.spawn(5, 5)
      r.run(2)
      expect({ bad: String(bad), finite: Number.isFinite(r.armoury.count('grenade')) }).toEqual({
        bad: String(bad),
        finite: true,
      })
    }
  })

  it('a reward that is not an object at all reads as an omission, not as nothing', () => {
    /**
     * THE JUDGEMENT CALL, PINNED — because the suite would otherwise accept the
     * opposite decision just as happily.
     *
     * `reward: 'grenade'` and no `reward` field carry identical information:
     * "no legible reward here". Making the malformed one MORE punishing than the
     * missing one is backwards. And the failure modes are not symmetric — a
     * chest that despawns and gives nothing is indistinguishable at runtime from
     * a broken pickup system, and `src/core` has no logger to say otherwise,
     * whereas a default grant is visible and self-reporting.
     *
     * The honest cost: a `tools/mapgen` bug emitting `reward: "grenade"` across
     * forty chests ships silently as forty identical default ones. That argues
     * for validation in the importer, which is where a level document can still
     * be rejected loudly — not for a harsher rule here.
     */
    for (const reward of [null, 'grenade', 7, [1, 2]]) {
      const r = rig([{ x: 5, y: 5, reward }])
      r.spawn(5, 5)
      r.run(2)
      const granted = r.armoury.count('grenade') + r.armoury.count('rocket')
      expect({ reward: JSON.stringify(reward), granted: granted > 0 }).toEqual({
        reward: JSON.stringify(reward),
        granted: true,
      })
    }
  })

  it('an amount that is not a number grants nothing for that entry', () => {
    // Coercing `'2'` with `Number()` would be a quiet kindness that makes the
    // document's type mean nothing, and it is one `Number(undefined)` away from
    // handing `NaN` to the armoury.
    const r = rig([{ x: 5, y: 5, reward: { grenade: '2', rocket: 1 } }])
    r.spawn(5, 5)
    r.run(2)
    expect({ g: r.armoury.count('grenade'), k: r.armoury.count('rocket') }).toEqual({ g: 0, k: 1 })
  })

  it('a chest off the map is still a chest, not a crash', () => {
    const r = rig([{ x: -3, y: 99 }])
    r.spawn(5, 5)
    expect(() => r.run(5)).not.toThrow()
  })

  it('no chests at all is a valid level', () => {
    // Which is exactly what level 1 is today.
    const r = rig([])
    r.spawn(5, 5)
    r.run(10)
    expect({ remaining: r.pickups.remaining(), taken: r.collections().length }).toEqual({
      remaining: [],
      taken: 0,
    })
  })
})

describe('what `remaining` hands back is the caller`s to keep', () => {
  it('does not alias the system`s own array', () => {
    /**
     * The optimisation someone will reach for, and the tracer buffer and the
     * ordnance system have each already had it caught once. A renderer holding
     * last frame's list must not watch chests vanish out from under it mid-draw.
     */
    const r = rig([{ x: 5, y: 5 }, { x: 8, y: 8 }])
    const held = r.pickups.remaining()
    expect(held).toHaveLength(2)
    r.spawn(5, 5)
    r.run(5)
    expect(held).toHaveLength(2)
  })

  it('hands back a different array each time', () => {
    const r = rig([{ x: 5, y: 5 }])
    expect(r.pickups.remaining()).not.toBe(r.pickups.remaining())
  })
})

describe('determinism', () => {
  it('two identical runs produce identical event streams', () => {
    const play = () => {
      const r = rig([
        { x: 3, y: 3, reward: { grenade: 1 } },
        { x: 4, y: 3, reward: { rocket: 2 } },
      ])
      r.spawn(3, 3)
      r.spawn(4, 3)
      r.spawn(3, 4)
      r.run(20)
      return JSON.stringify(r.events)
    }
    expect(play()).toBe(play())
  })

  it('draws nothing from the world`s PRNG', () => {
    const r = rig([{ x: 5, y: 5 }])
    r.spawn(5, 5)
    const before = r.world.rng.getState()
    r.run(20)
    expect(r.world.rng.getState()).toBe(before)
  })
})
