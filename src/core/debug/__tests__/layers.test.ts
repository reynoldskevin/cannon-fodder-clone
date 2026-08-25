import { describe, it, expect } from 'vitest'
import { createSession } from '../../session'
import { makeLevel } from '../../session/__tests__/fixture'
import { tileToWorld } from '../../view/projection'
import { DEBUG_LAYERS, debugSnapshot, emptySnapshot, layerForHotkey } from '../index'
import type { DebugLayerId } from '../index'

/**
 * Ticket 014 — what the debug overlay would draw, as plain data.
 *
 * THE WHOLE REASON THIS LAYER IS PURE. Vitest runs `environment: 'node'`: there
 * is no DOM and no WebGL at test time, so a debug overlay written as one
 * Three.js file would be verified by loading the page and squinting. Splitting
 * the DECISIONS (which tiles, which arrows, which rays, whose state) from the
 * DRAWING leaves the half that can be wrong under test, and leaves the half that
 * cannot be tested as a loop over an array.
 *
 * A DEBUG TOOL WITH NO TESTS IS WORSE THAN NO DEBUG TOOL. It is the instrument
 * the next person tunes combat with, and an instrument that lies quietly is how
 * a tuning session ends in a change that fixes nothing. Every layer below is
 * asserted to be EMPTY when the thing it draws is absent, as well as populated
 * when it is present — a layer that always returns something looks like it works.
 */

/** Player and enemy in plain sight, three tiles apart: an engagement, quickly. */
const engagement = () => makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 11, y: 7 }] })

/** Far enough apart that nothing acquires anything and nothing shoots. */
const quiet = () => makeLevel({ avatars: [{ x: 2, y: 2 }], enemies: [{ x: 18, y: 13 }] })

/** A session with a player tough enough that the engagement outlives one round. */
function engaged() {
  const level = engagement()
  const s = createSession(level)
  const at = tileToWorld(10, 7, level.size)
  s.world.spawn({ kind: 'rifleman', team: 'player', x: at.x, z: at.z, health: 10_000 })
  for (let f = 0; f < 30; f += 1) s.advance(1 / 60)
  return s
}

/** Every layer on, which is what most of these cases want. */
const ALL: readonly DebugLayerId[] = DEBUG_LAYERS.map((l) => l.id)

