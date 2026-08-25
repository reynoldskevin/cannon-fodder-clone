import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { PointerController } from '../pointer-controller'
import { createCommandQueue } from '../../core/command'
import type { Command } from '../../core/command'

/**
 * Ticket 008 — pointer to command.
 *
 * NO DOM, ON PURPOSE. `vitest.config.ts` sets `environment: 'node'`, and this
 * ticket is not the place to take on jsdom: what needs testing is the maths and
 * the button mapping, and both are pure. So the controller is handed a minimal
 * listener host and plain event objects rather than real `PointerEvent`s. That
 * is a constraint on the controller's design too, and a good one — a class that
 * can only be exercised through a real browser event is a class nobody tests.
 *
 * Three.js is imported here freely: `src/input/` is a sibling layer of
 * `src/render/`, not part of `src/core/`, so the engine-free rule does not apply.
 * What DOES apply is that this file may reach into `core/` only for the command
 * types and the queue — asserted separately in `layering.test.ts`.
 */

/** The slice of an element the controller is allowed to need. */
class FakeHost {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readonly clientWidth = 800
  readonly clientHeight = 600

  addEventListener(type: string, handler: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }
  }

  /** How many handlers are registered in total — for the dispose assertions. */
  get handlerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }

  fire(type: string, event: Record<string, unknown>): void {
    const full = { type, preventDefault: () => {}, ...event }
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(full)
  }
}

/**
 * A camera looking straight down at the origin.
 *
 * Straight down rather than the game's 55° so the expected ground point is
 * arithmetic anyone can check by hand: with an orthographic camera of width
 * `w` and height `h`, screen centre is world origin and the edges are ±w/2,
 * ±h/2. The 55° rig is exercised by the game itself; what is being tested here
 * is that the controller raycasts at all and converts what it hits.
 */
function overheadCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-10, 10, 7.5, -7.5, 0.1, 100)
  camera.position.set(0, 50, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return camera
}

interface Fixture {
  readonly host: FakeHost
  readonly controller: PointerController
  readonly drain: () => readonly Command[]
}

function fixture(size = { w: 20, h: 15 }): Fixture {
  const host = new FakeHost()
  const queue = createCommandQueue()
  const controller = new PointerController(
    host as unknown as HTMLElement,
    overheadCamera(),
    queue,
    size,
  )
  return { host, controller, drain: () => queue.drain() }
}

/** A pointer event at the centre of the 800x600 host. */
const centre = (button: number): Record<string, unknown> => ({
  button,
  clientX: 400,
  clientY: 300,
})

describe('PointerController — button mapping', () => {
  it('issues a move on the left button', () => {
    const f = fixture()
    f.host.fire('pointerdown', centre(0))
    const commands = f.drain()
    expect(commands).toHaveLength(1)
    expect(commands[0]!.type).toBe('move')
  })

  it('issues a fire on the right button', () => {
    const f = fixture()
    f.host.fire('pointerdown', centre(2))
    const commands = f.drain()
    expect(commands).toHaveLength(1)
    expect(commands[0]!.type).toBe('fire')
  })

  it('ignores the middle button', () => {
    const f = fixture()
    f.host.fire('pointerdown', centre(1))
    expect(f.drain()).toEqual([])
  })
})

describe('PointerController — screen to tile', () => {
  it('maps the centre of the viewport to the centre tile', () => {
    // 20x15 tiles, camera centred on the world origin looking straight down:
    // the middle of the screen is the middle of the map.
    const f = fixture({ w: 20, h: 15 })
    f.host.fire('pointerdown', centre(0))
    const command = f.drain()[0]!
    expect(command.type).toBe('move')
    if (command.type !== 'move') return
    expect(command.target).toEqual({ x: 10, y: 7 })
  })

  it('maps a click left of centre to a lower tile x', () => {
    const f = fixture()
    f.host.fire('pointerdown', { button: 0, clientX: 100, clientY: 300 })
    const command = f.drain()[0]!
    if (command.type !== 'move') throw new Error('expected a move')
    expect(command.target.x).toBeLessThan(10)
  })

  it('maps a click above centre to a lower tile y', () => {
    // Screen y grows downward; -z is north, which is the top of the screen.
    const f = fixture()
    f.host.fire('pointerdown', { button: 0, clientX: 400, clientY: 60 })
    const command = f.drain()[0]!
    if (command.type !== 'move') throw new Error('expected a move')
    expect(command.target.y).toBeLessThan(7)
  })

  it('produces integer tile coordinates', () => {
    const f = fixture()
    for (const [x, y] of [
      [123, 77],
      [401, 299],
      [700, 500],
    ]) {
      f.host.fire('pointerdown', { button: 0, clientX: x, clientY: y })
    }
    for (const command of f.drain()) {
      if (command.type !== 'move') continue
      expect(Number.isInteger(command.target.x)).toBe(true)
      expect(Number.isInteger(command.target.y)).toBe(true)
    }
  })
})

describe('PointerController — clicks that are not orders', () => {
  it('produces nothing when the ray misses the ground plane', () => {
    // A camera tilted to look at the horizon: the ray through the top of the
    // screen never meets y = 0. Nothing must be queued — not a clamped target,
    // not a target at infinity.
    const host = new FakeHost()
    const queue = createCommandQueue()
    const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000)
    camera.position.set(0, 1, 0)
    camera.lookAt(0, 1, -10) // dead level with the ground plane
    camera.updateMatrixWorld(true)
    const controller = new PointerController(
      host as unknown as HTMLElement,
      camera,
      queue,
      { w: 20, h: 15 },
    )
    host.fire('pointerdown', { button: 0, clientX: 400, clientY: 10 })
    expect(queue.drain()).toEqual([])
    controller.dispose()
  })

  it('produces nothing for a click that lands off the map', () => {
    // The camera sees more world than the map covers. A click on the grass
    // beyond the edge is not an order, and must not be clamped into one.
    const f = fixture({ w: 4, h: 3 })
    f.host.fire('pointerdown', { button: 0, clientX: 795, clientY: 300 })
    expect(f.drain()).toEqual([])
  })
})

describe('PointerController — lifecycle', () => {
  it('registers listeners on construction', () => {
    const f = fixture()
    expect(f.host.handlerCount).toBeGreaterThan(0)
  })

  it('removes every listener on dispose', () => {
    const f = fixture()
    f.controller.dispose()
    expect(f.host.handlerCount).toBe(0)
  })

  it('pushes nothing after dispose', () => {
    // Ticket 020 loads a second level into the same page. A leaked controller
    // would keep queueing orders into a dead world.
    const f = fixture()
    f.controller.dispose()
    f.host.fire('pointerdown', centre(0))
    expect(f.drain()).toEqual([])
  })

  it('tolerates being disposed twice', () => {
    const f = fixture()
    f.controller.dispose()
    expect(() => {
      f.controller.dispose()
    }).not.toThrow()
  })
})
