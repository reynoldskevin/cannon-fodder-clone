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
  /** Mutable, so a test can change the selection between clicks. */
  selected: number[]
}

function fixture(size = { w: 20, h: 15 }): Fixture {
  const host = new FakeHost()
  const queue = createCommandQueue()
  const state: { selected: number[] } = { selected: [1, 2, 3] }
  const controller = new PointerController(
    host as unknown as HTMLElement,
    overheadCamera(),
    queue,
    size,
    () => state.selected,
  )
  return {
    host,
    controller,
    drain: () => queue.drain(),
    get selected() {
      return state.selected
    },
    set selected(ids: number[]) {
      state.selected = ids
    },
  }
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

  describe('holding the right button', () => {
    /**
     * FIRE IS A HELD BUTTON, NOT A CLICK. The squad holds fire until ordered and
     * keeps shooting while the order stands, so the control needs both halves:
     * pressing starts, releasing stops. With only the press, right-click becomes
     * a latch — the men start firing and never stop, and there is no way to make
     * them stop short of a reload.
     */
    it('ceases fire when the right button is released', () => {
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointerup', centre(2))
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('ceases fire when the pointer leaves the canvas still held', () => {
      // Otherwise dragging off the canvas mid-burst leaves the squad firing with
      // no button held and no event coming to stop them.
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointerleave', centre(2))
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('ceases fire when the browser cancels the pointer', () => {
      // `pointercancel` is what arrives when the browser takes the pointer away
      // — a touch turning into a scroll gesture, the OS grabbing it. No
      // `pointerup` follows it, so without this the squad fires forever.
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointercancel', centre(2))
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('exposes a cease-fire the caller can drive from window blur', () => {
      // Alt-tabbing away mid-burst delivers no pointer event AT ALL to the
      // canvas, so this one cannot be handled here: only something holding the
      // `window` can hear it. `main.ts` already owns a window listener for
      // resize and is where this belongs — but the controller has to offer the
      // hook, or the squad fires until the player comes back.
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.controller.ceaseFire()
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('does nothing on an explicit cease-fire when not firing', () => {
      const f = fixture()
      f.controller.ceaseFire()
      expect(f.drain()).toEqual([])
    })

    it('re-aims while the button is held', () => {
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointermove', { button: -1, clientX: 100, clientY: 300 })
      const commands = f.drain()
      expect(commands.map((c) => c.type)).toEqual(['fire', 'fire'])
      const first = commands[0]!
      const second = commands[1]!
      if (first.type !== 'fire' || second.type !== 'fire') throw new Error('expected fires')
      expect(second.target.x).toBeLessThan(first.target.x)
    })

    it('issues nothing on a pointer move when the button is NOT held', () => {
      // Every mouse movement across the canvas would otherwise be an order.
      const f = fixture()
      f.host.fire('pointermove', { button: -1, clientX: 100, clientY: 300 })
      expect(f.drain()).toEqual([])
    })

    it('does not repeat the cease-fire on a second release', () => {
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointerup', centre(2))
      f.host.fire('pointerup', centre(2))
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('does not cease fire when the LEFT button is released', () => {
      // Left is move. A left-click during a burst must not stop the shooting.
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointerdown', centre(0))
      f.host.fire('pointerup', centre(0))
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'move'])
    })

    it('does not re-aim after the button is released', () => {
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.host.fire('pointerup', centre(2))
      f.host.fire('pointermove', { button: -1, clientX: 100, clientY: 300 })
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })

    it('ceases fire on dispose while still held', () => {
      // Tearing the level down mid-burst must not leave an order standing in a
      // world that is about to be replaced.
      const f = fixture()
      f.host.fire('pointerdown', centre(2))
      f.controller.dispose()
      expect(f.drain().map((c) => c.type)).toEqual(['fire', 'ceaseFire'])
    })
  })

  it('ignores the middle button', () => {
    const f = fixture()
    f.host.fire('pointerdown', centre(1))
    expect(f.drain()).toEqual([])
  })
})

describe('PointerController — who the order is for', () => {
  /**
   * THE HOLE THIS CLOSES. A first cut of this ticket queued `unitIds: []`,
   * because the controller may not reach into `core/` to find out who is
   * selected. Every command it produced was then refused by `applyCommand` for
   * naming nobody — the tests passed, the types were right, and clicking the
   * ground did precisely nothing. A command that names no units is not a
   * command, so the selection is a constructor argument: whoever builds the
   * controller has to answer "who does this?".
   */
  it('names the selected units in a move', () => {
    const f = fixture()
    f.selected = [7, 8]
    f.host.fire('pointerdown', centre(0))
    const command = f.drain()[0]!
    if (command.type !== 'move') throw new Error('expected a move')
    expect([...command.unitIds]).toEqual([7, 8])
  })

  it('names the selected units in a fire', () => {
    const f = fixture()
    f.selected = [4]
    f.host.fire('pointerdown', centre(2))
    const command = f.drain()[0]!
    if (command.type !== 'fire') throw new Error('expected a fire')
    expect([...command.unitIds]).toEqual([4])
  })

  it('asks for the selection at click time, not at construction', () => {
    // The squad changes as men die and as the player splits it. A selection
    // captured once at construction is the roster from the start of the mission.
    const f = fixture()
    f.selected = [1]
    f.host.fire('pointerdown', centre(0))
    f.selected = [2, 3]
    f.host.fire('pointerdown', centre(0))
    const commands = f.drain()
    expect(commands).toHaveLength(2)
    const ids = commands.map((c) => (c.type === 'move' ? [...c.unitIds] : null))
    expect(ids).toEqual([[1], [2, 3]])
  })

  it('queues nothing when nothing is selected', () => {
    // Not "queue a command naming nobody" — there is no order to give, and a
    // command that will certainly be refused is noise in the queue.
    const f = fixture()
    f.selected = []
    f.host.fire('pointerdown', centre(0))
    f.host.fire('pointerdown', centre(2))
    expect(f.drain()).toEqual([])
  })

  it('copies the selection rather than aliasing it', () => {
    // The provider hands back a live array in the real wiring. A command that
    // holds a reference to it would silently change its own id list when the
    // squad next takes a casualty.
    const f = fixture()
    const live = [5, 6]
    f.selected = live
    f.host.fire('pointerdown', centre(0))
    live.push(99)
    const command = f.drain()[0]!
    if (command.type !== 'move') throw new Error('expected a move')
    expect([...command.unitIds]).toEqual([5, 6])
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

  it('assigns a click past a tile centre to the NEXT tile', () => {
    /**
     * THE DRIFT GUARD for the convention this file duplicates.
     *
     * `pointer-controller.ts` cannot import `core/view/projection` — the layering
     * rule forbids it — so it carries its own copy of the world→tile map, and a
     * silent second copy is exactly the kind of thing that rots. What it must
     * NOT be is `Math.floor(wx + (w-1)/2)`, which is the spelling ticket 007
     * shipped by mistake and which cost that ticket a full review cycle.
     *
     * Note that `Math.round(wx + (w-1)/2)` and `Math.floor(wx + w/2)` are the
     * SAME function — `round(x)` is `floor(x + 0.5)` — so testing one against
     * the other proves nothing. The error worth catching is the half-tile shift,
     * and it only shows up strictly between tile centres. Integer tile centres
     * agree under every candidate, which is why the centre-of-viewport case
     * above is not enough on its own.
     *
     * Tile `n` spans `[n - 0.5, n + 0.5)`, so a hit 0.6 tiles east of tile n's
     * centre is in tile n+1. The floored version says n.
     */
    const size = { w: 20, h: 15 }
    const camera = overheadCamera()
    const host = new FakeHost()
    const queue = createCommandQueue()
    const controller = new PointerController(
      host as unknown as HTMLElement,
      camera,
      queue,
      size,
      () => [1],
    )

    /** Client coordinates of a point on the ground plane, via the real camera. */
    const clientAt = (worldX: number, worldZ: number): { clientX: number; clientY: number } => {
      const ndc = new THREE.Vector3(worldX, 0, worldZ).project(camera)
      return {
        clientX: ((ndc.x + 1) / 2) * host.clientWidth,
        clientY: ((1 - ndc.y) / 2) * host.clientHeight,
      }
    }

    // Tile 12's centre in world x, then a hit 0.6 tiles east of it.
    const centreOfTile12 = 12 - (size.w - 1) / 2
    const past = clientAt(centreOfTile12 + 0.6, 0)
    host.fire('pointerdown', { button: 0, ...past })

    // And 0.4 east, which is still tile 12 — so the assertion above is a
    // boundary, not just "bigger numbers give bigger tiles".
    const short = clientAt(centreOfTile12 + 0.4, 0)
    host.fire('pointerdown', { button: 0, ...short })

    const targets = queue.drain().map((c) => (c.type === 'move' ? c.target.x : -1))
    expect(targets).toEqual([13, 12])
    controller.dispose()
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
      () => [1],
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
