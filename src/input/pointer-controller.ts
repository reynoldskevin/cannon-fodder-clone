/**
 * PointerController — a click on the canvas becomes a `Command`, or nothing.
 *
 * WHAT IT MAY KNOW. Only `src/core/command`: the queue and the command types.
 * Not `World`, not `SquadSystem`, not the nav grid. The temptation is to reach
 * for one of them to check something before queueing — is that unit alive, is
 * that tile passable — and the moment it does, the single input path into the
 * simulation has quietly become two, one of which nobody is testing. Everything
 * this class needs is handed in, and `__tests__/layering.test.ts` asserts the
 * rule on the source text because no type system will.
 *
 * WHO THE ORDER IS FOR. A command that names no units is refused by
 * `applyCommand`, so a controller that could not answer "who does this?" would
 * click the ground and do nothing at all. It still may not go and find the
 * selection — that means reaching for the world — so the selection is handed in
 * as a function and CALLED AT EVERY CLICK, and the ids it returns are copied
 * into the command. With nothing selected, nothing is queued.
 *
 * FIRE IS A HELD BUTTON (ticket 011a). Right down orders the fire, dragging
 * while held re-aims it, and releasing — or the pointer leaving, or the browser
 * cancelling it — orders the cease-fire. Only the press half would make
 * right-click a latch: the men would start shooting and nothing would ever tell
 * them to stop. Window blur is the one case this cannot see, so `ceaseFire` is
 * public for `main.ts` to drive; see it.
 *
 * WHY IT REJECTS RATHER THAN CLAMPS. `core/view/projection.worldToTile` rounds
 * AND clamps, and using it here would be a bug: a click on the grass a hundred
 * tiles past the east edge would clamp to the edge column and become a
 * plausible-looking order. So the tile index is computed here and bounds-checked
 * BEFORE anything is queued, and a click off the map queues nothing at all. The
 * same rule is enforced again in `applyCommand`; this is not redundancy, it is
 * the two ends of the path each refusing to invent an order.
 *
 * THE COORDINATE CONVENTION, spelled out because it is half a tile away from
 * the obvious one. A level is centred on the world origin and an integer tile
 * index names a tile CENTRE: `tileToWorld` maps tile n to `n - (w - 1) / 2`.
 * Inverting that gives `Math.round(worldX + (w - 1) / 2)` — a ROUND, not a
 * floor of `worldX + w/2 - 0.5`-shaped arithmetic done by eye. It is duplicated
 * here rather than imported because importing `core/view` would breach the rule
 * above; the projection module's own tests pin the forward direction.
 *
 * NO DOM AT CONSTRUCTION. The host is only ever asked for `addEventListener`,
 * `removeEventListener` and `getBoundingClientRect`, and events are read as
 * plain objects. That is what lets the maths and the button mapping be tested
 * under `environment: 'node'` with no jsdom — and a class that can only be
 * exercised through a real browser event is a class nobody tests.
 */

import * as THREE from 'three'
import type { Command, CommandQueue } from '../core/command'

/** The level's extent in tiles. The controller needs nothing else about it. */
export interface LevelTileSize {
  readonly w: number
  readonly h: number
}

/** Standard pointer button numbers. */
const LEFT_BUTTON = 0
const RIGHT_BUTTON = 2

/**
 * The ordnance a right-click fires with until there is a selector.
 *
 * Ticket 016 owns ordnance selection (hotkeys, scroll, HUD) and will feed the
 * active type in; naming it here keeps the `fire` command well-formed in the
 * meantime rather than leaving the field empty.
 */
const DEFAULT_ORDNANCE = 'rifle'

/**
 * Who a queued order is for, asked afresh at every click.
 *
 * A function rather than an array because the squad is not a constant: men die
 * and the player splits the group, so a roster captured once at construction is
 * the roster from the start of the mission. Passing it in is also what keeps
 * this class out of `core/` — it never has to go looking for a selection.
 */
export type SelectionProvider = () => readonly number[]

/** The ground: the XZ plane at y = 0, the same plane the terrain is drawn on. */
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

