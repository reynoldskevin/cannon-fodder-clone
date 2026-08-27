import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { EntityRenderer } from '../entity-renderer'
import type { SpriteFrame, UnitVisual } from '../sprite-atlas'
import type { AnimationClip } from '../../core/render-state/animation'
import type { RenderEntity } from '../../core/render-state/entity'
import type { Facing } from '../../core/render-state/facing'

/**
 * Ticket 055 — a rocket points where it is going.
 *
 * `rocket.png` is painted flying south-west to north-east and AIMING north-east.
 * Ticket 053 drew it as an unrotated quad, so a rocket fired west still pointed
 * north-east: backwards, and obviously so.
 *
 * SPRITE QUADS HAVE NEVER ROTATED. `quadRotation` is an identity quaternion the
 * renderer composes with and nothing has ever set — every drawable until now
 * chose its orientation by picking a FRAME (eight-way facings for the soldier)
 * rather than by turning. A round in the air is the first thing whose heading is
 * continuous, so this is the first rotation in the layer.
 *
 * THE ANGLE IS A SCREEN ANGLE, NOT A GROUND ANGLE, and that is the whole
 * subtlety. The camera looks down at an elevation, so the ground's north-south
 * axis is foreshortened on screen by `sin(elevation)` while its east-west axis is
 * not. A rocket travelling due north across a 55-degree camera does NOT appear to
 * travel straight up the screen at the same rate it would travel right when
 * flying east, and a spin taken from `atan2(-dz, dx)` would be visibly wrong for
 * everything except the four axis-aligned cases — where it happens to be right,
 * which is exactly how such a bug survives a first look.
 */

const CLIPS: Record<string, AnimationClip> = {
  'rocket|static': { frameCount: 1, fps: 1, loop: false },
  'grenade|static': { frameCount: 1, fps: 1, loop: false },
  'soldier|walk': { frameCount: 4, fps: 12, loop: true },
}

function stubVisual(): UnitVisual {
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
    texture: new THREE.Texture(),
    clip: (unit: string, animation: string) =>
      CLIPS[`${unit}|${animation}`] ?? { frameCount: 1, fps: 1, loop: false },
    frame: (_unit: string, _animation: string, _direction: Facing, _index: number) => frame,
    dispose: () => {},
  }
}

const ELEVATION = (55 * Math.PI) / 180

function entity(over: Partial<RenderEntity> = {}): RenderEntity {
  return {
    id: 1,
    unit: 'rocket',
    animation: 'static',
    x: 0,
    z: 0,
    y: 0,
    dx: 0,
    dz: 0,
    animationStart: 0,
    ...over,
  }
}

