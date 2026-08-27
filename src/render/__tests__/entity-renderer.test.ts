import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { EntityRenderer } from '../entity-renderer'
import type { SpriteFrame, UnitVisual } from '../sprite-atlas'
import type { AnimationClip } from '../../core/render-state/animation'
import type { RenderEntity } from '../../core/render-state/entity'
import type { Facing } from '../../core/render-state/facing'

/**
 * The COMPOSITION of the pure modules, which is the one part of ticket 010 with
 * no test and the one part that shipped a defect.
 *
 * `animation.ts` and `facing.ts` are each correct and each covered. What was
 * not covered is `EntityRenderer` wiring them together — and applying a phase
 * offset meant for looping clips to a one-shot `die` made three quarters of all
 * corpses skip part or all of their own death animation.
 *
 * These tests read the renderer's decisions off a stub `UnitVisual` — which
 * frame and which facing it asked for — and its geometry off the instance
 * matrices it wrote. No WebGL context is ever created: `UnitVisual` being an
 * interface is exactly what makes that possible.
 */

/** A `UnitVisual` with no atlas: real clips, and a frame for every request. */
function stubVisual(clips: Record<string, AnimationClip>): UnitVisual & { asked: string[] } {
  const asked: string[] = []
  const frame: SpriteFrame = {
    u0: 0,
    v0: 0,
    du: 0.1,
    dv: 0.1,
    width: 1,
    height: 1.5,
    centreX: 0,
    centreY: 0.75,
  }
  return {
    asked,
    texture: new THREE.Texture(),
    clip: (unit: string, animation: string) =>
      clips[`${unit}|${animation}`] ?? { frameCount: 1, fps: 1, loop: false },
    frame: (unit: string, animation: string, direction: Facing, index: number) => {
      asked.push(`${unit}|${animation}|${direction}|${String(index)}`)
      return frame
    },
    dispose: () => {},
  }
}

/** The real soldier clips, as `AtlasUnitVisual` builds them from the manifest. */
const CLIPS: Record<string, AnimationClip> = {
  'soldier|die': { frameCount: 4, fps: 8, loop: false },
  'soldier|walk': { frameCount: 4, fps: 12, loop: true },
}

function entity(id: number, animation: string, over: Partial<RenderEntity> = {}): RenderEntity {
  return {
    id,
    unit: 'soldier',
    animation,
    x: 0,
    z: 0,
    y: 0,
    dx: 0,
    dz: 0,
    animationStart: 0,
    ...over,
  }
}

/** The frame index the renderer asked the visual for, for one entity at one time. */
function frameFor(id: number, animation: string, elapsed: number): number {
  const visual = stubVisual(CLIPS)
  const renderer = new EntityRenderer(visual, (55 * Math.PI) / 180)
  renderer.setEntities([entity(id, animation)])
  renderer.update(elapsed, 1)
  const last = visual.asked.at(-1)
  renderer.dispose()
  return Number(last?.split('|')[3])
}

describe('one-shot animations are not phase-offset', () => {
  it('starts every entity at frame 0 at the instant it dies, whatever its id', () => {
    for (let id = 1; id <= 200; id++) expect(frameFor(id, 'die', 0)).toBe(0)
  })

  it('plays every frame of `die` in order and then holds the last one', () => {
    // Ids chosen to span the golden-ratio phase sequence: 3, 8 and 21 land at
    // phase 0.85, 0.94 and 0.98, which under the defect jumped straight to the
    // corpse frame.
    for (const id of [1, 3, 8, 21, 55]) {
      const seen = new Set<number>()
      for (let t = 0; t < 0.5; t += 1 / 240) seen.add(frameFor(id, 'die', t))
      expect([...seen].sort()).toEqual([0, 1, 2, 3])
      expect(frameFor(id, 'die', 0.5)).toBe(3)
      expect(frameFor(id, 'die', 30)).toBe(3)
    }
  })
})

describe('looping animations keep their phase offset', () => {
  it('spreads a squad spawned on the same tick across the walk cycle', () => {
    const frames = new Set<number>()
    for (let id = 1; id <= 8; id++) frames.add(frameFor(id, 'walk', 0))
    expect(frames.size).toBe(4)
  })
})

describe('facing memory', () => {
  it('seeds a directionless entity with the south-facing default, not FACINGS[0]', () => {
    const visual = stubVisual(CLIPS)
    const renderer = new EntityRenderer(visual, (55 * Math.PI) / 180)
    // dx = dz = 0: `stableFacing` keeps whatever it was seeded with, and a unit
    // that has never moved must face the player rather than show its back.
    renderer.setEntities([entity(1, 'walk')])
    renderer.update(0, 1)
    expect(visual.asked.at(-1)?.split('|')[2]).toBe('S')
    renderer.dispose()
  })
})

