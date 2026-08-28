import { describe, it, expect, beforeEach } from 'vitest'
import { PanController } from '../pan-controller'

/**
 * Ticket 074 — the edge-scroll bands belong to the playfield, not the window.
 *
 * THE BUG THIS FILE EXISTS FOR. The canvas now starts at the rail's right edge,
 * but the edge-scroll was still measured from `innerWidth`/`innerHeight` — so
 * the "left edge of the screen" band sat entirely UNDER the roster. Reading a
 * name or reaching for the grenade icon would pan the camera west, and let go of
 * it only when the pointer came back out. The player would experience a map that
 * drifts whenever he looks at his squad.
 *
 * The rig is faked down to `panBy`, because what is under test is which pointer
 * positions produce intent — the clamping and the world units are the rig's own,
 * and `camera-rig`'s tests own them.
 */

/** Just enough rig to record what the controller asked for. */
class FakeRig {
  readonly moves: { right: number; up: number }[] = []
  panBy(right: number, up: number): void {
    this.moves.push({ right, up })
  }
}

/** A `Window` stand-in that lets a test fire the listeners the controller adds. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  innerWidth = 1000
  innerHeight = 800
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  fire(type: string, event: Record<string, unknown>): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

/**
 * The playfield: the window minus a 200px rail down the left.
 *
 * The same shape a canvas answers with, so the controller can be handed the real
 * element in `main.ts` and this fake here without either knowing the difference.
 */
class FakePlayfield {
  left = 200
  top = 0
  width = 800
  height = 800
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: this.left, top: this.top, width: this.width, height: this.height }
  }
}

const EDGE = 28

let rig: FakeRig
let target: FakeTarget
let playfield: FakePlayfield
let pan: PanController

beforeEach(() => {
  rig = new FakeRig()
  target = new FakeTarget()
  playfield = new FakePlayfield()
  pan = new PanController(
    rig as unknown as ConstructorParameters<typeof PanController>[0],
    target as unknown as Window,
    playfield,
  )
})

/** Put the pointer somewhere and run one 1-second frame. */
const pointAt = (clientX: number, clientY: number): void => {
  target.fire('pointermove', { clientX, clientY })
  pan.update(1)
}

describe('the strip under the rail is not an edge', () => {
  it('does not pan west when the pointer is over the roster', () => {
    /**
     * THE CASE THE TICKET EXISTS FOR. `x = 4` is four pixels from the WINDOW's
     * left edge and 196 from the PLAYFIELD's, so the old rule panned and the new
     * one must not. This is where the player's hand is whenever he is reading his
     * squad or arming a grenade.
     */
    pointAt(4, 400)
    expect(rig.moves).toEqual([])
  })

  it('and does not pan west anywhere else over the panel either', () => {
    pointAt(playfield.left - 1, 400)
    expect(rig.moves).toEqual([])
  })

  it('but does pan west at the playfield’s own left edge', () => {
    pointAt(playfield.left + 1, 400)
    expect(rig.moves).toHaveLength(1)
    expect(rig.moves[0]?.right).toBeLessThan(0)
  })

  it('and stops panning a whisker inside it', () => {
    pointAt(playfield.left + EDGE + 1, 400)
    expect(rig.moves).toEqual([])
  })
})

describe('and neither is the strip along the top or the bottom of it', () => {
  /**
   * THE HALF OF THE FIX THAT WAS MISSING, and the reason these cases are
   * corners. The first version re-based the horizontal bands on the playfield
   * and left the vertical ones measured from the window — and the rail runs the
   * FULL HEIGHT of the screen, so its top and bottom 28 pixels stayed inside the
   * vertical bands no matter what x said. Tested one axis at a time, both
   * suites passed; the map still drifted north while the player read the top
   * name on his roster.
   */
  it('does not pan north from the top of the rail', () => {
    pointAt(4, 10)
    expect(rig.moves).toEqual([])
  })

  it('and does not pan south from the bottom of it', () => {
    pointAt(4, playfield.height - 5)
    expect(rig.moves).toEqual([])
  })

  it('and not from the middle of its width either', () => {
    pointAt(120, 5)
    expect(rig.moves).toEqual([])
  })

  it('but does pan north just inside the playfield at the same height', () => {
    // The control: the band itself still works one pixel to the right of the
    // rail, so the test above is about WHERE the pointer is and not about the
    // top band having been disabled.
    pointAt(playfield.left + 100, 5)
    expect(rig.moves[0]?.up).toBeGreaterThan(0)
  })
})

describe('the other three edges still work, measured from the playfield', () => {
  it('pans east at the right-hand edge', () => {
    pointAt(playfield.left + playfield.width - 1, 400)
    expect(rig.moves[0]?.right).toBeGreaterThan(0)
  })

  it('and pans north at the top', () => {
    pointAt(600, playfield.top + 1)
    expect(rig.moves[0]?.up).toBeGreaterThan(0)
  })

  it('and south at the bottom', () => {
    pointAt(600, playfield.top + playfield.height - 1)
    expect(rig.moves[0]?.up).toBeLessThan(0)
  })

  it('and not at all in the middle', () => {
    pointAt(600, 400)
    expect(rig.moves).toEqual([])
  })

  it('and not past the right-hand edge, where the pointer has left the canvas', () => {
    // Beyond the playfield is not "further into the east band" — it is off the
    // playfield entirely, and a pointer that is somewhere else should not be
    // driving the camera at all.
    pointAt(playfield.left + playfield.width + 10, 400)
    expect(rig.moves).toEqual([])
  })
})

describe('what this ticket does not change', () => {
  it('the keyboard still pans, with no pointer involved at all', () => {
    target.fire('keydown', { code: 'KeyD', preventDefault: () => {} })
    pan.update(1)
    expect(rig.moves[0]?.right).toBeGreaterThan(0)
  })

  it('and a pointer that has left the window stops the scroll', () => {
    pointAt(playfield.left + 1, 400)
    rig.moves.length = 0
    target.fire('pointerleave', {})
    pan.update(1)
    expect(rig.moves).toEqual([])
  })

  it('and with no playfield given it falls back to the window', () => {
    /**
     * The default keeps `PanController` usable on its own terms — and keeps this
     * ticket from being the reason a second caller has to know about canvases.
     */
    const bare = new PanController(
      rig as unknown as ConstructorParameters<typeof PanController>[0],
      target as unknown as Window,
    )
    target.fire('pointermove', { clientX: 4, clientY: 400 })
    bare.update(1)
    expect(rig.moves[0]?.right).toBeLessThan(0)
    bare.dispose()
  })
})
