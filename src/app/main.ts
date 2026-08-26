/**
 * Bootstrap: load the real level, build the scene, run the render loop.
 *
 * Every failure between here and the first frame is caught and reported on
 * screen through `showFatalError` — fetch failure, HTTP status, malformed JSON,
 * schema validation, and WebGL being unavailable each name themselves. A black
 * canvas is never an acceptable outcome.
 */

import * as THREE from 'three'
import { LevelValidationError, loadLevel, type LevelData } from '../core/level'
import { centroid, type GroundPoint } from '../core/view/camera'
import { parseElevation } from '../core/view/orientation'
import { tileToWorld } from '../core/view/projection'
import { levelRelief } from '../core/view/relief'
import { createSession } from '../core/session'
import { ordnanceForHotkey } from '../core/armoury'
import { createTracerBuffer } from '../core/render-state/tracers'
import { createCampaignRunner, viewFor } from '../core/flow'
import type { AdvanceResult, MissionHost, ViewId } from '../core/flow'
import type { SquadMember } from '../core/campaign'
import type { SimEvent } from '../core/world'
import { CameraRig } from '../render/camera-rig'
import { TracerRenderer } from '../render/tracer-renderer'
import { SceneBuilder } from '../render/scene-builder'
import {
  buildSpriteAtlas,
  fetchSpriteManifest,
  SpriteAtlasError,
  type SpriteManifest,
  type UnitVisual,
} from '../render/sprite-atlas'
import { FloorTextureError, loadFloorTexture } from '../render/floor-texture'
import { isEditableTarget } from '../input/editable-target'
import { PanController } from '../input/pan-controller'
import { PointerController } from '../input/pointer-controller'
import { ZoomController } from '../input/zoom-controller'
import { showControlHint, type ControlHint } from '../ui/control-hint'
import { showFatalError, type FatalErrorReport } from '../ui/error-overlay'
import { createHud, type RosterMember } from '../ui/hud'
import { createBootHill } from '../ui/boot-hill'
import { createMenu } from '../ui/menu'
import { createRecruitment } from '../ui/recruitment'
import { createBriefing } from '../ui/briefing'
import { createDebrief } from '../ui/debrief'
import { createLocalStoragePort } from './local-storage-port'
import { CORE_VERSION } from '../core/version'

/**
 * Relative on purpose: `vite.config.ts` sets `base: './'`, so the built page may
 * be served from any path (Vercel root, a preview subdirectory, `file://`). A
 * leading slash would break every one of those but the root.
 */
const LEVEL_URL = './generated/levels/level1.json'
const SPRITES_URL = './generated/sprites/sprites.manifest.json'

/** Longest a frame may claim to be, so a backgrounded tab doesn't teleport the camera. */
const MAX_FRAME_DT = 1 / 15

function mountPoint(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('#app')
  if (existing) return existing
  const created = document.createElement('div')
  created.id = 'app'
  document.body.append(created)
  return created
}

async function fetchLevel(url: string): Promise<LevelData> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new BootError(
      'Could not reach the level file',
      `The browser failed to fetch ${url}. If you opened the built files directly, serve them over HTTP instead.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  if (!response.ok) {
    throw new BootError(
      'The level file is missing',
      `The server answered ${String(response.status)} ${response.statusText} for ${url}.`,
      'Expected public/generated/levels/level1.json to be published with the build.',
    )
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (cause) {
    throw new BootError(
      'The level file is not valid JSON',
      `${url} was served, but could not be parsed.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  try {
    return loadLevel(json)
  } catch (cause) {
    if (cause instanceof LevelValidationError) {
      throw new BootError(
        'The level file failed validation',
        `${url} does not match the level schema this build understands.`,
        `${cause.code} at ${cause.path}: ${cause.message}`,
      )
    }
    throw cause
  }
}

/**
 * Load the sprite atlas, restating any failure as a `BootError`.
 *
 * The atlas is as load-bearing as the level: without it the map is empty
 * terrain, which is exactly the "looks fine, is broken" outcome the error
 * overlay exists to prevent. So a missing atlas stops the boot and says why,
 * rather than rendering a convincing but unpopulated level.
 */
async function fetchManifest(url: string): Promise<SpriteManifest> {
  try {
    return await fetchSpriteManifest(url)
  } catch (cause) {
    if (cause instanceof SpriteAtlasError) {
      throw new BootError('The sprite manifest could not be loaded', cause.detail, cause.technical)
    }
    throw cause
  }
}

async function fetchVisual(manifest: SpriteManifest, url: string): Promise<UnitVisual> {
  try {
    return await buildSpriteAtlas(manifest, url)
  } catch (cause) {
    if (cause instanceof SpriteAtlasError) {
      throw new BootError('The unit sprites could not be loaded', cause.detail, cause.technical)
    }
    throw cause
  }
}

/**
 * Load the tiling jungle floor (ticket 009c).
 *
 * A missing floor texture stops the boot for the same reason a missing atlas
 * does: the alternative is a map whose terrain is untextured or black, which is
 * the silent, plausible-looking failure the overlay exists to prevent. The
 * terrain constructor requires the texture, so this is enforced by the types as
 * well as by the boot order.
 */
