import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAiSystem } from '../index'
import { createSquadSystem } from '../../squad'
import { createCombatSystem } from '../../combat'
import { bakeNavGrid } from '../../pathing/navgrid'
import { World } from '../../world/world'
import { loadLevel } from '../../level'
import { tileToWorld } from '../../view/projection'

/**
 * Ticket 039 — the inward default, against the levels that actually ship.
 *
 * WHY THIS RUNS THE REAL MACHINE rather than recomputing the rule. A test that
 * restated "point at the centre" in its own arithmetic would agree with a
 * production copy of the same mistake, and this project has already shipped that
 * exact tautology once (ticket 034's tint table, which was asserted against the
 * expression production used and stayed green while rendering the map wrong).
 * So every facing below comes out of `AiSystem.facingOf` after a real tick.
 *
 * WHAT IT GUARDS. Ticket 038 gave every enemy a fixed southward default, which
 * left five of level 2's fifteen looking off the bottom of the map — arc wasted,
 * garrison free. The claim here is structural rather than tuned: whatever the
 * map's shape and wherever a man stands on it, his arc points at territory the
 * game can put somebody in.
 */

const LEVELS = ['level1', 'level2'] as const
const DIR = new URL('../../../../public/generated/levels/', import.meta.url).pathname

const load = (name: string) => {
  const raw: unknown = JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'))
  return loadLevel(raw)
}

/** Every enemy's settled default facing, keyed by its spawn index. */
function defaultFacings(name: string): { x: number; y: number; dx: number; dz: number }[] {
  const level = load(name)
  const grid = bakeNavGrid(level)
  const world = new World(level, { seed: 1 })
  const squad = createSquadSystem(grid, {})
  const combat = createCombatSystem(grid, { autoEngageTeams: [] })
  const ai = createAiSystem(grid, { squad, combat })
  world.addSystem(ai)

  const spawned = level.spawns.enemies.map((p) => {
    const at = tileToWorld(p.x, p.y, level.size)
    return { point: p, entity: world.spawn({ kind: 'rifleman', team: 'enemy', x: at.x, z: at.z }) }
  })
  world.tick()

  return spawned.map(({ point, entity }) => {
    const facing = ai.facingOf(entity.id)
    if (facing === undefined) throw new Error(`no facing for enemy at ${point.x},${point.y}`)
    return { x: point.x, y: point.y, dx: facing.dx, dz: facing.dz }
  })
}

describe.each(LEVELS)('%s', (name) => {
  it('spawns enemies at all, which is what stops the rest being vacuous', () => {
    expect(defaultFacings(name).length).toBeGreaterThan(0)
  })

  it('gives every one of them a unit-vector facing', () => {
    for (const man of defaultFacings(name)) {
      expect({
        at: `${man.x},${man.y}`,
        len: Math.hypot(man.dx, man.dz),
      }).toEqual({ at: `${man.x},${man.y}`, len: expect.closeTo(1, 6) })
    }
  })

  it('and points every man at somewhere the game can put somebody', () => {
    /**
     * WAS AN ARC SWEEP, IS NOW A BEARING (ticket 086). Ticket 039's acceptance
     * criterion measured the fraction of a man's 120 degree vision wedge that
     * landed on the map, and required all of it — level 2 had scored 88% under a
     * fixed southward default, five men wasting most of their sight on the void
     * past the bottom edge.
     *
     * There is no wedge to sweep any more: sight is all round, so no facing can
     * waste it. What the inward default still decides is which way a STATIONARY
     * ENEMY IS DRAWN, and a guard drawn staring off the edge of the world looks
     * as wrong as he ever did. So the claim survives, reduced to what it now
     * governs: one tile ahead of where he is looking is still on the map.
     */
    const { size } = load(name)
    for (const man of defaultFacings(name)) {
      const ahead = { x: man.x + man.dx, y: man.y + man.dz }
      expect({
        at: `${man.x},${man.y}`,
        onMap: ahead.x >= 0 && ahead.y >= 0 && ahead.x <= size.w - 1 && ahead.y <= size.h - 1,
      }).toEqual({ at: `${man.x},${man.y}`, onMap: true })
    }
  })

  it('and every man turns toward the side of the middle he is not on', () => {
    /**
     * The property no fixed compass point has, stated per man rather than as a
     * comparison between two of them — level 1 spawns all three of its enemies
     * north of its centre, so there is no southern man to disagree with, and a
     * test written as "the northernmost and southernmost face opposite ways"
     * would be untestable on half the shipped campaign.
     *
     * A man level with the middle on an axis has nothing to prove on it, so
     * those are skipped rather than pinned to a sign that means nothing.
     */
    const { size } = load(name)
    const middle = { x: (size.w - 1) / 2, y: (size.h - 1) / 2 }
    for (const man of defaultFacings(name)) {
      const wantZ = Math.sign(middle.y - man.y)
      const wantX = Math.sign(middle.x - man.x)
      if (Math.abs(middle.y - man.y) > 1) {
        expect({ at: `${man.x},${man.y}`, z: Math.sign(man.dz) }).toEqual({
          at: `${man.x},${man.y}`,
          z: wantZ,
        })
      }
      if (Math.abs(middle.x - man.x) > 1) {
        expect({ at: `${man.x},${man.y}`, x: Math.sign(man.dx) }).toEqual({
          at: `${man.x},${man.y}`,
          x: wantX,
        })
      }
    }
  })
})
