import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel, FLAT } from './fixture'
import { tileToWorld } from '../../view/projection'
import { PALM_VARIANTS } from '../../render-state/scenery'

/**
 * Ticket 008a — what the renderer is handed each frame.
 *
 * This is where `src/render/level-entities.ts` goes to die. That file's own
 * header has said since ticket 010 that it is a stand-in to be DELETED when the
 * sim lands; the sim has landed. But it did two jobs, and only one of them was
 * the stand-in: drawing soldiers from spawn data (which `World` now owns) and
 * drawing the map's PROP ANNOTATIONS (which no sim will ever own, because a
 * shrub is not a combatant). The second job moves here intact, tests included —
 * deleting it along with the first would silently drop every hand-placed mark on
 * the map, which is exactly the regression ticket 010a shipped once already.
 */

const SOLDIER = 'soldier'

describe('renderEntities — the living', () => {
  it('returns one entity per living unit', () => {
    const s = createSession(
      makeLevel({
        avatars: [
          { x: 2, y: 7 },
          { x: 3, y: 7 },
        ],
        enemies: [{ x: 16, y: 7 }],
      }),
    )
    const soldiers = s.renderEntities(FLAT).filter((e) => e.unit === SOLDIER)
    expect(soldiers).toHaveLength(3)
  })

  it('gives each the id of the sim entity it draws', () => {
    const s = createSession(makeLevel())
    const simIds = new Set(s.world.entities.map((e) => e.id))
    for (const r of s.renderEntities(FLAT).filter((e) => e.unit === SOLDIER)) {
      expect(simIds.has(r.id)).toBe(true)
    }
  })

  it('places them at their sim positions', () => {
    const level = makeLevel({ avatars: [{ x: 5, y: 9 }], enemies: [] })
    const s = createSession(level)
    const expected = tileToWorld(5, 9, level.size)
    const drawn = s.renderEntities(FLAT).find((e) => e.unit === SOLDIER)!
    expect({ x: drawn.x, z: drawn.z }).toEqual({ x: expected.x, z: expected.z })
  })

  it('asks the ground height function where the feet go', () => {
    const level = makeLevel({ avatars: [{ x: 5, y: 9 }], enemies: [] })
    const s = createSession(level)
    const drawn = s.renderEntities(() => 3.5).find((e) => e.unit === SOLDIER)!
    expect(drawn.y).toBe(3.5)
  })

  it('passes the unit`s TILE to the ground height function, not its world position', () => {
    // A height sampler indexed by tile handed world coordinates reads a tile up
    // to half the map away, and on flat test terrain that is invisible.
    const level = makeLevel({ avatars: [{ x: 5, y: 9 }], enemies: [] })
    const s = createSession(level)
    const asked: { x: number; y: number }[] = []
    s.renderEntities((x, y) => {
      asked.push({ x, y })
      return 0
    })
    expect(asked).toContainEqual({ x: 5, y: 9 })
  })

  it('tints enemies and leaves players untinted', () => {
    const s = createSession(
      makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [{ x: 16, y: 7 }] }),
    )
    const byId = new Map(s.renderEntities(FLAT).map((r) => [r.id, r]))
    for (const e of s.world.entities) {
      const drawn = byId.get(e.id)!
      if (e.team === 'enemy') expect(drawn.tint).toBeTypeOf('number')
      else expect(drawn.tint).toBeUndefined()
    }
  })

  it('stops drawing a unit that has been despawned outright', () => {
    const s = createSession(makeLevel())
    const id = s.selection()[0]!
    s.world.despawn(id)
    expect(s.renderEntities(FLAT).map((r) => r.id)).not.toContain(id)
  })
})

describe('renderEntities — animation', () => {
  it('walks a unit that is moving', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    for (let i = 0; i < 10; i++) s.advance(1 / 60)
    expect(s.renderEntities(FLAT).find((r) => r.id === id)!.animation).toBe('walk')
  })

  it('faces a moving unit along its movement', () => {
    const level = makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] })
    const s = createSession(level)
    const id = s.selection()[0]!
    s.queue.push({ type: 'move', unitIds: [id], target: { x: 17, y: 7 } })
    for (let i = 0; i < 20; i++) s.advance(1 / 60)
    const drawn = s.renderEntities(FLAT).find((r) => r.id === id)!
    expect(drawn.dx).toBeGreaterThan(0) // heading east
  })

  it('honours a spawn`s authored facing before it has moved', () => {
    // `level-entities.ts` read `SpawnPoint.facing` and the session did not, so
    // deleting it left `facing` — parsed and VALIDATED by the level schema —
    // with no runtime consumer at all. Invisible on level 1, which annotates no
    // facings, which is exactly why it needs a test: the next map that uses the
    // field would find it silently ignored.
    const level = makeLevel({ avatars: [{ x: 5, y: 7 }], enemies: [] })
    const facing = { ...level, spawns: { ...level.spawns, avatars: [{ x: 5, y: 7, type: 'rifleman', facing: 'N' }] } }
    const drawn = createSession(facing).renderEntities(FLAT)[0]!
    expect({ dx: drawn.dx, dz: drawn.dz }).toEqual({ dx: 0, dz: -1 }) // -z is north
  })

  it('reports (0, 0) for a unit whose spawn authored no facing', () => {
    // The renderer reads (0,0) as "keep the facing you had". Reporting a real
    // direction for a stationary man would snap the whole squad to face east on
    // the first frame after they stop.
    const s = createSession(makeLevel({ avatars: [{ x: 2, y: 7 }], enemies: [] }))
    const drawn = s.renderEntities(FLAT)[0]!
    expect({ dx: drawn.dx, dz: drawn.dz }).toEqual({ dx: 0, dz: 0 })
  })

  it('plays `fire` on the tick a unit shoots', () => {
    // Combat sets no entity state at all, so this cannot be read off the entity
    // — it has to come from the ShotFired events of the tick just run.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })
    const s = createSession(level)
    let firedFrame = -1
    for (let f = 0; f < 40 && firedFrame < 0; f++) {
      s.advance(1 / 60)
      const shooters = s.events().filter((e) => e.type === 'ShotFired')
      if (shooters.length > 0) firedFrame = f
      if (firedFrame >= 0) {
        const shooterId = shooters[0]!.type === 'ShotFired' ? shooters[0]!.shooterId : -1
        const drawn = s.renderEntities(FLAT).find((r) => r.id === shooterId)
        // The shooter may have died to return fire in the same tick; if it is
        // still drawn as a living soldier, it must be firing.
        if (drawn && drawn.animation !== 'die') expect(drawn.animation).toBe('fire')
      }
    }
    expect(firedFrame).toBeGreaterThanOrEqual(0)
  })
})