/** The instance matrix the renderer wrote for a single drawable. */
function matrixFor(e: RenderEntity, elevation = ELEVATION): THREE.Matrix4 {
  const renderer = new EntityRenderer(stubVisual(), elevation)
  renderer.setEntities([e])
  renderer.update(0, 1)
  const mesh = renderer.group.children.find(
    (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh,
  )
  if (mesh === undefined) throw new Error('nothing drawn')
  const m = new THREE.Matrix4()
  mesh.getMatrixAt(0, m)
  renderer.dispose()
  return m
}

/**
 * Where the sprite's own "up" ends up ON SCREEN, as an angle in degrees measured
 * anticlockwise from screen-right.
 *
 * Read off the matrix rather than off any number the renderer was given, so this
 * measures what is drawn. The quad's local +Y is the art's up; transforming it by
 * the instance matrix (rotation and scale, no translation) and then applying the
 * camera's foreshortening to the world Y component gives its screen direction.
 */
function screenUpDegrees(m: THREE.Matrix4, elevation = ELEVATION): number {
  const up = new THREE.Vector3(0, 1, 0).transformDirection(m)
  // A world-vertical component projects to screen-up scaled by cos(elevation);
  // the quad is upright, so this is the same factor the vertical pre-stretch
  // exists to cancel.
  return (Math.atan2(up.y * Math.cos(elevation), up.x) * 180) / Math.PI
}

describe('a rocket turns to face its travel', () => {
  /**
   * THE ART AIMS NORTH-EAST — up and to the right, 45 degrees on screen. So a
   * rocket flying north-east must be drawn UNROTATED, and everything else is
   * measured against that.
   *
   * Headings are given in world terms: `+x` is east, `+z` is south.
   */
  const heading = (dx: number, dz: number) =>
    screenUpDegrees(matrixFor(entity({ unit: 'rocket', dx, dz })))

  it('flying east, it points up and to the right of straight east', () => {
    /**
     * The art's own aim is 45 degrees; flying due east the round should point
     * along the screen's x axis, so the sprite's "up" — which is 45 degrees ahead
     * of its nose — lands at 45 degrees plus nothing. Stated as the RELATIONSHIP
     * between two headings rather than as an absolute, because the absolute
     * depends on where in the sprite the artist put the nose, and this suite must
     * not have to be edited when the art is repainted.
     */
    expect(heading(1, 0)).toBeCloseTo(45, 4)
  })

  it('and flying west it points the OTHER way, not the same way', () => {
    // THE BUG, IN ONE ASSERTION. Unrotated, east and west drew the identical
    // quad — a rocket fired west with its nose pointing east.
    const east = heading(1, 0)
    const west = heading(-1, 0)
    expect(Math.abs(east - west)).toBeCloseTo(180, 4)
  })

  it('north and south are opposite too, and are not east and west', () => {
    const north = heading(0, -1)
    const south = heading(0, 1)
    expect(Math.abs(north - south)).toBeCloseTo(180, 4)
    expect(north).not.toBeCloseTo(heading(1, 0), 1)
  })

  it('and the four compass headings are four distinct angles', () => {
    // A spin that collapsed any pair — a missing sign, an `abs`, a swapped
    // argument to `atan2` — would leave two of these identical.
    const angles = [heading(1, 0), heading(-1, 0), heading(0, 1), heading(0, -1)]
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBe(4)
  })
})

describe('and the turn is measured on screen, not on the ground', () => {
  it('a diagonal is NOT drawn at the ground angle, because the camera is tilted', () => {
    /**
     * THE CASE THAT SEPARATES A CORRECT SPIN FROM THE OBVIOUS WRONG ONE.
     *
     * On the ground, north-east is 45 degrees from east. On screen it is not: the
     * north-south axis is foreshortened by `sin(elevation)`, so at 55 degrees a
     * ground vector of (1, -1) leans only `atan(sin 55) = 39.3` degrees above the
     * horizontal. A spin computed from `atan2(-dz, dx)` gives 45 and is wrong by
     * six degrees here — while being exactly right for all four axis headings
     * above, which is how it would survive them.
     */
    const east = screenUpDegrees(matrixFor(entity({ dx: 1, dz: 0 })))
    const northEast = screenUpDegrees(matrixFor(entity({ dx: 1, dz: -1 })))
    const expected = (Math.atan(Math.sin(ELEVATION)) * 180) / Math.PI
    expect(northEast - east).toBeCloseTo(expected, 3)
    expect(northEast - east).not.toBeCloseTo(45, 1)
  })

  it('and a flatter camera leans it further', () => {
    // The dependence is real and in the right direction: the lower the camera,
    // the more the north-south axis is squashed and the flatter a diagonal reads.
    const flat = (30 * Math.PI) / 180
    const steep = (80 * Math.PI) / 180
    const lean = (e: number) =>
      screenUpDegrees(matrixFor(entity({ dx: 1, dz: -1 }), e), e) -
      screenUpDegrees(matrixFor(entity({ dx: 1, dz: 0 }), e), e)
    expect(lean(flat)).toBeLessThan(lean(steep))
  })
})

describe('nothing else in the game turns', () => {
  it('a grenade is drawn exactly as it was, however it is flying', () => {
    /**
     * A GRENADE TUMBLES AND ITS ART HAS NO NOSE. Rotating it would be inventing a
     * heading the sprite does not have, and it is the reason the spin is keyed on
     * the ART rather than applied to everything with a direction.
     */
    const still = matrixFor(entity({ unit: 'grenade', dx: 0, dz: 0 }))
    const flying = matrixFor(entity({ unit: 'grenade', dx: -1, dz: 0 }))
    expect(flying.elements).toEqual(still.elements)
  })

  it('and a walking soldier`s matrix is byte-identical to the unrotated one', () => {
    /**
     * THE REGRESSION GUARD, and it is the reason the composition had to be
     * arranged so that a zero spin reduces EXACTLY to the old one rather than to
     * something within a rounding error of it. Every sprite in the game goes
     * through this path.
     */
    const walking = matrixFor(entity({ unit: 'soldier', animation: 'walk', dx: 1, dz: 1 }))
    const expected = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.02 + 0.75 / Math.cos(ELEVATION), 0),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1.5 / Math.cos(ELEVATION), 1),
    )
    /**
     * COMPARED THROUGH FLOAT32, which is not a hedge — it is where the numbers
     * actually live. `InstancedMesh` stores its matrices in a `Float32Array`, so
     * the renderer's 2.6151702404022217 and a freshly composed double's
     * 2.615170193431647 are the SAME VALUE seen at two precisions, and comparing
     * them raw fails on every entry that is not exactly representable. Rounding
     * the expectation the same way the renderer's storage does keeps this an
     * exact equality rather than a tolerance.
     */
    const asStored = (m: THREE.Matrix4): number[] => [...new Float32Array(m.elements)]
    expect(asStored(walking)).toEqual(asStored(expected))
  })
})