export class PointerController {
  private readonly raycaster = new THREE.Raycaster()
  private readonly ndc = new THREE.Vector2()
  private readonly hit = new THREE.Vector3()
  private disposed = false

  /**
   * Who is currently under a fire order, or `null` when the button is not held.
   *
   * FIRE IS A HELD BUTTON, NOT A CLICK (ticket 011a). The squad holds fire until
   * ordered and keeps shooting while the order stands, so the press and the
   * release are two different commands and this is what tells them apart: a
   * release with nothing held issues nothing, which is what stops a left-click
   * or a stray `pointerup` from stopping a burst.
   *
   * The ids are the ones the FIRE was issued with rather than the selection as
   * it stands at release time. The player may have re-selected mid-burst, and a
   * cease-fire naming the new selection would leave the men who were actually
   * shooting still shooting.
   */
  private firing: readonly number[] | null = null

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Cheap guard for the window between `dispose` and a listener that some
    // host implementation has already dispatched into.
    if (this.disposed) return

    const type = commandTypeFor(event.button)
    if (type === null) return

    // Asked now, not at construction, and copied: the provider hands back the
    // live selection array, and a command holding a reference to it would
    // rewrite its own id list the next time the squad takes a casualty.
    const unitIds = [...this.selection()]
    // No one to send is not an order. `applyCommand` would refuse it anyway;
    // queueing it would only put noise in front of the orders that are real.
    if (unitIds.length === 0) return

    // THE BUTTON BEING HELD IS THE STATE, and it is set before the tile is even
    // looked for. The release path is purely button-driven — a right `pointerup`
    // ends the burst whatever the pointer is over — so making the press half
    // conditional on finding a tile made the two halves disagree: a right-press
    // that started on the sky and was then dragged onto the map would move the
    // pointer over the battlefield, still held, issuing nothing, because the
    // burst had never begun. Held is held; where he is pointing is the separate
    // question below, asked again on every move.
    //
    // The cost is a `ceaseFire` with no `fire` before it, when a press and its
    // release both happen off the map. `applyCommand` accepts it and
    // `CombatSystem.ceaseFire` deletes an order nobody has — a no-op, and a far
    // smaller thing to be wrong about than a dead right button.
    if (type === 'fire') this.firing = unitIds

    const tile = this.tileUnderPointer(event)
    if (tile === null) return