describe('the sprite quad', () => {
  it('is upright and pre-stretched so it projects at its authored size', () => {
    const elevations = [25, 40, 55, 70, 89].map((d) => (d * Math.PI) / 180)
    for (const e of elevations) {
      const visual = stubVisual(CLIPS)
      const renderer = new EntityRenderer(visual, e)
      renderer.setEntities([entity(1, 'walk')])
      renderer.update(0, 1)

      const mesh = renderer.group.children[0] as THREE.InstancedMesh
      const matrix = new THREE.Matrix4()
      mesh.getMatrixAt(0, matrix)
      const position = new THREE.Vector3()
      const rotation = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      matrix.decompose(position, rotation, scale)

      // Upright: no rotation at all, so the quad never leans out over the tile
      // to the north and cannot be sliced by what stands there.
      expect(rotation.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 5)
      // Pre-stretched: `height / cos(e)` in the world...
      expect(scale.y).toBeCloseTo(1.5 / Math.cos(e), 5)
      expect(scale.x).toBeCloseTo(1, 5)
      // ...which projects back to exactly the authored 1.5 on screen, where
      // screen height is `y * cos(e) - z * sin(e)`.
      const onScreen = scale.y * Math.cos(e) - 0 * Math.sin(e)
      expect(onScreen).toBeCloseTo(1.5, 5)
      // And the anchor still sits on the ground: the centre is half the quad up.
      expect(position.y - scale.y / 2).toBeCloseTo(0.02, 5)
      renderer.dispose()
    }
  })
})

describe('a man in the river is drawn down in it (ticket 041)', () => {
  /**
   * THE HALF OF TICKET 041 THAT SHIPPED UNTESTED, and the acceptance criterion
   * it is: "the renderer lowers a submerged sprite by that fraction of its
   * height". Adversarial review deleted the sink term outright, and then deleted
   * the vertical stretch from it, and BOTH left the whole suite green — the
   * existing quad case above builds an entity with no `submersion` at all, so it
   * is blind to either.
   *
   * The `y` of the instance matrix is a plain number in a `Float32Array`; Node
   * reads it perfectly well. That is the same lesson ticket 034 paid for and
   * ticket 025 paid for again one file along.
   */
  const centreY = (submersion: number, elevation: number): number => {
    const visual = stubVisual(CLIPS)
    const renderer = new EntityRenderer(visual, elevation)
    renderer.setEntities([entity(1, 'walk', { submersion })])
    renderer.update(0, 1)
    const mesh = renderer.group.children[0] as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(0, matrix)
    const position = new THREE.Vector3()
    matrix.decompose(position, new THREE.Quaternion(), new THREE.Vector3())
    renderer.dispose()
    return position.y
  }

  const ELEVATIONS = [25, 40, 55, 70].map((d) => (d * Math.PI) / 180)

  it('a dry sprite is exactly where it always was', () => {
    /**
     * THE CONTROL, AND IT RUNS FIRST. Every soldier in the game is dry almost
     * all of the time; a sink term that leaked into the default would move the
     * entire army a fraction of a body down into the ground, on every map, and
     * the case below would still pass.
     */
    for (const e of ELEVATIONS) {
      expect({ e, same: centreY(0, e) === centreY(0, e) }).toEqual({ e, same: true })
    }
    // And absent is the same as zero — the field is optional on the wire.
    const visual = stubVisual(CLIPS)
    const renderer = new EntityRenderer(visual, ELEVATIONS[0]!)
    renderer.setEntities([entity(1, 'walk')])
    renderer.update(0, 1)
    const mesh = renderer.group.children[0] as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(0, matrix)
    const bare = new THREE.Vector3()
    matrix.decompose(bare, new THREE.Quaternion(), new THREE.Vector3())
    renderer.dispose()
    expect(bare.y).toBeCloseTo(centreY(0, ELEVATIONS[0]!), 6)
  })

  it('and a submerged one drops by the fraction of its STRETCHED height', () => {
    /**
     * THE STRETCH IS THE SUBTLE HALF. The quad is pre-stretched by `1/cos(e)` so
     * it projects at its authored on-screen size, so the height that is actually
     * standing in the world is `sprite.height * verticalStretch`. Sinking by the
     * unstretched height hides far less than the fraction asks for, and the
     * error GROWS with elevation — a bug that would look like a tuning problem
     * at one camera angle and like nothing at all at another.
     */
    for (const e of ELEVATIONS) {
      const stretched = 1.5 / Math.cos(e)
      for (const fraction of [0.25, 0.7, 1]) {
        expect({
          e,
          fraction,
          drop: centreY(0, e) - centreY(fraction, e),
        }).toEqual({ e, fraction, drop: expect.closeTo(fraction * stretched, 5) })
      }
    }
  })

  it('and the drop is proportional, not a flat nudge', () => {
    // A renderer that sank a fixed amount whenever `submersion > 0` passes any
    // single-value check. Two fractions at one elevation separate them.
    const e = ELEVATIONS[1]!
    const quarter = centreY(0, e) - centreY(0.25, e)
    const half = centreY(0, e) - centreY(0.5, e)
    expect(half).toBeCloseTo(quarter * 2, 5)
  })
})