describe('the layer registry', () => {
  it('is data, so the hotkey handler and the legend cannot drift apart', () => {
    // A `switch` in the key handler and a list in the legend are two places to
    // say the same thing, and they diverge the first time a layer is added.
    expect(DEBUG_LAYERS.length).toBeGreaterThan(0)
    for (const layer of DEBUG_LAYERS) {
      expect({ id: layer.id, hasLabel: layer.label.length > 0, key: layer.hotkey }).toEqual({
        id: layer.id,
        hasLabel: true,
        key: layer.hotkey,
      })
    }
  })

  it('gives every layer a distinct hotkey', () => {
    const keys = DEBUG_LAYERS.map((l) => l.hotkey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every layer a distinct id', () => {
    const ids = DEBUG_LAYERS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers the layers the ticket names', () => {
    expect([...ALL].sort()).toEqual([
      'ai',
      'entityIds',
      'flowField',
      'losRays',
      'navGrid',
    ])
  })
})

describe('nothing is computed for a layer that is switched off', () => {
  it('an empty layer set draws nothing at all', () => {
    // The overlay is a per-frame cost on a machine that is already struggling
    // enough for somebody to have opened it. A switched-off layer must be free,
    // not merely invisible.
    const snapshot = debugSnapshot(engaged(), [])
    expect(snapshot).toEqual(emptySnapshot())
  })

  it('asking for one layer computes only that one', () => {
    const s = engaged()
    const only = debugSnapshot(s, ['navGrid'])
    expect(only.navGrid.length).toBeGreaterThan(0)
    expect({
      flowField: only.flowField,
      losRays: only.losRays,
      ai: only.ai,
      entityIds: only.entityIds,
    }).toEqual({ flowField: [], losRays: [], ai: [], entityIds: [] })
  })
})

describe('the nav grid layer', () => {
  it('reports a cell per tile, with its passability', () => {
    const blocked = new Set(['5,5', '5,6'])
    const s = createSession(makeLevel({ blocked }))
    const cells = debugSnapshot(s, ['navGrid']).navGrid
    expect(cells).toHaveLength(20 * 15)
    const at = (x: number, y: number) => cells.find((c) => c.x === x && c.y === y)
    expect({ blockedCell: at(5, 5)?.passable, openCell: at(1, 1)?.passable }).toEqual({
      blockedCell: false,
      openCell: true,
    })
  })

  it('agrees with the level it was baked from', () => {
    // Asserted against the DOCUMENT rather than against the grid, so a debug
    // overlay drawing a grid that disagrees with the map is caught here rather
    // than by a person wondering why a man walked through a wall it drew.
    const blocked = new Set(['3,4', '9,9', '12,2'])
    const level = makeLevel({ blocked })
    const s = createSession(level)
    for (const cell of debugSnapshot(s, ['navGrid']).navGrid) {
      expect({ x: cell.x, y: cell.y, passable: cell.passable }).toEqual({
        x: cell.x,
        y: cell.y,
        passable: level.walkable[cell.y]?.[cell.x] === true,
      })
    }
  })
})

describe('the flow field layer', () => {
  it('is empty while nobody is under orders', () => {
    expect(debugSnapshot(createSession(quiet()), ['flowField']).flowField).toEqual([])
  })

  it('draws arrows once the squad is marching', () => {
    const s = createSession(quiet())
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 16, y: 12 } })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    const arrows = debugSnapshot(s, ['flowField']).flowField
    expect(arrows.length).toBeGreaterThan(0)
  })

  it('the arrows point at the destination that was ordered', () => {
    /**
     * The assertion that makes this layer worth drawing. An arrow field that is
     * merely NON-EMPTY tells a tuner nothing; one that points the wrong way
     * would send them hunting a pathing bug that does not exist.
     *
     * Checked at the squad's own tile: the arrow there must have a positive x
     * component, because the destination is to its east.
     */
    const s = createSession(makeLevel({ avatars: [{ x: 3, y: 7 }], enemies: [] }))
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 17, y: 7 } })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    const arrows = debugSnapshot(s, ['flowField']).flowField
    const here = arrows.find((a) => a.x === 3 && a.y === 7)
    expect(here).toBeDefined()
    expect(here!.dx).toBeGreaterThan(0)
  })

  it('names the destination each field descends to', () => {
    const s = createSession(makeLevel({ avatars: [{ x: 3, y: 7 }], enemies: [] }))
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target: { x: 17, y: 7 } })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    const arrows = debugSnapshot(s, ['flowField']).flowField
    expect(new Set(arrows.map((a) => `${String(a.targetX)},${String(a.targetY)}`))).toEqual(
      new Set(['17,7']),
    )
  })
})

describe('the line-of-sight layer', () => {
  it('is empty while nobody is engaging', () => {
    expect(debugSnapshot(createSession(quiet()), ['losRays']).losRays).toEqual([])
  })

  it('draws a ray from an engaging enemy to the man it is shooting at', () => {
    const s = engaged()
    const rays = debugSnapshot(s, ['losRays']).losRays
    expect(rays.length).toBeGreaterThan(0)
    const ray = rays[0]!
    const shooter = s.world.get(ray.shooterId)
    const target = s.world.get(ray.targetId)
    expect({ shooterTeam: shooter?.team, targetTeam: target?.team }).toEqual({
      shooterTeam: 'enemy',
      targetTeam: 'player',
    })
  })

  it('the ray`s endpoints are where the two men actually stand', () => {
    // Endpoints in WORLD units, taken from the entities rather than recomputed
    // from tiles — a ray drawn half a tile off is exactly the sort of thing that
    // makes a tuner distrust the LOS code instead of the overlay.
    const s = engaged()
    const ray = debugSnapshot(s, ['losRays']).losRays[0]!
    const shooter = s.world.get(ray.shooterId)!
    const target = s.world.get(ray.targetId)!
    expect({ x: ray.fromX, z: ray.fromZ, tx: ray.toX, tz: ray.toZ }).toEqual({
      x: shooter.x,
      z: shooter.z,
      tx: target.x,
      tz: target.z,
    })
  })

  it('draws the target the machine picked, not one of its own choosing', () => {
    // Two candidates, and the AI's rule is nearest-first. An overlay that
    // recomputed a target would be free to disagree, and a debug tool that
    // disagrees with the thing it is debugging is worse than none.
    const level = makeLevel({ avatars: [{ x: 8, y: 7 }], enemies: [{ x: 14, y: 7 }] })
    const s = createSession(level)
    const near = tileToWorld(12, 7, level.size)
    const far = tileToWorld(9, 7, level.size)
    const nearId = s.world.spawn({
      kind: 'rifleman',
      team: 'player',
      x: near.x,
      z: near.z,
      health: 10_000,
    }).id
    s.world.spawn({ kind: 'rifleman', team: 'player', x: far.x, z: far.z, health: 10_000 })
    for (let f = 0; f < 30; f += 1) s.advance(1 / 60)
    const ray = debugSnapshot(s, ['losRays']).losRays[0]!
    expect(ray.targetId).toBe(nearId)
  })
})