async function fetchFloor(
  manifest: SpriteManifest,
  url: string,
  maxAnisotropy: number,
): Promise<THREE.Texture> {
  try {
    return await loadFloorTexture(manifest, url, maxAnisotropy)
  } catch (cause) {
    if (cause instanceof FloorTextureError) {
      throw new BootError(
        'The jungle floor texture could not be loaded',
        cause.detail,
        cause.technical,
      )
    }
    throw cause
  }
}

/** A failure with a message already written for a human. */
class BootError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
    readonly technical: string,
  ) {
    super(`${title}: ${detail}`)
    this.name = 'BootError'
  }
}

function createRenderer(): THREE.WebGLRenderer {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    // PCFSoft is deprecated in this three version and silently downgrades; ask
    // for what we actually get so the console stays clean.
    renderer.shadowMap.type = THREE.PCFShadowMap
    return renderer
  } catch (cause) {
    throw new BootError(
      'This browser cannot run WebGL',
      'The game needs hardware-accelerated WebGL. Try another browser, or enable hardware acceleration.',
      cause instanceof Error ? cause.message : String(cause),
    )
  }
}

/** Where the camera starts: the middle of the player squad, or the map centre. */
function initialFocus(level: LevelData): GroundPoint {
  const points: GroundPoint[] = level.spawns.avatars.map((spawn) => {
    const p = tileToWorld(spawn.x, spawn.y, level.size)
    return { x: p.x, z: p.z }
  })
  return centroid(points)
}

/**
 * Show a fatal error, at most once.
 *
 * Post-boot failures can arrive in bursts (a context loss immediately followed
 * by the render loop throwing); stacking overlays would bury the first and
 * truest message under the ones it caused.
 */
let reported = false
function fail(mount: HTMLElement, report: FatalErrorReport): void {
  if (reported) return
  reported = true
  showFatalError(mount, report)
}