    this.queue.push(buildCommand(type, tile, unitIds))
  }

  /**
   * Dragging while the right button is held RE-AIMS: the same standing order,
   * a new point. A move with nothing held is just the pointer crossing the
   * canvas and must issue nothing at all, or every mouse movement is an order.
   */
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.disposed) return
    const unitIds = this.firing
    if (unitIds === null) return
    const tile = this.tileUnderPointer(event)
    if (tile === null) return
    this.queue.push(buildCommand('fire', tile, unitIds))
  }

  /**
   * A release only ends the burst if it is the RIGHT button. Left is move, and
   * a left-click during a burst must not stop the shooting.
   */
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.disposed) return
    if (event.button !== RIGHT_BUTTON) return
    this.ceaseFire()
  }

  /**
   * The pointer leaving the canvas, or the browser taking it away — a touch
   * turning into a scroll gesture, the OS grabbing it. No `pointerup` follows a
   * cancel, so without this the squad fires forever.
   */
  private readonly onPointerLost = (): void => {
    if (this.disposed) return
    this.ceaseFire()
  }

  /** Right-click on the canvas is an order, so it must not open the browser menu. */
  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault()
  }

  constructor(
    private readonly host: HTMLElement,
    private readonly camera: THREE.Camera,
    private readonly queue: CommandQueue,
    private readonly size: LevelTileSize,
    private readonly selection: SelectionProvider,
  ) {
    this.host.addEventListener('pointerdown', this.onPointerDown as EventListener)
    this.host.addEventListener('pointermove', this.onPointerMove as EventListener)
    this.host.addEventListener('pointerup', this.onPointerUp as EventListener)
    this.host.addEventListener('pointerleave', this.onPointerLost)
    this.host.addEventListener('pointercancel', this.onPointerLost)
    this.host.addEventListener('contextmenu', this.onContextMenu)
  }

  /**
   * Stop the burst, if there is one. Idempotent, so a caller may drive it from
   * anything that means "the player is no longer holding the button".
   *
   * Public because WINDOW BLUR CANNOT BE HEARD FROM HERE: alt-tabbing away
   * mid-burst delivers no pointer event at all to the canvas, and only
   * something holding the `window` — `main.ts`, which already owns one — can
   * hear it. Pretending to handle it here would leave the squad firing until
   * the player came back.
   */
  ceaseFire(): void {
    const unitIds = this.firing
    if (unitIds === null) return
    this.firing = null
    this.queue.push({ type: 'ceaseFire', unitIds })
  }

  dispose(): void {
    // Before the listeners come off, and before `disposed` is set, so a
    // controller is never torn down with a burst still outstanding.
    //
    // WHAT THIS DOES NOT DO, stated because the obvious reading is wrong.
    // `main.ts`'s `teardown` calls `renderer.setAnimationLoop(null)` BEFORE it
    // calls this, and the animation loop is the only thing that ever calls
    // `session.advance` — which is the only thing that drains the queue. So the
    // `ceaseFire` pushed here is pushed onto a queue that will not be read
    // again, into a session dropped whole a few lines later. It stops no
    // shooting, because nothing is going to tick.
    //
    // It is still right, and cheap. What it buys is a property of THIS class:
    // disposing never leaves a burst hanging, which `__tests__` asserts by
    // reading the queue directly, and a host that disposes the controller while
    // KEEPING the session — swapping input modes rather than levels — gets the
    // cease-fire it is owed without having to know to ask.
    this.ceaseFire()
    // Idempotent: ticket 020 loads a second level into the same page, and a
    // teardown path that throws the second time it runs is a teardown path
    // people start guarding at the call site instead.
    this.disposed = true
    this.host.removeEventListener('pointerdown', this.onPointerDown as EventListener)
    this.host.removeEventListener('pointermove', this.onPointerMove as EventListener)
    this.host.removeEventListener('pointerup', this.onPointerUp as EventListener)
    this.host.removeEventListener('pointerleave', this.onPointerLost)
    this.host.removeEventListener('pointercancel', this.onPointerLost)
    this.host.removeEventListener('contextmenu', this.onContextMenu)
  }

  /**
   * The tile under this pointer event, or `null` if there is not one — either
   * because the ray never meets the ground plane (a camera looking at or above
   * the horizon) or because the point it meets is off the map.
   */
  private tileUnderPointer(event: PointerEvent): { x: number; y: number } | null {
    const rect = this.host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      // Screen y grows downward, NDC y grows upward.
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
    this.raycaster.setFromCamera(this.ndc, this.camera)

    // `null` when the ray is parallel to the ground or points away from it.
    if (this.raycaster.ray.intersectPlane(GROUND, this.hit) === null) return null

    // Centre-indexed: integer tile n sits at world n - (w - 1) / 2, so the
    // index of a world position is the round-trip of that offset, rounded.
    // The `+ 0` normalises `-0`, which `Math.round` returns for a hit just
    // below tile 0's centre. Every consumer today treats it as 0, but `-0`
    // survives `toEqual` and `Object.is`, so a later dedupe or snapshot would
    // see two different targets for the same tile.
    const x = Math.round(this.hit.x + (this.size.w - 1) / 2) + 0
    const y = Math.round(this.hit.z + (this.size.h - 1) / 2) + 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (x < 0 || y < 0 || x >= this.size.w || y >= this.size.h) return null
    return { x, y }
  }
}

/** Left orders a march, right puts ordnance down, anything else is not an order. */
function commandTypeFor(button: number): 'move' | 'fire' | null {
  if (button === LEFT_BUTTON) return 'move'
  if (button === RIGHT_BUTTON) return 'fire'
  return null
}

function buildCommand(
  type: 'move' | 'fire',
  target: { x: number; y: number },
  unitIds: readonly number[],
): Command {
  return type === 'move'
    ? { type: 'move', unitIds, target }
    : { type: 'fire', unitIds, ordnance: DEFAULT_ORDNANCE, target }
}