describe('the AI state layer', () => {
  it('reports a state for every living enemy', () => {
    const s = engaged()
    const states = debugSnapshot(s, ['ai']).ai
    const enemies = s.world.entities.filter((e) => e.team === 'enemy')
    expect(states.map((a) => a.id).sort()).toEqual(enemies.map((e) => e.id).sort())
  })

  it('reports the state the machine is actually in', () => {
    const s = engaged()
    const state = debugSnapshot(s, ['ai']).ai[0]!
    expect({ drawn: state.state, actual: s.ai.stateOf(state.id) }).toEqual({
      drawn: 'engage',
      actual: 'engage',
    })
  })

  it('carries the position to draw the label at', () => {
    const s = engaged()
    const state = debugSnapshot(s, ['ai']).ai[0]!
    const entity = s.world.get(state.id)!
    expect({ x: state.x, z: state.z }).toEqual({ x: entity.x, z: entity.z })
  })

  it('says nothing about the player team, which has no AI', () => {
    const s = engaged()
    const players = new Set(
      s.world.entities.filter((e) => e.team === 'player').map((e) => e.id),
    )
    expect(debugSnapshot(s, ['ai']).ai.filter((a) => players.has(a.id))).toEqual([])
  })

  it('drops an enemy that has died', () => {
    const s = engaged()
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    s.world.despawn(enemy)
    s.advance(1 / 60)
    expect(debugSnapshot(s, ['ai']).ai.map((a) => a.id)).not.toContain(enemy)
  })
})

describe('the entity id layer', () => {
  it('reports every living entity, both teams', () => {
    const s = engaged()
    const drawn = debugSnapshot(s, ['entityIds']).entityIds
    expect(drawn.map((e) => e.id).sort()).toEqual(s.world.entities.map((e) => e.id).sort())
  })

  it('carries the team, so the label can be coloured by side', () => {
    const s = engaged()
    for (const drawn of debugSnapshot(s, ['entityIds']).entityIds) {
      expect({ id: drawn.id, team: drawn.team }).toEqual({
        id: drawn.id,
        team: s.world.get(drawn.id)?.team,
      })
    }
  })
})

describe('the snapshot allocates nothing it was not asked for', () => {
  it('two snapshots of an unchanged world are equal', () => {
    // Not an identity check — a fresh array per frame is fine and expected. This
    // pins that the layer is a pure READ: taking a snapshot must not advance,
    // mutate or otherwise disturb the session it is looking at.
    const s = engaged()
    const first = debugSnapshot(s, ALL)
    const second = debugSnapshot(s, ALL)
    expect(second).toEqual(first)
  })

  it('and the session is untouched by having been looked at', () => {
    const s = engaged()
    const tick = s.world.tickCount
    const positions = s.world.entities.map((e) => `${String(e.id)}:${String(e.x)}:${String(e.z)}`)
    debugSnapshot(s, ALL)
    expect(s.world.tickCount).toBe(tick)
    expect(s.world.entities.map((e) => `${String(e.id)}:${String(e.x)}:${String(e.z)}`)).toEqual(
      positions,
    )
  })
})

describe('the hotkey lookup actually resolves', () => {
  /**
   * `layerForHotkey`'s ENTIRE BODY could be replaced with `return undefined` —
   * no hotkey toggling anything at all — and the suite above stayed green. The
   * registry cases assert the table is internally consistent (distinct ids,
   * distinct keys, non-empty labels) and never that the lookup reads it.
   *
   * That is the acceptance criterion "each layer toggles independently by
   * hotkey, and the legend on screen matches the keys that work" going entirely
   * unverified, on a tool whose only controls ARE the hotkeys.
   */
  it('every layer is reachable by its own key', () => {
    for (const layer of DEBUG_LAYERS) {
      expect({ key: layer.hotkey, resolved: layerForHotkey(layer.hotkey)?.id }).toEqual({
        key: layer.hotkey,
        resolved: layer.id,
      })
    }
  })

  it('a key that toggles nothing resolves to nothing', () => {
    // The other direction: a lookup that returned the first layer for anything
    // would pass the case above and make every keystroke toggle the nav grid.
    for (const key of ['9', '0', '', 'a', 'Escape']) {
      expect({ key, resolved: layerForHotkey(key) }).toEqual({ key, resolved: undefined })
    }
  })
})