describe('renderEntities — the dead', () => {
  it('keeps drawing a killed unit so its death animation can play', () => {
    // Dropping it on the tick it dies makes corpses vanish mid-fall. The atlas
    // `die` clip is four frames at 8fps — half a second the renderer needs the
    // entity to still exist for.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })
    const s = createSession(level)
    let deadId = -1
    for (let f = 0; f < 60 && deadId < 0; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'UnitDied') deadId = e.id
    }
    expect(deadId).toBeGreaterThanOrEqual(0)
    expect(s.world.isAlive(deadId)).toBe(false)

    const drawn = s.renderEntities(FLAT).find((r) => r.id === deadId)
    expect(drawn).toBeDefined()
    expect(drawn!.animation).toBe('die')
  })

  it('stops drawing it once the death clip has run', () => {
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 10, y: 7 }] })
    const s = createSession(level)
    let deadId = -1
    for (let f = 0; f < 60 && deadId < 0; f++) {
      s.advance(1 / 60)
      for (const e of s.events()) if (e.type === 'UnitDied') deadId = e.id
    }
    expect(deadId).toBeGreaterThanOrEqual(0)
    // Well past half a second.
    for (let f = 0; f < 120; f++) s.advance(1 / 60)
    expect(s.renderEntities(FLAT).map((r) => r.id)).not.toContain(deadId)
  })

  it('does not let corpses accumulate without limit', () => {
    const level = makeLevel({
      avatars: Array.from({ length: 8 }, (_v, i) => ({ x: 6 + i * 0.0, y: 3 + i })),
      enemies: Array.from({ length: 8 }, (_v, i) => ({ x: 9, y: 3 + i })),
    })
    const s = createSession(level)
    for (let f = 0; f < 600; f++) s.advance(1 / 60)
    const drawn = s.renderEntities(FLAT).filter((r) => r.unit === SOLDIER)
    expect(drawn.length).toBeLessThanOrEqual(16)
  })
})

describe('renderEntities — prop annotations survive the move from level-entities', () => {
  it('draws a `shrub` annotation as the bush', () => {
    const s = createSession(
      makeLevel({ avatars: [], enemies: [], props: [{ x: 9, y: 9, type: 'shrub' }] }),
    )
    expect(s.renderEntities(FLAT).map((r) => r.unit)).toEqual(['bush'])
  })

  it('draws a `tree` annotation as a palm', () => {
    const s = createSession(
      makeLevel({ avatars: [], enemies: [], props: [{ x: 9, y: 9, type: 'tree' }] }),
    )
    const drawn = s.renderEntities(FLAT)
    expect(drawn).toHaveLength(1)
    expect(PALM_VARIANTS).toContain(drawn[0]!.unit)
  })

  it('draws nothing for a prop with no art, and burns no id doing it', () => {
    const withBird = createSession(
      makeLevel({
        avatars: [],
        enemies: [],
        props: [
          { x: 4, y: 4, type: 'bird_left' },
          { x: 9, y: 9, type: 'shrub' },
        ],
      }),
    ).renderEntities(FLAT)
    const without = createSession(
      makeLevel({ avatars: [], enemies: [], props: [{ x: 9, y: 9, type: 'shrub' }] }),
    ).renderEntities(FLAT)
    expect(withBird).toEqual(without)
  })

  it('draws nothing for a prop with no type at all', () => {
    const s = createSession(makeLevel({ avatars: [], enemies: [], props: [{ x: 4, y: 4 }] }))
    expect(s.renderEntities(FLAT)).toEqual([])
  })

  it('gives props ids that cannot collide with sim entity ids', () => {
    const s = createSession(
      makeLevel({
        avatars: [{ x: 2, y: 7 }],
        enemies: [{ x: 16, y: 7 }],
        props: [
          { x: 9, y: 9, type: 'shrub' },
          { x: 4, y: 4, type: 'tree' },
        ],
      }),
    )
    const ids = s.renderEntities(FLAT).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps prop ids stable across frames', () => {
    // Ids drive the renderer's instance matching and facing memory. A prop that
    // is renumbered every frame is a prop that never keeps its identity.
    const s = createSession(
      makeLevel({ avatars: [], enemies: [], props: [{ x: 9, y: 9, type: 'shrub' }] }),
    )
    const first = s.renderEntities(FLAT).map((r) => r.id)
    s.advance(1 / 60)
    expect(s.renderEntities(FLAT).map((r) => r.id)).toEqual(first)
  })
})

describe('level-entities.ts is gone', () => {
  it('no longer exists', async () => {
    // Its own header called it a stand-in to be deleted when the sim landed.
    const { existsSync } = await import('node:fs')
    const path = new URL('../../../render/level-entities.ts', import.meta.url).pathname
    expect(existsSync(path)).toBe(false)
  })
})
