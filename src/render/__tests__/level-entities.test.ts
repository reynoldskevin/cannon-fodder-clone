import { describe, it, expect } from 'vitest'
import { levelRenderEntities } from '../level-entities'
import { PALM_VARIANTS, TREE_VARIANTS } from '../../core/render-state/scenery'
import type { LevelData, SpawnPoint } from '../../core/level'

/**
 * What the map's PROP ANNOTATIONS draw.
 *
 * This mapping had no test, and it is the only place in the build where a
 * hand-placed mark on the source map becomes — or fails to become — something on
 * screen. It has already been wrong twice: ticket 010 drew a palm for `tree` on a
 * map whose real forest was still missing, and the 010a correction then dropped
 * the annotation entirely, which silently discards a thing the map's author
 * deliberately placed. Neither failure moved a test, because there wasn't one.
 *
 * `bird_left` drawing nothing is the deliberate case and is asserted here so it
 * stays deliberate rather than becoming an accident nobody notices.
 */

const flat = (w: number, h: number): readonly (readonly number[])[] =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => 0))

function level(props: readonly SpawnPoint[]): LevelData {
  return {
    schemaVersion: 2,
    name: 'test',
    size: { w: 57, h: 45 },
    terrain: flat(57, 45),
    walkable: Array.from({ length: 45 }, () => Array.from({ length: 57 }, () => true)),
    spawns: { avatars: [], enemies: [], props, chests: [] },
    objectives: [{ type: 'kill_all' }],
  }
}

/** Ground is flat at zero, so every assertion below is about the mapping alone. */
const ground = (): number => 0

const spritesFor = (props: readonly SpawnPoint[]): string[] =>
  levelRenderEntities(level(props), ground).map((e) => e.unit)

describe('prop annotations', () => {
  it('draws a `tree` annotation as one of the palms', () => {
    const [sprite] = spritesFor([{ x: 45, y: 36, type: 'tree' }])
    expect(PALM_VARIANTS).toContain(sprite)
  })

  it('never draws a `tree` annotation with the canopy art', () => {
    // The canopy broadleaves belong to the terrain; an annotation is a landmark.
    // Swapping the pools would still produce a tree-shaped thing on the right
    // tile, so only naming the wrong pool catches it.
    for (let x = 0; x < 40; x++) {
      const [sprite] = spritesFor([{ x, y: 36, type: 'tree' }])
      expect(TREE_VARIANTS).not.toContain(sprite)
    }
  })

  it('gives the same annotation the same palm every time', () => {
    const once = spritesFor([{ x: 45, y: 36, type: 'tree' }])
    const twice = spritesFor([{ x: 45, y: 36, type: 'tree' }])
    expect(once).toEqual(twice)
  })

  it('does not change an annotation`s palm when another prop is added', () => {
    // The palm is chosen from the tile, not from the spawn's index in the list.
    // Choosing by index would repaint existing trees whenever the map author
    // annotates anything new anywhere.
    const alone = spritesFor([{ x: 45, y: 36, type: 'tree' }])
    const crowded = spritesFor([
      { x: 9, y: 36, type: 'shrub' },
      { x: 45, y: 36, type: 'tree' },
      { x: 12, y: 3, type: 'tree' },
    ])
    expect(crowded[1]).toBe(alone[0])
  })

  it('uses more than one palm across differently placed annotations', () => {
    const seen = new Set<string>()
    for (let x = 0; x < 30; x++) seen.add(spritesFor([{ x, y: 36, type: 'tree' }])[0]!)
    expect(seen.size).toBeGreaterThan(1)
  })

  it('draws a `shrub` annotation as the bush', () => {
    expect(spritesFor([{ x: 9, y: 36, type: 'shrub' }])).toEqual(['bush'])
  })

  it('draws nothing for a prop with no art, and burns no id doing it', () => {
    // `bird_left` has no sprite. The entity must be absent, and — because ids
    // drive animation phase and facing hysteresis — the props that DO draw must
    // get the same ids they would have got if the bird were not in the list.
    const withBird = levelRenderEntities(
      level([
        { x: 49, y: 27, type: 'bird_left' },
        { x: 9, y: 36, type: 'shrub' },
      ]),
      ground,
    )
    const without = levelRenderEntities(level([{ x: 9, y: 36, type: 'shrub' }]), ground)
    expect(withBird).toEqual(without)
  })

  it('draws nothing for a prop with no `type` at all', () => {
    expect(spritesFor([{ x: 4, y: 4 }])).toEqual([])
  })
})