async function boot(): Promise<void> {
  const mount = mountPoint()
  document.body.style.margin = '0'
  document.body.style.overflow = 'hidden'
  document.body.style.background = '#161a1d'

  const renderer = createRenderer()
  renderer.domElement.style.display = 'block'
  mount.append(renderer.domElement)

  // `?elev=` is a look-tuning knob, not a game setting: the camera angle is a
  // judgement against the source art and the only way to settle it is to look at
  // it, so it is adjustable without a rebuild. Garbage falls back to the default.
  // Read before the scene is built, because the sprite quads are tilted to face
  // this exact angle.
  const elevation = parseElevation(new URLSearchParams(window.location.search).get('elev'))

  // Both fetches at once: they are independent, and serialising them would put
  // a whole extra round trip in front of the first frame. The manifest is
  // fetched once and feeds two independent images — the packed atlas and the
  // tiling floor — which are then loaded in parallel too.
  const [level, manifest] = await Promise.all([fetchLevel(LEVEL_URL), fetchManifest(SPRITES_URL)])
  const [visual, floor] = await Promise.all([
    fetchVisual(manifest, SPRITES_URL),
    fetchFloor(manifest, SPRITES_URL, renderer.capabilities.getMaxAnisotropy()),
  ])
  // The simulation. Everything that decides what happens in the world lives on
  // the far side of this call — see `core/session` — so what is left here is the
  // browser's half: a frame delta in, a list of drawables and an alpha out.
  //
  // A `let`, because `startMission()` replaces it. Every closure below reads the
  // variable rather than capturing the object, so a restarted mission is picked
  // up by the render loop, the scene builder and the HUD without any of them
  // being rebuilt — and without the page reload that would cost the player the
  // level fetch, the atlas decode and his camera position.
  let session = createSession(level)
  const built = SceneBuilder.build(level, visual, floor, elevation, (heightAt) =>
    session.renderEntities(heightAt),
  )
  /** Feet sit on the top face of the tile they stand on, not on the ground plane. */
  const groundHeightAt = (tileX: number, tileY: number): number =>
    built.terrain.heightAt(tileX, tileY)

  /**
   * The live tracers (ticket 025a): every `ShotFired` this frame drained, stamped
   * with the RENDERER's clock.
   *
   * THE RENDERER'S CLOCK AND NOT THE SIMULATION'S, deliberately. A tracer is a
   * visual afterimage measured in real milliseconds — it has to look the same at
   * 30 fps and at 144 fps, and it must not be able to change the mission. Feeding
   * it `elapsed` (declared below, and reset by `startMission` for the reason stated
   * there) is what keeps it presentation: a headless replay of the same level,
   * seed and commands produces an identical mission whether or not anybody ever
   * drew a streak.
   *
   * A `let`, because `startMission()` REPLACES it. The buffer stamps tracers with a
   * clock the new mission puts back to zero, so rounds from the previous mission
   * would not merely linger — they would sit at a `firedAt` in the future,
   * unaged and therefore unfading, for the length of the next mission.
   */
  let tracers = createTracerBuffer()
  // Sized from the buffer's own capacity, which is what lets the geometry be
  // allocated once and never grown. See `TracerRenderer`.
  const tracerFx = new TracerRenderer({
    size: level.size,
    heightAt: groundHeightAt,
    capacity: tracers.capacity,
  })
  built.scene.add(tracerFx.object)

  // The rig reasons about the level's SILHOUETTE, not its footprint: the terrain
  // is extruded, so the zoom cap has to know how far this particular level's
  // tiles rise and fall — raised terrain at the far edge is what would otherwise
  // leave background above it. Measured from the level's own data — heights are
  // data, and a constant here would quietly stop covering the map the day mapgen
  // emits something taller.
  const rig = new CameraRig(
    built.bounds,
    { width: window.innerWidth, height: window.innerHeight },
    elevation,
    levelRelief(level),
  )
  rig.snapTo(initialFocus(level))

  // Both controllers register window-level listeners and hold a hard reference
  // to the rig, so both must be kept and disposed with the scene: ticket 020
  // loads a second level into the same page, and a leaked controller would keep
  // driving the dead rig — doubling every pan and zoom step.
  const pan = new PanController(rig)
  const zoom = new ZoomController(rig, window, renderer.domElement)
  // The only input path into the simulation: a click on the canvas becomes a
  // `Command` on the session's queue, which the tick drains. The selection is
  // handed in as a function and asked afresh at every click, so an order always
  // goes to the men who are alive when it is given.
  //
  // REBUILT ON RESTART, not reused: it holds the OLD session's command queue by
  // reference, and orders pushed onto a queue nothing drains are orders the new
  // squad never hears.
  let pointer = newPointer()

  function newPointer(): PointerController {
    return new PointerController(
      renderer.domElement,
      rig.camera,
      session.queue,
      level.size,
      () => session.selection(),
      // WHAT THE SQUAD IS HOLDING, ASKED AT THE CLICK. The command carries the
      // name and `applyCommand` routes on it, so the simulation never has to
      // consult the HUD's selection — a mission replayed from a command log
      // throws exactly what the log says it threw.
      () => session.armoury.selected,
    )
  }

  /**
   * The ordnance selector's keys: a BARE `1`/`2`/`3` (ticket 016).
   *
   * MATCHED ON `event.code`, never on `event.key`, for the reason
   * `core/debug/layers.ts` spells out at length: the character a digit produces
   * depends on the keyboard, the physical key does not.
   *
   * SHIFT IS EXCLUDED HERE AND CLAIMED THERE. `Shift+1`..`Shift+5` toggle the
   * debug overlay's layers, and the overlay's listener sits on the same window;
   * without this guard a developer with `?debug=1` open would change weapon
   * every time he switched a layer.
   *
   * Queued as a `selectOrdnance` COMMAND rather than written straight into the
   * armoury, because that is what the command union is for: the selection is
   * part of the input log, and a session replayed from one has to make the same
   * changes at the same ticks.
   */
  const onSelectKey = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (isEditableTarget(event.target)) return
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
    if (digit === undefined) return
    const ordnance = ordnanceForHotkey(digit)
    if (ordnance === undefined) return
    event.preventDefault()
    session.queue.push({ type: 'selectOrdnance', ordnance })
  }

  /**
   * SHIFT+WHEEL CYCLES THE SELECTOR; the bare wheel still zooms.
   *
   * Ticket 009b bound zoom to the wheel and it is the stronger convention, so
   * ordnance took the modifier — a bare wheel that did both would move the
   * camera every time the player changed weapon. `ZoomController` declines a
   * shifted wheel for the other half of the same bargain.
   *
   * Written straight into the armoury rather than queued, because a cycle is
   * RELATIVE — "the next one" — and a command log full of relative steps would
   * replay differently the moment anything else touched the selection. The
   * absolute name it lands on is what the next `fire` command carries, which is
   * the only thing the simulation ever sees.
   */
  const onSelectWheel = (event: WheelEvent): void => {
    if (!event.shiftKey) return
    // A trackpad reports the horizontal axis for a shifted scroll on some
    // platforms and the vertical on others, so whichever moved is the gesture.
    const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
    if (delta === 0) return
    event.preventDefault()
    // ONE STEP PER EVENT, not one per pixel: a trackpad fling delivers hundreds
    // of pixels of delta in a single event, and scaling by it would spin the
    // selector past every weapon and back.
    session.armoury.cycle(delta > 0 ? 1 : -1)
  }

  const onResize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight)
    rig.resize(window.innerWidth, window.innerHeight)
  }

  // Alt-tabbing away mid-burst delivers no pointer event at all to the canvas,
  // so the release that would stop the shooting never arrives. Only something
  // holding the `window` can hear it, which is here.
  const onBlur = (): void => {
    pointer.ceaseFire()
  }

  // The mission readout: roster, objectives, timer. It DECIDES nothing — every
  // value it shows is read off the session, which is where they are tested.
  const hud = createHud(mount)

  /**
   * The squad as the HUD lists it: every man the mission started with, alive or
   * not.
   *
   * Snapshotted at the start of each mission rather than read from the world
   * every frame, because the world forgets a man the moment he dies and a
   * roster that shrank as the squad died would show "3 of 3" over three
   * survivors of six. Ids are never reused within a mission, so `isAlive` is a
   * question with a permanent answer.
   */
  let roster: readonly number[] = playerIds()

  function playerIds(): readonly number[] {
    return session.world.entities.filter((e) => e.team === 'player').map((e) => e.id)
  }

  function rosterNow(): readonly RosterMember[] {
    return roster.map((id) => ({ id, alive: session.world.isAlive(id) }))
  }

  /**
   * Whether `teardown` has run. Read by the debug chunk's late arrival below,
   * which can land after a context loss has already torn the page down.
   */
  let stopped = false

  /**
   * The debug overlay (ticket 014), once it has loaded — `undefined` for as long
   * as it has not, and forever when `?debug=1` was not asked for.
   *
   * THE FLAG GATES A DYNAMIC `import()`, NOT AN `if` AROUND A LOADED MODULE.
   * `./debug-mode` and everything only it reaches — `core/debug`,
   * `render/debug-overlay`, `ui/debug-panel` — is a chunk of its own that a
   * normal build never fetches and never evaluates, which is what makes "the
   * production bundle does not grow" a measurable claim rather than a hope. It
   * follows that nothing above may import that module's VALUES: a type-only
   * import is erased, a value import would pull the whole chunk back in and
   * nothing would fail to warn us.
   *
   * Awaited nowhere: the first frames render without it and it appears when it
   * arrives. Blocking the boot on a debugging tool would make the flag change
   * the timing of the thing it is meant to measure.
   */
  let debug: { update(): void; dispose(): void } | undefined
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    void import('./debug-mode')
      .then((module) => {
        // The teardown may have run while the chunk was in flight; attaching
        // then would add a key listener to a page that is already dead.
        if (stopped) return
        debug = module.attachDebugMode({
          mount,
          scene: built.scene,
          renderer,
          size: level.size,
          heightAt: groundHeightAt,
          elevationRad: elevation,
          // The CURRENT session, not the one that exists now: `startMission()`
          // replaces it, and an overlay holding the old one would draw a dead
          // mission over the live one.
          session: () => session,
        })
      })
      .catch((error: unknown) => {
        // A debugging tool that fails to load must not take the game with it:
        // the mission is playable without an overlay, and a fatal screen here
        // would turn a mistyped URL into a broken build.
        console.error('debug overlay failed to load', error)
      })
  }

  /**
   * The campaign screen that is on the page, and which one it is. `undefined`
   * means nothing covers the canvas — see `reconcile`.
   *
   * ONE SLOT, NOT ONE VARIABLE PER SCREEN (ticket 022b). Four independent
   * handles is four things a transition can forget to dispose, and the symptom
   * is two screens stacked on top of each other with the buttons of the lower
   * one still live. A single slot makes "exactly one is mounted" a property of
   * the type rather than of every handler being careful.
   */
  let mounted: { readonly view: ViewId; readonly screen: { dispose(): void } } | undefined
  /** `MissionFailed.reason`, kept because the event is a one-shot and the screen is not. */
  let failure: string | undefined

  /**
   * The control hint, once the game has actually reached the canvas.
   *
   * SHOWN BY THE ROUTER RATHER THAN AT BOOT (ticket 022b). It explains the pan,
   * zoom and weapon keys, none of which do anything on the Menu — where it used
   * to appear, because boot put it up before any screen was decided.
   *
   * ONCE PER PAGE. `control-hint.ts` fades it out after a few seconds and
   * removes it on a click, so it is a one-shot by design; showing a fresh one on
   * every return to the canvas would re-teach the controls to a player who has
   * been using them for three missions.
   */
  let hint: ControlHint | undefined
  let hintShown = false

  function showHintOnce(): void {
    if (hintShown) return
    hintShown = true
    // "F to zoom out", not "F to fit": since ticket 009b the zoom-out limit stops
    // at the widest view that shows no background, which is deliberately short of
    // the whole level. A hint that still promised a fit would be a lie.
    hint = showControlHint(
      mount,
      'WASD / arrows or screen edge to pan  ·  wheel or +/− to zoom  ·  F to zoom out fully  ·  ' +
        '1–3 or shift+wheel to change weapon',
    )
  }

  /** Timestamp of the last frame, for the frame delta. See the render loop. */
  let previous = performance.now()

  /**
   * The renderer's animation clock, in seconds.
   *
   * Accumulated from clamped frame deltas rather than read from
   * `performance.now()`: a backgrounded tab would otherwise return to a clock
   * that had run on without it and snap every walk cycle to a random frame.
   *
   * THE INVARIANT, AND `startMission()` IS WHERE IT BREAKS. This clock and the
   * simulation's tick count measure the same zero. `core/session` hands a
   * corpse `animationStart = diedAtTick * FIXED_TIMESTEP` — a SIM-clock value —
   * and `EntityRenderer` plays the one-shot `die` clip from
   * `elapsedSeconds - animationStart`. Rebuilding the session puts `tickCount`
   * back to 0, so an animation clock left running is permanently ahead by the
   * length of every mission before it: `frameAt` clamps a non-looping clip to
   * its last frame, and every death after the first rebuild is pinned to the
   * final pose from the instant it happens. The man the player just lost simply
   * blinks into a corpse. Declared HERE, above `startMission()`, so the two can only
   * be reset together — nothing in Vitest can catch this, there being no DOM.
   */
  let elapsed = 0

  /**
   * EVERY EVENT THIS MISSION HAS PRODUCED, in order (ticket 022a).
   *
   * A REAL ADDITION RATHER THAN A REFACTOR, and the only way the campaign can
   * learn who died. The loop below drains `session.events()` every frame for
   * tracers and throws the batch away; `missionReport` reads the WHOLE stream —
   * the `UnitDied` events are spread across the frames the men fell on and the
   * `MissionComplete` lands on one frame near the end — so a campaign fed a
   * single frame's batch would bury nobody and record every mission as lost.
   *
   * CLEARED BY `host.start`, which is what keeps one mission's dead out of the
   * next one's report.
   */
  let missionLog: SimEvent[] = []

  /**
   * The browser's half of a mission (ticket 022a): the old `restart()`, given
   * the level and the men it always implied.
   *
   * `core/flow`'s runner owns the screen, the campaign and the squad and calls
   * these two; it can do that under Node because everything untestable about a
   * mission is on this side of the interface. What was `restart()` is `start`
   * with two arguments, and every comment on its steps is kept because every one
   * of them is a bug somebody already paid for.
   */
  const host: MissionHost = {
    start: startMission,
    /**
     * Release the mission that is ending.
     *
     * WHAT A MISSION OWNS HERE IS THE SESSION, THE TRACERS AND THE POINTER — NOT
     * THE SCENE. The terrain, the atlas and the floor are built once, for the
     * level this page fetched, and `start` re-enters that same scene; disposing
     * them here would leave nothing to come back to and a black canvas behind the
     * Debrief. They are freed by `teardown()` below, which ends the page rather
     * than the mission. Ticket 023 brings more than one level and is where a
     * scene rebuild belongs.
     *
     * THE POINTER IS DISPOSED HERE AND AGAIN IN `startMission`, AND BOTH CALLS
     * ARE DELIBERATE. `dispose` is idempotent, so the pair is safe. This one
     * exists because the pointer holds the finished session's command queue by
     * reference and the mission it would push orders onto is over — the player
     * sits on the Debrief and Boot Hill for minutes, and a live pointer over a
     * dead session for all of that is what this releases. `startMission`'s call
     * is the one that actually REPLACES it, and it cannot be dropped: a mission
     * started without an intervening `teardown` (the first deploy of the page)
     * never reaches this method at all.
     */
    teardown(): void {
      pointer.dispose()
    },
  }

  /**
   * Start a fresh mission in the page that is already running.
   *
   * REBUILT, NOT RELOADED. `location.reload()` would be one line and would cost
   * the level fetch, the sprite decode, the terrain build and the player's
   * camera position — for a mission whose entire state lives in the object
   * below. The scene, the rig and the controllers outlive the session by
   * design; only the simulation and the things holding a reference into it are
   * replaced.
   *
   * `next` IS HONOURED RATHER THAN IGNORED, but the scene above was built for
   * the one level this page fetched, so today it is always that same document —
   * see the note on `teardown`.
   */
  function startMission(next: LevelData, squad: readonly SquadMember[]): void {
    // THE SCREENS ARE NOT TOUCHED HERE (ticket 022b). The Briefing is still on
    // the page at this instant — `deploy()` starts the mission and only then
    // moves the screen — and `reconcile` takes it down a moment later off the
    // runner's own state. A mission that disposed screens itself would be a
    // second owner of the one slot, disagreeing with the router the first time a
    // command was refused.
    failure = undefined
    // EMPTIED FOR THE NEW MISSION, so the men who died in the last one are not
    // buried a second time in this one's report. Nothing subtle about the
    // placement — this function is synchronous, so no frame can run between here
    // and the `createSession` below; it sits next to its session for reading.
    missionLog = []
    // WITH THE MEN THE PLAYER CHOSE. `Session.assignment` is built from this and
    // is the map `missionReport` takes verbatim — it is the only place the sim's
    // entity ids and the campaign's recruit ids ever meet.
    session = createSession(next, { squad })
    // WITH THE SESSION, NOT AFTER IT. The new world's tick count starts at 0 and
    // the animation clock is keyed to sim time — see the invariant where it is
    // declared. `previous` goes with them so the first frame of the new mission
    // measures its delta from the new mission and not from the frame before it.
    elapsed = 0
    // WITH THE CLOCK THEY ARE STAMPED AGAINST. A tracer's age is `elapsed -
    // firedAt`, so rounds carried over from the mission that just ended would
    // have a `firedAt` in the future of the clock that just went back to zero —
    // an age that is negative rather than expired, which the buffer floors to
    // "brand new". The new mission would open under the last one's fire, and it
    // would never fade.
    tracers = createTracerBuffer()
    tracerFx.update(tracers.visible(elapsed))
    previous = performance.now()
    roster = playerIds()
    pointer.dispose()
    pointer = newPointer()
    // TWICE, DELIBERATELY. `setEntities` shifts current to previous, so a single
    // call would leave the renderer interpolating from the dead mission's last
    // frame — and entity ids start again from 1, so the new squad would be blended
    // out of wherever the old squad's ids last stood. Two calls make previous
    // and current the same state: no blend, which is right for a mission that
    // did not move, it began.
    const fresh = session.renderEntities(groundHeightAt)
    built.entities.setEntities(fresh)
    built.entities.setEntities(fresh)
  }

  /** Tear the whole session down: loop, listeners, controllers, GPU resources. */
  const teardown = (): void => {
    stopped = true
    renderer.setAnimationLoop(null)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('blur', onBlur)
    // BOTH OF THEM, and for the reason `debug-mode.ts`'s header gives about its
    // own listener: ticket 020 loads a second level into the same page, and a
    // leaked handler would keep pushing commands onto a dead session's queue
    // while the live one never heard the key at all.
    window.removeEventListener('keydown', onSelectKey)
    renderer.domElement.removeEventListener('wheel', onSelectWheel)
    // Whatever campaign screen is up goes with the page. One call, because there
    // is one slot — see `mounted`.
    mounted?.screen.dispose()
    mounted = undefined
    // Its own group, its own listener, its own GPU buffers — none of which the
    // scene's `dispose` knows about, because the overlay was added to the scene
    // from outside it.
    debug?.dispose()
    // Its own geometry and material, added to the scene from out here — so
    // `built.dispose()` does not know about them.
    tracerFx.dispose()
    hud.dispose()
    // Cancels its pending timers as well as removing it, so a torn-down page has
    // nothing left to fire.
    hint?.dismiss()
    pointer.dispose()
    zoom.dispose()
    pan.dispose()
    built.dispose()
    // Owned here, not by the terrain: it is loaded once for the session and
    // outlives any single level (ticket 020), so it is freed with the session.
    floor.dispose()
  }

  /**
   * The campaign (ticket 022a): one owner for the screen, the roster, the squad
   * and the mission lifecycle.
   *
   * EVERY DECISION BELOW IS ITS, NOT THIS FILE'S. Which screen follows a
   * mission, who is on the squad, who is buried and whether the campaign is over
   * are all answered in `core/flow` and `core/campaign`, where Vitest can see
   * them; what is left here is showing a `div` and calling the next command.
   *
   * ONE LEVEL TODAY. Ticket 023 loads the other four, and the array is the whole
   * change that takes: `levelIndex` is derived from the campaign's own
   * `unlockedLevels` against this list's length.
   */
  const runner = createCampaignRunner({
    levels: [level],
    port: createLocalStoragePort(),
    host,
  })

  /**
   * Take a command's answer, or say why it was refused.
   *
   * `AdvanceResult` carries a reason rather than throwing so that a
   * double-clicked button is ordinary traffic — but a refusal nobody prints is
   * exactly the dead button that shape exists to prevent, so it is logged.
   */
  function announce(result: AdvanceResult, what: string): boolean {
    if (result.ok) return true
    console.error(`game-week: ${what} was refused — ${result.reason}`)
    return false
  }

  /**
   * The mission is over: record it against the campaign, and let the router put
   * the Debrief up.
   *
   * IT MOUNTS NOTHING ITSELF, for the reason `reconcile` gives. `finishMission`
   * moves the screen to `Debrief` on both outcomes, so asking the runner
   * afterwards is the same answer with none of the risk of guessing it — and a
   * refused `finishMission` leaves the mission on screen rather than putting a
   * Debrief over a campaign that recorded nothing.
   */
  function endMission(): void {
    // `session.assignment` is read BEFORE the runner tears the mission down: it
    // is the map that says which recruit each entity was, and it is the only
    // thing that can name the man who just died.
    if (!announce(runner.finishMission(missionLog, session.assignment), 'the mission result')) {
      return
    }
    // A WRITE THAT FAILED MID-CAMPAIGN, LOGGED. The Menu renders `notice()` and
    // is where the player is told, but that is the end of the campaign away; a
    // save the store refused here is worth having in the console on the mission
    // it happened on. `saveCampaign` never blocks the transition, so there is
    // nothing else to do about it.
    const noticed = runner.notice()
    if (noticed !== null) console.warn(`game-week: ${noticed}`)
    reconcile()
  }

  /**
   * Build the panel a view names, wired to the commands its buttons issue.
   *
   * EVERY HANDLER CALLS A COMMAND AND THEN ASKS `reconcile`; not one of them
   * mounts a screen itself. That is the rule the whole router is built on: a
   * handler that mounted its own guess would disagree with the runner the first
   * time a command was refused, and the player would be looking at a screen the
   * game is not on. Refusals are printed rather than swallowed — by `announce`
   * into the console, and by Recruitment onto the screen, since `selectSquad`'s
   * reason is the one a player can actually act on.
   *
   * A `switch` over `ViewId` and not a lookup object, so the compiler is the
   * thing that notices when `core/flow` gains a view: the return type makes a
   * missing arm an error here rather than a blank page in a browser.
   */
  function mountView(view: ViewId): { dispose(): void } | undefined {
    switch (view) {
      case 'menu':
        return createMenu(mount, {
          // THE NOTICE, SHOWN AT LAST. `runner.notice()` has existed since
          // ticket 019 and until now went nowhere a player would ever look; a
          // save that was damaged or could not be written is the one thing this
          // screen must not keep to itself.
          notice: runner.notice(),
          onStart: () => {
            announce(runner.startCampaign(), 'starting the campaign')
            reconcile()
          },
        })
      case 'recruitment':
        return createRecruitment(mount, {
          // ASKED AGAIN ON EVERY TOGGLE, which is what keeps `autoFilled` — and
          // so the Deploy button's promise — true of the selection in front of
          // the player rather than of the empty one he started with.
          modelFor: (chosen) => runner.recruitment(chosen),
          onDeploy: (chosen) => {
            const result = runner.assignSquad(chosen)
            if (!result.ok) {
              // BACK TO THE SCREEN, not just to the console. "This level needs 3
              // men; only 1 was selected" is a sentence the player can act on,
              // and a Deploy button that refuses in silence is precisely what
              // `selectSquad` returning a reason exists to prevent.
              announce(result, 'assigning the squad')
              return result.reason
            }
            reconcile()
            return null
          },
        })
      case 'briefing':
        return createBriefing(mount, {
          model: runner.briefing(),
          onDeploy: () => {
            announce(runner.deploy(), 'deploying')
            reconcile()
          },
        })
      case 'debrief': {
        const model = runner.debrief()
        if (model === null) {
          // Unreachable: `Debrief` is only ever entered through `finishMission`,
          // which writes the report before it moves the screen. Written out
          // rather than asserted away, and reported as fatal rather than mounted
          // empty — a Debrief with no report means the mission's record was
          // lost, and a screen that made one up would tell the player nobody
          // died.
          fail(mount, {
            title: 'The mission result was lost',
            detail: 'The debrief has no report to show, so the mission could not be recorded.',
            technical: 'runner.debrief() was null on the Debrief screen.',
            action: { label: 'Reload the game', onClick: () => location.reload() },
          })
          return undefined
        }
        return createDebrief(mount, {
          model,
          // The sim's own sentence for the loss, kept because the event is a
          // one-shot and the screen outlives it by minutes.
          ...(failure === undefined ? {} : { reason: failure }),
          onContinue: () => {
            announce(runner.recordCasualties(), 'recording the casualties')
            reconcile()
          },
        })
      }
      case 'boot-hill': {
        const hill = createBootHill(mount, {
          continueLabel: 'Carry on',
          onContinue: () => {
            announce(runner.advanceFromBootHill(), 'leaving Boot Hill')
            reconcile()
          },
        })
        // Drawn once, here: the hill is built for the screen and the model
        // cannot change while it is up.
        hill.update(runner.bootHill())
        return hill
      }
    }
  }

  /**
   * THE ROUTER (ticket 022b): make the page agree with `runner.screen()`.
   *
   * ONE SCREEN MOUNTED, EXACTLY ONE, ALWAYS. Every transition comes through
   * here, so there is one place that can leak a screen and one place to look
   * when two are visible at once.
   *
   * IT IS DRIVEN BY THE RUNNER'S STATE AND NEVER BY THE CALLBACK THAT CAUSED IT.
   * Handlers issue a command and call this; a refused command therefore reports
   * the same screen as before and this function does nothing at all — the player
   * keeps the panel he is looking at, with his selection and his refusal still
   * on it.
   *
   * `Mission` MOUNTS THE CANVAS, which is to say it mounts nothing: `viewFor`
   * answers `null` and the job here is only to make sure no campaign screen is
   * covering the game. The mission itself is built and released by `host`, which
   * the runner drives.
   */
  function reconcile(): void {
    const view = viewFor(runner.screen())
    // THE MISSION CHROME BELONGS TO THE SAME `null` (ticket 022b). `viewFor`
    // answering `null` is what "the canvas is the screen" means, so the HUD and
    // the control hint are shown on exactly that answer and hidden on every
    // other. Asked of `viewFor` and not of `runner.screen() === 'Mission'`: one
    // table, one answer, and no second spelling to fall out of step with the
    // screens. Without this the HUD sits behind every campaign panel, reporting
    // a squad and a mission clock for a mission the player is not in.
    //
    // ABOVE THE EARLY RETURN, so it runs on every call — including the ones
    // where the mounted screen is already right.
    hud.setVisible(view === null)
    if (view === null) showHintOnce()
    // The hint is a one-shot and its own file removes it on a timer or a click;
    // dismissing it here only covers the case where the mission ends before
    // either has happened, so it does not linger over the Debrief.
    else hint?.dismiss()
    // Already right. The early return is what makes a refused command free —
    // without it a redraw would tear down the Recruitment screen the player is
    // mid-selection on and put an empty one back.
    if (mounted?.view === view) return
    mounted?.screen.dispose()
    mounted = undefined
    if (view === null) return
    const screen = mountView(view)
    if (screen === undefined) return
    mounted = { view, screen }
  }

  window.addEventListener('resize', onResize)
  window.addEventListener('blur', onBlur)
  window.addEventListener('keydown', onSelectKey)
  // On the canvas and not the window, so a shifted scroll over a future DOM
  // panel still scrolls the panel. `passive: false` because it calls
  // `preventDefault` — a passive listener's call is ignored with a warning.
  renderer.domElement.addEventListener('wheel', onSelectWheel, { passive: false })

  // A context loss AFTER boot would otherwise leave exactly the black canvas the
  // error overlay exists to prevent, since `boot()`'s catch has long since run.
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    teardown()
    fail(mount, {
      title: 'The graphics context was lost',
      detail:
        'The browser dropped the WebGL context — usually a driver reset, a GPU switch, or the tab being starved of memory.',
      technical: 'webglcontextlost on the game canvas.',
      action: { label: 'Reload the game', onClick: () => location.reload() },
    })
  })

  // THE FIRST SCREEN, BEFORE THE LOOP STARTS (ticket 022b). On a fresh page the
  // runner is on `Menu`, so this is what puts the Menu up; there is no bridge
  // into a mission any more and no screen is mounted by name. `demoShortcut`
  // survives as a runner command for the `?demo=1&level=N` deep link, which is
  // ticket 029's to read off the address bar and hand in as `entry`.
  //
  // The scene behind it was built from the level's own anonymous spawns and is
  // rebuilt with the player's men by `host.start` on the first deploy.
  reconcile()

  renderer.setAnimationLoop((now) => {
    // A throw here repeats every frame and is invisible behind a frozen canvas.
    // Stop the loop on the first one and say so on screen instead.
    try {
      const dt = Math.min((now - previous) / 1000, MAX_FRAME_DT)
      previous = now
      elapsed += dt
      pan.update(dt)
      rig.update(dt)
      // The simulation runs at its own fixed 60 Hz whatever this display does.
      // `advance` returns how far into the step after the last one the frame
      // ended, which is what the renderer blends the two states it holds by —
      // the hardcoded 1 that stood here while there was no sim would pin every
      // frame to the latest tick and throw the interpolation away.
      const alpha = session.advance(dt)
      // ONLY ON A FRAME THAT STEPPED. `setEntities` shifts current to previous,
      // so it is a per-SIM-TICK call, not a per-frame one (see its docstring).
      // Above 60 Hz most frames run no steps, and pushing on those would make
      // previous and current the same state — `alpha` would then blend a state
      // with itself and the interpolation would be worth nothing. Note a frame
      // that ran several steps still hands over a state 2+ ticks after the last
      // one it saw, so its blend spans more than one tick; that is inherent to
      // catching up after a hitch and is not smoothed away here.
      if (session.stepsLastAdvance > 0) {
        built.entities.setEntities(session.renderEntities(groundHeightAt))
      }
      // Drained every frame whether or not anything is listening yet: the batch
      // is the only channel out of the sim, and left undrained it would grow
      // for the length of the mission. The reason is kept because the event
      // fires once and the screen it explains outlives it by minutes.
      // ONLY WHILE THE MISSION IS ON, and off the same guard `endMission` uses
      // below rather than a second flag of this file's. The session keeps
      // stepping and keeps emitting for as long as the player leaves the Debrief
      // and Boot Hill up, and a log that kept growing after the report it feeds
      // was written is an array with no bound and no reader — the pre-022a loop
      // discarded those events. `endMission` runs after this drain, so the final
      // frame's `MissionComplete` is still logged on the frame it lands.
      const logging = runner.screen() === 'Mission'
      for (const event of session.events()) {
        // KEPT, NOT JUST READ (ticket 022a). The batch is the only channel out
        // of the sim and it is drained once; the campaign needs the whole
        // mission's worth at the end of it. See `missionLog`.
        if (logging) missionLog.push(event)
        if (event.type === 'MissionFailed') failure = event.reason
        // ONE TRACER PER ROUND, from the event's own endpoints. Ticket 011a
        // already clamps the far end to the near face of whatever the round
        // meets, so a tracer drawn to `targetX`/`targetZ` stops at the wall
        // without a line of geometry code asking whether it should.
        else if (event.type === 'ShotFired') tracers.add(event, elapsed)
      }
      // NOT UPDATED WHILE HIDDEN. The session keeps stepping behind the Debrief
      // and Boot Hill, so this would go on writing a clock and a roster nobody
      // can see. Nothing is lost by skipping: the router shows the panel from
      // inside the callback that starts the mission, and the next frame's update
      // runs before that frame is painted, so it is never seen stale.
      if (hud.isVisible()) {
        hud.update({
          squad: rosterNow(),
          objectives: session.objectives.progress(),
          elapsedTicks: session.objectives.elapsedTicks,
          selector: session.armoury.slots(),
        })
      }
      // FROM THE STATE, NOT FROM THE EVENT. A frame that ran eight steps drains
      // them all at once and a frame that ran none drains nothing, so an end
      // screen driven by catching the event on the right frame is an end screen
      // that occasionally never appears. `outcome()` is latched and can be
      // asked at any time.
      const outcome = session.outcome()
      // THE RUNNER'S SCREEN IS THE GUARD, not a flag of this file's: the mission
      // is over exactly once, and `Mission -> Debrief` is a transition the chart
      // will not make twice. An `ending === undefined` check would have said the
      // same thing until the Debrief was dismissed, at which point it would fire
      // again over a mission that had already been recorded — and the campaign
      // would bury the same men twice.
      if (outcome !== 'playing' && runner.screen() === 'Mission') endMission()
      built.entities.update(elapsed, alpha)
      // EVERY FRAME, not only on a stepping one: a tracer fades on the display's
      // clock, so a frame that ran no simulation step still has to redraw the
      // streaks a little dimmer than it found them.
      tracerFx.update(tracers.visible(elapsed))
      // BEFORE the render, so this frame draws what this frame decided. Absent
      // `?debug=1` this is one optional-call check per frame and no debug module
      // was ever fetched, let alone evaluated.
      debug?.update()
      renderer.render(built.scene, rig.camera)
    } catch (error: unknown) {
      teardown()
      console.error(error)
      fail(mount, {
        title: 'The game stopped rendering',
        detail: 'An error inside the render loop stopped the frame from being drawn.',
        technical: error instanceof Error ? (error.stack ?? error.message) : String(error),
        action: { label: 'Reload the game', onClick: () => location.reload() },
      })
    }
  })

  console.info(
    `game-week: ${level.name} ${String(level.size.w)}x${String(level.size.h)} ` +
      `(${String(built.terrain.triangleCount)} tris, ${String(built.entities.drawCalls)} sprite draws, ` +
      `camera ${((elevation * 180) / Math.PI).toFixed(1)}°, core ${CORE_VERSION})`,
  )
}

boot().catch((error: unknown) => {
  const mount = mountPoint()
  if (error instanceof BootError) {
    fail(mount, {
      title: error.title,
      detail: error.detail,
      technical: error.technical,
    })
  } else {
    fail(mount, {
      title: 'The game failed to start',
      detail: 'An unexpected error stopped the level from rendering.',
      technical: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  }
  console.error(error)
})