describe('an enemy that has lost sight draws no ray', () => {
  /**
   * `AiSystem.targetOf` is gated on `state === 'engage'`, and REMOVING THAT GATE
   * left all 1053 tests passing. It matters: a unit that loses sight goes to
   * `pursue` while still remembering the id it was shooting at, so an ungated
   * `targetOf` hands the overlay a live target and the overlay draws a sightline
   * THROUGH THE WALL the man has just ducked behind.
   *
   * That is the worst thing a debug tool can do — not fail, but confidently
   * assert something false about the system it exists to explain. Somebody would
   * go looking for a bug in `hasLineOfSight` that was never there.
   */
  const behindAWall = () => {
    // A full-height wall at x=10. The enemy engages across open ground first,
    // then the target is moved behind it.
    const blocked = new Set<string>()
    for (let y = 0; y < 15; y += 1) blocked.add(`10,${y}`)
    const level = makeLevel({ avatars: [], enemies: [{ x: 13, y: 7 }], blocked })
    const s = createSession(level)
    const near = tileToWorld(15, 7, level.size)
    const hero = s.world.spawn({
      kind: 'rifleman',
      team: 'player',
      x: near.x,
      z: near.z,
      health: 10_000,
    })
    for (let f = 0; f < 30; f += 1) s.advance(1 / 60)
    return { s, hero, level }
  }

  it('was engaging before sight was broken', () => {
    // The premise, stated on its own so a setup that stopped producing an
    // engagement could not make the assertions below vacuous.
    const { s } = behindAWall()
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    expect(s.ai.stateOf(enemy)).toBe('engage')
    expect(debugSnapshot(s, ['losRays']).losRays).toHaveLength(1)
  })

  it('reports no target once it is pursuing', () => {
    const { s, hero, level } = behindAWall()
    const away = tileToWorld(3, 7, level.size)
    s.world.get(hero.id)!.x = away.x
    s.world.get(hero.id)!.z = away.z
    for (let f = 0; f < 4; f += 1) s.advance(1 / 60)
    const enemy = s.world.entities.find((e) => e.team === 'enemy')!.id
    expect(s.ai.stateOf(enemy)).toBe('pursue')
    expect(s.ai.targetOf(enemy)).toBeUndefined()
  })

  it('and draws no ray', () => {
    const { s, hero, level } = behindAWall()
    const away = tileToWorld(3, 7, level.size)
    s.world.get(hero.id)!.x = away.x
    s.world.get(hero.id)!.z = away.z
    for (let f = 0; f < 4; f += 1) s.advance(1 / 60)
    expect(debugSnapshot(s, ['losRays']).losRays).toEqual([])
  })
})

