import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Ticket 078 — no mission ends while a killable enemy is standing, and none
 * asks for a kill it cannot get.
 *
 * THE BUG THIS EXISTS TO CATCH SHIPPED, AND WAS FOUND BY PLAYING. Level 3
 * carried `kill_count: 11` against fourteen enemies, so MISSION COMPLETE fired
 * with three of them alive — reported from the bottom-left corner of the map,
 * one soldier shot and his neighbour left on his feet.
 *
 * IT WAS NOT WRONG WHEN IT WAS WRITTEN, which is the whole reason this file is
 * a sweep over every level rather than a fix to one. Ticket 070 measured sixteen
 * enemies, five of them on canopy `los.ts` refuses to fire into, and wrote 11 so
 * the level could be finished. Then the map was repainted — fourteen enemies,
 * all on open ground — and the generated document was rebuilt from it while the
 * hand-written number in the legend stayed behind. A count derived from an image
 * cannot be trusted to notice when the image changes; an invariant can.
 *
 * READ OFF THE SHIPPED DOCUMENTS, not off the source art. These are the files
 * the game actually loads, so this fails on what a player would meet rather than
 * on what the importer would produce if somebody ran it.
 */

interface Spawn {
  readonly x: number
  readonly y: number
}
interface Objective {
  readonly type: string
  readonly count?: number
}
interface Level {
  readonly name: string
  readonly spawns: { readonly enemies: readonly Spawn[] }
  readonly objectives: readonly Objective[]
  readonly walkable: readonly (readonly boolean[])[]
}

const GENERATED = new URL('../../../public/generated/levels/', import.meta.url)

const manifest = JSON.parse(
  readFileSync(new URL('levels.manifest.json', GENERATED), 'utf8'),
) as { levels: readonly string[] }

const levels: readonly (readonly [string, Level])[] = manifest.levels.map((name) => [
  name,
  JSON.parse(readFileSync(new URL(`${name}.json`, GENERATED), 'utf8')) as Level,
])

/**
 * An enemy a squad can actually kill.
 *
 * WALKABILITY IS THE TEST BECAUSE `los.ts` REFUSES A TARGET ON AN IMPASSABLE
 * TILE — it opens by returning false for any shot into blocked ground, so a man
 * standing inside a canopy block cannot be hit from anywhere, at any range, with
 * any weapon. He is scenery that shoots back.
 */
const killable = (level: Level): readonly Spawn[] =>
  level.spawns.enemies.filter((e) => level.walkable[e.y]?.[e.x] === true)

describe('the campaign has levels to check', () => {
  it('and this file is reading them', () => {
    // Non-vacuity. Every sweep below passes trivially over an empty list, which
    // is how a test like this rots the day the manifest path moves.
    expect(levels.length).toBeGreaterThan(0)
    for (const [name, level] of levels) {
      expect({ name, enemies: level.spawns.enemies.length > 0 }).toEqual({ name, enemies: true })
      expect({ name, objectives: level.objectives.length > 0 }).toEqual({ name, objectives: true })
    }
  })
})

describe('no mission is won while a killable enemy is alive', () => {
  it('a kill_count asks for every enemy that can be killed', () => {
    /**
     * THE EXACT FAILURE THAT SHIPPED. Eleven against fourteen killable men ends
     * the mission three deaths early, and the player watches a survivor stand
     * there while the game congratulates him. Asking for FEWER than the killable
     * count is the bug; asking for more would be unwinnable and is caught by the
     * next case.
     */
    for (const [name, level] of levels) {
      for (const objective of level.objectives) {
        if (objective.type !== 'kill_count') continue
        expect({ name, asked: objective.count, killable: killable(level).length }).toEqual({
          name,
          asked: killable(level).length,
          killable: killable(level).length,
        })
      }
    }
  })

  it('and a kill_all can actually be finished', () => {
    /**
     * THE OTHER DIRECTION, AND IT IS NOT HYPOTHETICAL: the sixteen-enemy version
     * of level 3 had five men on canopy, which is why it could not use `kill_all`
     * and why the count was invented in the first place. A repaint that strands
     * one enemy turns a `kill_all` level into a mission nobody can complete —
     * and it would ship, because everything else about the level is fine.
     */
    for (const [name, level] of levels) {
      if (!level.objectives.some((o) => o.type === 'kill_all')) continue
      const stranded = level.spawns.enemies.filter((e) => level.walkable[e.y]?.[e.x] !== true)
      expect({ name, stranded: stranded.map((e) => `${String(e.x)},${String(e.y)}`) }).toEqual({
        name,
        stranded: [],
      })
    }
  })
})

describe('and level 3 in particular, which is where this was found', () => {
  const level3 = levels.find(([name]) => name === 'level3')?.[1]

  it('asks for all of them, not a number somebody typed', () => {
    /**
     * NAMED RATHER THAN LEFT TO THE SWEEP. The sweep above would go on passing if
     * level 3 were dropped from the manifest, or if its objective became a
     * `kill_count` that happened to match — and this is the level the bug was
     * reported on.
     */
    expect(level3?.objectives).toEqual([{ type: 'kill_all' }])
  })

  it('and every man on it can be reached', () => {
    expect(level3).toBeDefined()
    expect(killable(level3 as Level).length).toBe(level3?.spawns.enemies.length)
    // The pair in the bottom-left corner the miscount was noticed on.
    const tiles = level3?.spawns.enemies.map((e) => `${String(e.x)},${String(e.y)}`) ?? []
    expect(tiles).toContain('6,65')
    expect(tiles).toContain('8,66')
  })
})