describe('one field per destination, not one per man', () => {
  /**
   * The flow-field layer's central claim, and it was untested because every case
   * above overrides the fixture down to a SINGLE avatar. Removing the dedupe —
   * a Dijkstra sweep per unit rather than per distinct destination — passed all
   * 1053 tests, and costs 11x on a full squad: measured at 0.177 ms/frame
   * against 2.007 ms, every frame, on the machine that is already struggling
   * enough for somebody to have opened the overlay.
   */
  const marching = (avatars: readonly { x: number; y: number }[], target: { x: number; y: number }) => {
    const s = createSession(makeLevel({ avatars, enemies: [] }))
    s.queue.push({ type: 'move', unitIds: [...s.selection()], target })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    return debugSnapshot(s, ['flowField']).flowField
  }

  it('four men under one order produce one field, not four', () => {
    const one = marching([{ x: 3, y: 7 }], { x: 17, y: 7 })
    const four = marching(
      [
        { x: 3, y: 5 },
        { x: 3, y: 6 },
        { x: 3, y: 7 },
        { x: 3, y: 8 },
      ],
      { x: 17, y: 7 },
    )
    expect(one.length).toBeGreaterThan(0)
    expect(four.length).toBe(one.length)
  })

  it('and no tile is drawn twice for the same destination', () => {
    const four = marching(
      [
        { x: 3, y: 5 },
        { x: 3, y: 6 },
        { x: 3, y: 7 },
        { x: 3, y: 8 },
      ],
      { x: 17, y: 7 },
    )
    const keys = four.map((a) => `${String(a.x)},${String(a.y)}:${String(a.targetX)},${String(a.targetY)}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('but two destinations really are two fields', () => {
    // The other direction. A dedupe keyed on something too coarse — the fact of
    // being under orders at all, say — would collapse these into one and hide
    // half the squad's pathing.
    const s = createSession(
      makeLevel({
        avatars: [
          { x: 3, y: 5 },
          { x: 3, y: 9 },
        ],
        enemies: [],
      }),
    )
    const ids = [...s.selection()]
    s.queue.push({ type: 'move', unitIds: [ids[0]!], target: { x: 17, y: 3 } })
    s.queue.push({ type: 'move', unitIds: [ids[1]!], target: { x: 17, y: 12 } })
    for (let f = 0; f < 10; f += 1) s.advance(1 / 60)
    const arrows = debugSnapshot(s, ['flowField']).flowField
    const targets = new Set(arrows.map((a) => `${String(a.targetX)},${String(a.targetY)}`))
    expect(targets).toEqual(new Set(['17,3', '17,12']))
  })
})

describe('a switched-off layer is not computed, not merely not drawn', () => {
  /**
   * The `describe` above titled "nothing is computed for a layer that is
   * switched off" asserts only that the output arrays are EMPTY, which is "not
   * drawn". Computing all five eagerly and discarding four passed it.
   *
   * The difference is the whole reason the layers are opt-in: the nav grid is
   * `O(w*h)` and the flow field is a Dijkstra sweep, and an overlay that pays
   * for both while showing neither is a tool that slows down the thing it is
   * measuring. So this counts the WORK rather than the output.
   */
  const countingSession = () => {
    const s = engaged()
    let passableCalls = 0
    let targetOfCalls = 0
    const spy = {
      ...s,
      grid: new Proxy(s.grid, {
        get(target, prop, receiver): unknown {
          if (prop === 'passable') {
            return (...args: [number, number, number]) => {
              passableCalls += 1
              return target.passable(...args)
            }
          }
          return Reflect.get(target, prop, receiver) as unknown
        },
      }),
      squad: Object.assign(
        (...args: Parameters<typeof s.squad>) => s.squad(...args),
        {
          order: s.squad.order.bind(s.squad),
          halt: s.squad.halt.bind(s.squad),
          leaderOf: s.squad.leaderOf.bind(s.squad),
          targetOf: (id: number) => {
            targetOfCalls += 1
            return s.squad.targetOf(id)
          },
          get detachmentCount(): number {
            return s.squad.detachmentCount
          },
        },
      ) as typeof s.squad,
    } as typeof s
    return { spy, counts: () => ({ passableCalls, targetOfCalls }) }
  }

  it('does not walk the grid when the nav layer is off', () => {
    const { spy, counts } = countingSession()
    debugSnapshot(spy, ['ai', 'entityIds', 'losRays'])
    expect(counts().passableCalls).toBe(0)
  })

  it('does walk it when the nav layer is on — so the counter is live', () => {
    const { spy, counts } = countingSession()
    debugSnapshot(spy, ['navGrid'])
    expect(counts().passableCalls).toBeGreaterThan(0)
  })

  it('does not ask who is marching when the flow layer is off', () => {
    const { spy, counts } = countingSession()
    debugSnapshot(spy, ['navGrid'])
    expect(counts().targetOfCalls).toBe(0)
  })

  it('does ask when it is on', () => {
    const { spy, counts } = countingSession()
    debugSnapshot(spy, ['flowField'])
    expect(counts().targetOfCalls).toBeGreaterThan(0)
  })
})

describe('the empty snapshot is fresh every time', () => {
  it('two empty snapshots do not share their arrays', () => {
    // A module-level shared constant would pass every structural `toEqual` in
    // this file and alias two frames' worth of overlay state together.
    const a = emptySnapshot()
    const b = emptySnapshot()
    expect(a.navGrid).not.toBe(b.navGrid)
    expect(a.losRays).not.toBe(b.losRays)
  })

  it('and neither do two snapshots of a live session', () => {
    const s = engaged()
    expect(debugSnapshot(s, []).ai).not.toBe(debugSnapshot(s, []).ai)
  })
})
