/**
 * Bootstrap: load the real level, build the scene, run the render loop.
 *
 * Every failure between here and the first frame is caught and reported on
 * screen through `showFatalError` — fetch failure, HTTP status, malformed JSON,
 * schema validation, and WebGL being unavailable each name themselves. A black
 * canvas is never an acceptable outcome.
 */

import * as THREE from 'three'
import {
  LevelValidationError,
  LEVELS_MANIFEST_FILE,
  loadLevel,
  type LevelData,
} from '../core/level'
import { centroid, type GroundPoint } from '../core/view/camera'
import { parseElevation } from '../core/view/orientation'
import { tileToWorld } from '../core/view/projection'
import { levelRelief } from '../core/view/relief'
import { createSession } from '../core/session'
import { ordnanceForHotkey } from '../core/armoury'
import { createTracerBuffer } from '../core/render-state/tracers'
import { createFxBuffer } from '../core/render-state/fx'
import { shakeFor } from '../core/view/shake'
import { cueFor, firingCue, type CueRequest } from '../core/audio-events'
import { createAudioBus } from '../audio'
import { createCampaignRunner, viewFor } from '../core/flow'
import type { AdvanceResult, MissionHost, ViewId } from '../core/flow'
import type { SquadMember } from '../core/campaign'
import type { SimEvent } from '../core/world'
import type { RenderEntity } from '../core/render-state/entity'
import { CameraRig } from '../render/camera-rig'
import { TracerRenderer } from '../render/tracer-renderer'
import { createFxRenderer, type FxRenderer } from '../render/fx-renderer'
import { SceneBuilder, type BuiltScene } from '../render/scene-builder'
import {
  buildSpriteAtlas,
  fetchSpriteManifest,
  SpriteAtlasError,
  type SpriteManifest,
  type UnitVisual,
} from '../render/sprite-atlas'
import { GroundTextureError, loadGroundTextures } from '../render/ground-texture'
import type { GroundSurface } from '../core/view/ground-surface'
import { isEditableTarget } from '../input/editable-target'
import { PanController } from '../input/pan-controller'
import { PointerController } from '../input/pointer-controller'
import { ZoomController } from '../input/zoom-controller'
import { showControlHint, type ControlHint } from '../ui/control-hint'
import { showFatalError, type FatalErrorReport } from '../ui/error-overlay'
import { createHud, type RosterMember } from '../ui/hud'
import { createBootHill } from '../ui/boot-hill'
import { createMenu } from '../ui/menu'
import { createBriefing } from '../ui/briefing'
import { createLocalStoragePort } from './local-storage-port'
import { CORE_VERSION } from '../core/version'

/**
 * Relative on purpose: `vite.config.ts` sets `base: './'`, so the built page may
 * be served from any path (Vercel root, a preview subdirectory, `file://`). A
 * leading slash would break every one of those but the root.
 */
const LEVELS_DIR = './generated/levels'
/**
 * The list of published levels, in campaign order (ticket 024).
 *
 * THE APP CANNOT LIST A DIRECTORY OVER HTTP, so the set of levels is a file the
 * importer writes. The name comes from `core/level` because `tools/mapgen`
 * writes it under the same constant — a second spelling here would 404 at boot
 * the first time the file was renamed, with every test still green.
 */
const MANIFEST_URL = `${LEVELS_DIR}/${LEVELS_MANIFEST_FILE}`
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

/**
 * Fetch a JSON document, restating every failure as a named `BootError`.
 *
 * SHARED BY THE MANIFEST AND THE LEVELS, because they fail the same four ways —
 * unreachable, missing, unparseable, wrong — and the manifest is the one file
 * whose absence must not read as anything vaguer than "this build is broken".
 * `what` names the document so the title on screen says which one.
 */
async function fetchJson(url: string, what: string, expected: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new BootError(
      `Could not reach the ${what}`,
      `The browser failed to fetch ${url}. If you opened the built files directly, serve them over HTTP instead.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  if (!response.ok) {
    throw new BootError(
      `The ${what} is missing`,
      `The server answered ${String(response.status)} ${response.statusText} for ${url}.`,
      expected,
    )
  }

  try {
    return await response.json()
  } catch (cause) {
    throw new BootError(
      `The ${what} is not valid JSON`,
      `${url} was served, but could not be parsed.`,
      cause instanceof Error ? cause.message : String(cause),
    )
  }
}

/**
 * The published levels, in campaign order.
 *
 * A MISSING OR MALFORMED MANIFEST IS FATAL AND NAMED, never a silent fallback to
 * level 1. A campaign that quietly shrank to one level is precisely the failure
 * ticket 024 exists to remove: `campaignComplete(2, 1)` is true the moment the
 * first level is beaten, so the whole campaign would end after one mission with
 * nothing anywhere saying why.
 *
 * AN EMPTY LIST IS FATAL TOO, and says something different: the manifest was
 * found and names nothing, so the build published no levels. The runner refuses
 * to be constructed without one, and that throw is a caller's mistake with no
 * sentence a player can read — this is the sentence.
 */
async function fetchLevelNames(url: string): Promise<readonly string[]> {
  const json = await fetchJson(
    url,
    'level manifest',
    `Expected public/generated/levels/${LEVELS_MANIFEST_FILE} to be published with the build — run \`npm run import:levels\`.`,
  )
  const levels: unknown = (json as { levels?: unknown } | null)?.levels
  if (!Array.isArray(levels) || levels.some((name) => typeof name !== 'string' || name === '')) {
    throw new BootError(
      'The level manifest is not a list of levels',
      `${url} was served and parsed, but it does not hold a "levels" array of names.`,
      `Expected {"levels": ["level1", ...]}, got ${JSON.stringify(json)?.slice(0, 200) ?? 'undefined'}`,
    )
  }
  if (levels.length === 0) {
    throw new BootError(
      'This build has no levels',
      `${url} names no levels at all, so there is no campaign to play.`,
      'The manifest holds an empty "levels" array — run `npm run import:levels` over the level sources.',
    )
  }
  return levels as readonly string[]
}

async function fetchLevel(url: string): Promise<LevelData> {
  const json = await fetchJson(
    url,
    'level file',
    `Expected ${url} to be published with the build; the level manifest names it.`,
  )

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
 * Load the tiling ground textures (ticket 009c; three of them since 034).
 *
 * A missing ground texture stops the boot for the same reason a missing atlas
 * does: the alternative is a map whose terrain is untextured or black, which is
 * the silent, plausible-looking failure the overlay exists to prevent. And no
 * texture falls back to another — a river drawn as jungle floor would be the
 * plausible-looking failure rather than the visible one. The terrain constructor
 * requires all three, so this is enforced by the types as well as by the boot
 * order.
 */
async function fetchGround(
  manifest: SpriteManifest,
  url: string,
  maxAnisotropy: number,
): Promise<Record<GroundSurface, THREE.Texture>> {
  try {
    return await loadGroundTextures(manifest, url, maxAnisotropy)
  } catch (cause) {
    if (cause instanceof GroundTextureError) {
      throw new BootError(
        'The ground textures could not be loaded',
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

  // The level manifest and the sprite manifest at once: they are independent,
  // and serialising them would put a whole extra round trip in front of the
  // first frame. The level DOCUMENTS cannot join them — the manifest is what
  // names them — so they are the next hop, and the two images the sprite
  // manifest feeds are loaded in parallel after that.
  const [levelNames, manifest] = await Promise.all([
    fetchLevelNames(MANIFEST_URL),
    fetchManifest(SPRITES_URL),
  ])
  /**
   * EVERY PUBLISHED LEVEL, IN THE MANIFEST'S ORDER (ticket 024).
   *
   * ALL OF THEM AND NOT JUST THE FIRST. `campaignComplete(unlockedLevels,
   * levels.length)` is what ends the campaign, so a page that fetched one level
   * ended the whole campaign after one mission — the failure this ticket
   * removes. NO COUNT IS WRITTEN DOWN HERE: however many the manifest lists is
   * how many there are, today and when ticket 023 publishes more.
   *
   * IN PARALLEL, AND ONE FAILURE IS FATAL. `Promise.all` rejects on the first
   * bad document, which is right: a campaign missing its third level is a
   * campaign that dies three missions in, and the boot overlay can say so now
   * rather than the player finding out then.
   */
  const levels = await Promise.all(
    levelNames.map((name) => fetchLevel(`${LEVELS_DIR}/${name}.json`)),
  )
  const [visual, ground] = await Promise.all([
    fetchVisual(manifest, SPRITES_URL),
    fetchGround(manifest, SPRITES_URL, renderer.capabilities.getMaxAnisotropy()),
  ])

  const firstLevel = levels[0]
  // Unreachable: `fetchLevelNames` refuses an empty manifest with its own named
  // error. Written out rather than asserted away because
  // `noUncheckedIndexedAccess` is right that an index is not a proof.
  if (firstLevel === undefined) {
    throw new BootError(
      'This build has no levels',
      'The level manifest was read but produced no levels to load.',
      'levels[] was empty after fetching every name in the manifest.',
    )
  }

  // The simulation. Everything that decides what happens in the world lives on
  // the far side of this call — see `core/session` — so what is left here is the
  // browser's half: a frame delta in, a list of drawables and an alpha out.
  //
  // A `let`, because `startMission()` replaces it. Every closure below reads the
  // variable rather than capturing the object, so a restarted mission is picked
  // up by the render loop, the scene builder and the HUD without any of them
  // being rebuilt — and without the page reload that would cost the player the
  // level fetch, the atlas decode and his camera position.
  let session = createSession(firstLevel)

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

  /**
   * The live effects (ticket 025): the flashes, bursts and death puffs this
   * frame's events produced, stamped with the RENDERER's clock.
   *
   * EVERYTHING SAID ABOUT `tracers` ABOVE APPLIES HERE WORD FOR WORD — the clock
   * it is stamped against, why it is a `let`, and why none of it can reach a
   * mission result. The FX layer reads EVENTS ONLY: it is fed below from
   * `ShotFired`, `Explosion` and `UnitDied` after the sim has already decided
   * them, so a mission's `stateHash` over a fixed script is identical whether
   * these two buffers are fed or left empty.
   */
  let effects = createFxBuffer()

  /**
   * EVERYTHING ON SCREEN THAT BELONGS TO ONE LEVEL (ticket 024).
   *
   * A `let`, and rebuilt by `startMission` when the campaign moves to a level
   * this page is not currently showing. Until this ticket the page fetched one
   * document and the scene was built for it once, which was true right up to the
   * moment there was a second level to reach: the session would simulate level 2
   * while the canvas still showed level 1's terrain, the camera clamped to level
   * 1's bounds, and a click would be mapped through level 1's tile grid — and if
   * the two levels are different sizes the height sampler is asked for tiles
   * that do not exist.
   *
   * WHY IT IS A BUNDLE AND NOT SIX VARIABLES: every field here is a function of
   * the level and none of them can be updated in place — `CameraRig` takes its
   * bounds and relief at construction, and the controllers hold the rig by
   * reference. One value means "swap the level" is one assignment and one
   * disposal, rather than six that a later edit can forget one of.
   *
   * WHAT IS NOT IN IT: the atlas, the ground textures and the HUD, which are
   * loaded once for the page and outlive any level.
   */
  let stage = buildStage(firstLevel)

  interface Stage {
    readonly level: LevelData
    readonly built: BuiltScene
    readonly tracerFx: TracerRenderer
    readonly effectFx: FxRenderer
    readonly rig: CameraRig
    readonly pan: PanController
    readonly zoom: ZoomController
  }

  function buildStage(level: LevelData): Stage {
    const built = SceneBuilder.build(level, visual, ground, elevation, (heightAt) =>
      session.renderEntities(heightAt),
    )
    // Sized from the buffer's own capacity, which is what lets the geometry be
    // allocated once and never grown. See `TracerRenderer`. `built` is read
    // directly rather than through `stage`, which is still the OLD stage while
    // this runs.
    const tracerFx = new TracerRenderer({
      size: level.size,
      heightAt: (tileX, tileY) => built.terrain.heightAt(tileX, tileY),
      capacity: tracers.capacity,
    })
    built.scene.add(tracerFx.object)

    // ONE RENDERER SINCE TICKET 047. There were two, added in a fixed order so a
    // burst composited over its own scorch mark rather than under it, and they
    // could not be one because they differed in the thing a material cannot vary
    // per effect: a scar was PAINT and a flash is LIGHT. The scars are gone and
    // everything left is light. Sized from its buffer's capacity, which is what
    // lets the geometry be allocated once and never grown.
    //
    // `built.terrain` directly and not `groundHeightAt`, which reads `stage` —
    // still the OLD stage while this runs.
    const fxGround = {
      size: level.size,
      heightAt: (tileX: number, tileY: number) => built.terrain.heightAt(tileX, tileY),
    }
    const effectFx = createFxRenderer({ capacity: effects.capacity, ground: fxGround })
    built.scene.add(effectFx.object)

    // The rig reasons about the level's SILHOUETTE, not its footprint: the
    // terrain is extruded, so the zoom cap has to know how far this particular
    // level's tiles rise and fall — raised terrain at the far edge is what would
    // otherwise leave background above it. Measured from the level's own data —
    // heights are data, and a constant here would quietly stop covering the map
    // the day mapgen emits something taller.
    const rig = new CameraRig(
      built.bounds,
      { width: window.innerWidth, height: window.innerHeight },
      elevation,
      levelRelief(level),
    )
    rig.snapTo(initialFocus(level))

    // Both controllers register window-level listeners and hold a hard reference
    // to the rig, so both must be kept and disposed with the stage: a leaked
    // controller would keep driving the dead rig — doubling every pan and zoom
    // step for the rest of the page's life.
    const pan = new PanController(rig)
    const zoom = new ZoomController(rig, window, renderer.domElement)
    return { level, built, tracerFx, effectFx, rig, pan, zoom }
  }

  /**
   * Release the GPU resources and window listeners a stage OWNS.
   *
   * Not the atlas visual and not the ground textures: they are passed in to every
   * stage and outlive all of them, so they are freed by `teardown` instead.
   */
  function disposeStage(old: Stage): void {
    old.zoom.dispose()
    old.pan.dispose()
    // Its own geometry and material, added to the scene from out here — so
    // `built.dispose()` does not know about them.
    old.tracerFx.dispose()
    old.effectFx.dispose()
    old.built.dispose()
  }

  /** Feet sit on the top face of the tile they stand on, not on the ground plane. */
  function groundHeightAt(tileX: number, tileY: number): number {
    return stage.built.terrain.heightAt(tileX, tileY)
  }

  // The only input path into the simulation: a click on the canvas becomes a
  // `Command` on the session's queue, which the tick drains. The selection is
  // handed in as a function and asked afresh at every click, so an order always
  // goes to the men who are alive when it is given.
  //
  // REBUILT ON RESTART, not reused: it holds the OLD session's command queue by
  // reference, and orders pushed onto a queue nothing drains are orders the new
  // squad never hears. It also holds the stage's camera and the level's tile
  // grid, so a stage swap has to rebuild it for a second reason.
  let pointer = newPointer()

  function newPointer(): PointerController {
    return new PointerController(
      renderer.domElement,
      stage.rig.camera,
      session.queue,
      stage.level.size,
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
    /**
     * M MUTES, AND IT IS THE ONLY WAY TO (ticket 027).
     *
     * `AudioBus` shipped `setMuted` and `setVolume` and a `localStorage` round
     * trip for both, and NOTHING CALLED EITHER — so acceptance criterion 7
     * ("master mute/volume persists across sessions") was satisfied by code that
     * could not be reached. Adversarial review found it by grepping for the call
     * sites and finding none.
     *
     * A key rather than a HUD control because the HUD is ticket 022's surface
     * and this is not the ticket that redesigns it; M is the near-universal
     * convention and costs no screen space. It rides `onSelectKey` because that
     * handler already owns the bare-keydown, not-in-a-text-field contract, and a
     * second `keydown` listener would be a second thing to remember to remove in
     * `teardown` — which is exactly the leak the comment there warns about.
     */
    if (event.code === 'KeyM') {
      event.preventDefault()
      audio.setMuted(!audio.muted)
      return
    }
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
    stage.rig.resize(window.innerWidth, window.innerHeight)
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
   * The audio bus (ticket 027).
   *
   * ONE PER PAGE, NOT ONE PER MISSION — unlike the tracer and FX buffers above,
   * and for the opposite reason. Those are stamped against `elapsed`, which
   * `startMission` puts back to zero; the bus is stamped against the
   * `AudioContext`'s own clock, which is monotonic for the life of the page and
   * has no mission in it. Rebuilding it per mission would tear down and rebuild
   * the graph — and re-decode 10.4 MB of samples — between every level.
   *
   * IT MAKES NO NOISE UNTIL THE PLAYER TOUCHES SOMETHING. The context is not
   * constructed until the first gesture (see `src/audio/index.ts`), so this line
   * costs the boot nothing and logs no autoplay warning.
   */
  const audio = createAudioBus()

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
  const debugRequested = new URLSearchParams(window.location.search).get('debug') === '1'

  /**
   * Attach the overlay to the CURRENT stage, replacing any earlier one.
   *
   * CALLED AGAIN AFTER A STAGE SWAP (ticket 024), because the overlay takes the
   * scene, the tile size and the height sampler at attach time and adds its
   * group to that scene. Left alone across a level change it would be drawing
   * into a disposed scene with the previous level's dimensions — an overlay that
   * is invisible and wrong at the same time. The dynamic import is cached after
   * the first call, so re-attaching costs a microtask and no download.
   */
  function attachDebugOverlay(): void {
    if (!debugRequested) return
    void import('./debug-mode')
      .then((module) => {
        // The teardown may have run while the chunk was in flight; attaching
        // then would add a key listener to a page that is already dead.
        if (stopped) return
        // The previous overlay goes first: two attached at once means two key
        // listeners, and a layer toggle that switches a layer on and straight
        // back off again.
        debug?.dispose()
        debug = module.attachDebugMode({
          mount,
          scene: stage.built.scene,
          renderer,
          size: stage.level.size,
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

  attachDebugOverlay()

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
   * Who the sustained gunfire voice is following, held ACROSS frames (ticket 044).
   *
   * IT HAS TO OUTLIVE A FRAME, and that is not an optimisation. `drawables` is
   * rebuilt only on a frame that actually stepped the simulation — above 60 Hz
   * most frames step nothing at all — so recomputing this from `drawables`
   * inline would hand `firingCue` an EMPTY list on most frames and answer
   * `null`, which is the instruction to stop. On a 120 Hz display that is the
   * gunfire cut off and restarted every other frame: a stutter that would read
   * as a broken sample rather than as a wiring bug.
   *
   * So it is recomputed only when there is fresh state to compute it FROM, and
   * replayed against a fresh listener every frame — which is also what keeps the
   * pan tracking a camera the player is panning while nobody is shooting anew.
   *
   * CLEARED WITH `missionLog`, so one mission's firefight cannot follow the
   * player into the next one's opening frame.
   */
  let firingVoice: CueRequest | null = null

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
     * THE STAGE. The terrain, the atlas and the ground stay up behind Boot Hill
     * and the Briefing; disposing them here would leave nothing to come back to
     * and a black canvas behind both. The stage is swapped by `startMission` when the
     * campaign moves to a DIFFERENT level, and freed for good by `teardown()`
     * below, which ends the page rather than the mission.
     *
     * THE POINTER IS DISPOSED HERE AND AGAIN IN `startMission`, AND BOTH CALLS
     * ARE DELIBERATE. `dispose` is idempotent, so the pair is safe. This one
     * exists because the pointer holds the finished session's command queue by
     * reference and the mission it would push orders onto is over — the player
     * sits on Boot Hill and the Briefing for minutes, and a live pointer over a
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
   * below. The stage outlives the session by design; only the simulation and the
   * things holding a reference into it are replaced.
   *
   * `next` IS HONOURED, AND SINCE TICKET 024 IT CAN ACTUALLY DIFFER. The page
   * loads every published level, so beating level 1 deploys level 2 into this
   * same page — and the stage is rebuilt for it. Rebuilt only when the document
   * CHANGES: replaying the level already on screen would otherwise throw away a
   * terrain mesh and an atlas binding to build an identical one, and reset the
   * camera the player just placed.
   */
  function startMission(next: LevelData, squad: readonly SquadMember[]): void {
    // THE SCREENS ARE NOT TOUCHED HERE (ticket 022b). The Briefing is still on
    // the page at this instant — `deploy()` starts the mission and only then
    // moves the screen — and `reconcile` takes it down a moment later off the
    // runner's own state. A mission that disposed screens itself would be a
    // second owner of the one slot, disagreeing with the router the first time a
    // command was refused.
    // EMPTIED FOR THE NEW MISSION, so the men who died in the last one are not
    // buried a second time in this one's report. Nothing subtle about the
    // placement — this function is synchronous, so no frame can run between here
    // and the `createSession` below; it sits next to its session for reading.
    missionLog = []
    // With the log, and for the same reason: the last mission's shooting must
    // not be what the next one's first frame is still following.
    firingVoice = null
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
    // AND THE EFFECTS WITH THEM, for exactly the reason above: an effect's age is
    // `elapsed - spawnedAt`, so a burst from the mission that just ended would sit
    // at a `spawnedAt` in the future of a clock that has just gone back to zero —
    // an age the buffer floors to "brand new" and which therefore never fades.
    // The new level would open under the last one's explosions.
    effects = createFxBuffer()
    // THE STAGE, IF THE LEVEL CHANGED (ticket 024). Compared by identity, which
    // is exact here: `levels` holds one object per published level and the
    // runner hands back an element of it, so "the same level" is the same
    // object. AFTER the session is replaced, because the new scene seeds its
    // first frame of entities from it, and after the tracer buffer, because the
    // new tracer geometry is sized from that buffer's capacity.
    if (next !== stage.level) {
      // The overlay holds the outgoing scene; it is dropped before that scene is
      // disposed and re-attached to the new one below.
      debug?.dispose()
      debug = undefined
      disposeStage(stage)
      stage = buildStage(next)
      attachDebugOverlay()
    }
    stage.tracerFx.update(tracers.visible(elapsed))
    // Emptied on the same frame the buffers were, so a stage that was NOT rebuilt
    // — the campaign replaying the level it is already showing — does not keep
    // last mission's geometry on screen until the first frame that draws.
    stage.effectFx.update(effects.visible(elapsed))
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
    stage.built.entities.setEntities(fresh)
    stage.built.entities.setEntities(fresh)
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
    hud.dispose()
    // Its own window listeners (the gesture it is waiting for), its own live
    // sources and the audio hardware itself — none of which anything else here
    // knows about. A leaked bus goes on playing the dead session's last voices
    // over the fatal-error screen.
    audio.dispose()
    // Cancels its pending timers as well as removing it, so a torn-down page has
    // nothing left to fire.
    hint?.dismiss()
    pointer.dispose()
    // The scene, the tracer geometry, the rig's two controllers — one call,
    // because a stage is one thing. Whichever level is on screen is the one
    // freed; the stages before it were freed as they were swapped out.
    disposeStage(stage)
    // Owned here, not by the terrain or the entity renderer: both are loaded
    // once for the session and outlive any single level (ticket 020), so they
    // are freed with the session and not with the stage that happens to be up.
    for (const texture of Object.values(ground)) texture.dispose()
    visual.dispose()
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
   * EVERY PUBLISHED LEVEL (ticket 024), in the manifest's order. `levelIndex` is
   * derived from the campaign's own `unlockedLevels` against this list's length
   * and `campaignComplete` compares against the same length, so the campaign is
   * exactly as long as the manifest says — no count is written down anywhere.
   */
  const runner = createCampaignRunner({
    levels,
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
   * up whichever screen follows.
   *
   * IT MOUNTS NOTHING ITSELF, for the reason `reconcile` gives — and since
   * ticket 040 that matters more than it did. A win lands on Boot Hill and a
   * loss back on the Briefing, and which of those happened is `missionReport`'s
   * answer rather than anything this file saw; asking the runner afterwards is
   * that same answer with none of the risk of guessing it. A refused
   * `finishMission` leaves the mission on screen rather than putting a memorial
   * over a campaign that recorded nothing.
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
   * into the console. Since ticket 040 no screen prints a refusal of its own:
   * the one that did was Recruitment, and nothing on the three that remain asks
   * the player for anything a command can reject.
   *
   * A `switch` over `ViewId` and not a lookup object, so the compiler is the
   * thing that notices when `core/flow` gains a view: the return type makes a
   * missing arm an error here rather than a blank page in a browser.
   */
  function mountView(view: ViewId): { dispose(): void } | undefined {
    switch (view) {
      case 'menu': {
        const menu = createMenu(mount, {
          // THE NOTICE, SHOWN AT LAST. `runner.notice()` has existed since
          // ticket 019 and until now went nowhere a player would ever look; a
          // save that was damaged or could not be written is the one thing this
          // screen must not keep to itself.
          notice: runner.notice(),
          // THE END OF THE CAMPAIGN (ticket 024). `BootHill -> Menu` on
          // `campaignComplete` already lands the player here; both of these are
          // computed in `core` so the screen only draws them.
          summary: runner.summary(),
          campaignOver: runner.isCampaignOver(),
          // TICKET 046. Whether the button reads "Start" or "Continue" — asked
          // of the runner beside the other two, for the same reason.
          campaignUnderway: runner.isCampaignUnderway(),
          onStart: () => {
            announce(runner.startCampaign(), 'starting the campaign')
            reconcile()
          },
          onRestart: () => {
            /**
             * THE CLOCK IS READ HERE AND NOWHERE ELSE. `core` has no clock, so a
             * restart with no seed produces the same twelve names a first run
             * did — deterministic and a little sad. `app/` is allowed to be the
             * one that makes a new campaign feel new.
             */
            announce(runner.restartCampaign(Date.now()), 'restarting the campaign')
            // REDRAWN BY HAND, because a restart does not change the SCREEN: the
            // player was on the Menu and is still on the Menu, so `reconcile`
            // takes its early return and the panel would go on showing the
            // totals and the graves of the campaign that was just erased.
            menu.update({
              notice: runner.notice(),
              summary: runner.summary(),
              campaignOver: runner.isCampaignOver(),
              // A wipe puts the player back in front of a campaign with no
              // history, so the button has to go back to saying "Start".
              campaignUnderway: runner.isCampaignUnderway(),
            })
            reconcile()
          },
        })
        return menu
      }
      case 'briefing':
        return createBriefing(mount, {
          model: runner.briefing(),
          onDeploy: () => {
            announce(runner.deploy(), 'deploying')
            reconcile()
          },
        })
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
    // either has happened, so it does not linger over the mission card.
    else hint?.dismiss()
    // Already right. The early return is what makes a refused command free —
    // without it a redraw would tear down the screen the player is looking at
    // and put an identical one back, taking his keyboard focus with it.
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
      stage.pan.update(dt)
      stage.rig.update(dt)
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
      // KEPT, NOT JUST HANDED OVER (ticket 025). `UnitDied` names an id and no
      // position — the entity is already out of the world by the time the event
      // is read — so the death effect is placed from this frame's drawables,
      // which still contain the man as a CORPSE for as long as his death clip
      // runs (see `Session.renderEntities`). Reading the drawables rather than
      // the world is the FX layer staying on the presentation side of the
      // boundary: it asks what is being drawn, never what is true.
      /**
       * WHERE THE EAR IS, for this frame's positional cues.
       *
       * The rig's yaw is zero, so `camera.right` is exactly half the visible
       * world width along X and `rig.target` is the point the view is centred
       * on — which is what `panFor` and `gainFor` want, and why neither needed a
       * camera passed into `core`. Read ONCE per frame rather than per event: a
       * volley is a dozen events against one camera position.
       *
       * READ BEFORE THE DRAWABLES ARE BUILT since ticket 044, because choosing
       * which firing man the sustained voice follows is a question about
       * distance from the ear, and that choice is made in the same block.
       */
      const focus = stage.rig.target
      const listener = { x: focus.x, z: focus.z, halfWidth: stage.rig.camera.right }
      let drawables: readonly RenderEntity[] = []
      if (session.stepsLastAdvance > 0) {
        drawables = session.renderEntities(groundHeightAt)
        stage.built.entities.setEntities(drawables)
        // RECOMPUTED ONLY HERE, where there is fresh state to compute it from.
        // See `firingVoice`: `drawables` is empty on a frame that ran no steps,
        // and asking `firingCue` about an empty list answers "stop".
        firingVoice = firingCue(
          drawables.filter((entity) => entity.firing === true),
          listener,
        )
      }
      // Drained every frame whether or not anything is listening yet: the batch
      // is the only channel out of the sim, and left undrained it would grow
      // for the length of the mission. The reason is kept because the event
      // fires once and the screen it explains outlives it by minutes.
      // ONLY WHILE THE MISSION IS ON, and off the same guard `endMission` uses
      // below rather than a second flag of this file's. The session keeps
      // stepping and keeps emitting for as long as the player leaves Boot Hill
      // or the mission card up, and a log that kept growing after the report it feeds
      // was written is an array with no bound and no reader — the pre-022a loop
      // discarded those events. `endMission` runs after this drain, so the final
      // frame's `MissionComplete` is still logged on the frame it lands.
      /**
       * ON SCREEN AT ALL, which gates the FX below as well as the log.
       *
       * The session keeps stepping behind the Debrief and Boot Hill — that is
       * deliberate and the HUD already skips its update for it. The FX layer did
       * not, so `addShake` went on kicking the camera under an end-of-mission
       * panel and effects burned through their lifetimes where nobody could see
       * them. Both are invisible bugs in the literal sense: the only symptom is a
       * view that will not sit still behind a screen that is supposed to be calm.
       *
       * The LOG is a separate question and keeps its own name: it is about which
       * events belong to the mission being summarised, not about what is drawn.
       */
      const onMission = runner.screen() === 'Mission'
      const logging = onMission
      for (const event of session.events()) {
        // KEPT, NOT JUST READ (ticket 022a). The batch is the only channel out
        // of the sim and it is drained once; the campaign needs the whole
        // mission's worth at the end of it. See `missionLog`.
        if (logging) missionLog.push(event)
        /**
         * THE SOUND, OFF THE SAME DRAINED BATCH AS THE FX (ticket 027).
         *
         * `cueFor` decides which cue and where; `audio.play` decides nothing and
         * skips a cue with no asset, a cue out of earshot, and everything at all
         * before the first user gesture. It cannot throw, which matters here —
         * this runs inside the render loop's `try`, and a sound that took the
         * frame down would end the mission.
         *
         * THE MISSION-END CUES ARE EXEMPT FROM `onMission`, and that exemption is
         * the point of them. Everything else is gated for the reason the FX above
         * are: the session keeps stepping behind Boot Hill and the Briefing, and
         * rifles firing under an end-of-mission screen are a fault. But victory
         * and defeat are what those screens are FOR — and they land on the very
         * frame the mission ends, which `endMission` (below this loop) turns into
         * a screen change a moment later.
         */
        const cue =
          onMission || event.type === 'MissionComplete' || event.type === 'MissionFailed'
            ? cueFor(event)
            : null
        if (cue !== null) {
          /**
           * A DEATH IS PLACED FROM THE CORPSE.
           *
           * `UnitDiedEvent` reports `id`, `team` and the killer and NOT where he
           * fell, so `cueFor` cannot give the cue a position and correctly does
           * not invent one. Left at that, every death anywhere on a ninety-two
           * tile map played dead centre at full gain — louder than a rifle at
           * the player's feet, with the distance falloff never consulted at all.
           *
           * THIS IS NOW THE ONLY READER OF THAT LOOKUP. The FX layer did the same
           * thing two branches below to place its red puff (ticket 025), and the
           * two deliberately shared the technique; ticket 051 deleted the puff,
           * and the sound kept the lookup because the sound was always the half
           * that needed it. A frame that ran no step produces no drawables, so an
           * unplaceable death still falls back to an unpositioned cue rather than
           * to the origin of the map.
           */
          const placed =
            cue.cue === 'death'
              ? (() => {
                  const body = drawables.find((entity) => entity.id === (event as { id: number }).id)
                  return body === undefined ? cue : { ...cue, x: body.x, z: body.z }
                })()
              : cue
          audio.play(placed, listener)
        }
        // ONE TRACER PER ROUND, from the event's own endpoints. Ticket 011a
        // already clamps the far end to the near face of whatever the round
        // meets, so a tracer drawn to `targetX`/`targetZ` stops at the wall
        // without a line of geometry code asking whether it should.
        //
        // AN `if`, NOT AN `else if`: ticket 040 deleted the `MissionFailed`
        // branch that used to head this chain (the Debrief it stashed the reason
        // for is gone), so there is no longer a preceding arm to chain onto.
        if (onMission && event.type === 'ShotFired') {
          tracers.add(event, elapsed)
          // AND A FLASH AT THE BARREL. The tracer says where the round went; the
          // flash says who fired it, and a miss fires both — see `ShotFired.hit`.
          effects.add({ kind: 'muzzle', x: event.originX, z: event.originZ, scale: 1 }, elapsed)
        }
        // A BURST AND A KICK, both from the one event and neither asking the
        // world anything: `Explosion` already carries the position it actually
        // went off at and the radius it went off with (ticket 015). There was a
        // scar between them until ticket 047 — a dark quad stamped on the ground
        // for 45 s, which read as a coloured square rather than as scorched
        // earth.
        else if (onMission && event.type === 'Explosion') {
          // SCALED BY THE BLAST'S OWN RADIUS, so a rocket and a grenade are
          // visibly different sizes and the effect covers the ground the
          // ordnance actually damaged rather than a number chosen here.
          // AND AT THE HEIGHT IT WENT OFF AT. A grenade whose fuse expires before
          // impact detonates in mid-air, and `ExplosionEvent` says in capitals
          // that an airburst reported on the ground hides the whole mechanic —
          // so the one thing the event goes out of its way to carry is drawn.
          effects.add(
            { kind: 'burst', x: event.x, y: event.y, z: event.z, scale: event.radiusTiles },
            elapsed,
          )
          // THE CALL `camera-rig.ts` HAS BEEN WAITING FOR SINCE TICKET 013. The
          // distance is measured from where the camera is looking NOW rather
          // than from the level's centre: a blast under the squad the player is
          // watching should shake, and the identical blast four screens away
          // must not. `shakeFor` is bounded and never returns NaN, which matters
          // because the rig takes the STRONGEST request and no later check can
          // undo one that got in.
          // `focus` is this frame's camera centre, read once above the loop for
          // the audio listener — the same point this used to read for itself.
          stage.rig.addShake(
            shakeFor(Math.hypot(event.x - focus.x, event.z - focus.z), event.radiusTiles),
          )
        }
      }
      /**
       * THE GUNFIRE, WHICH IS A STATE AND NOT AN EVENT (ticket 044).
       *
       * OUTSIDE THE EVENT LOOP AND RUN ON EVERY FRAME, INCLUDING QUIET ONES.
       * That is the whole shape of the fix: a sound that stops when the trigger
       * is released cannot be driven by `ShotFired`, which is a discrete thing
       * that has already happened. `firingCue` is handed everybody who is firing
       * NOW and answers with what should be sounding NOW — and `null`, which
       * only arrives if this is called on the frames when nobody is shooting, is
       * the instruction to stop.
       *
       * OFF `drawables`, so the sound and the picture are the same fact. The
       * `firing` flag is decided once in `core/session` and drives the fire
       * animation as well; reading `animation === 'fire'` here instead would be
       * a second rule that agreed until somebody added a clip.
       *
       * GATED ON `onMission` like the FX and the rest of the cues: the session
       * keeps stepping behind Boot Hill and the mission card, and a firefight
       * audible under an end-of-mission screen is the same fault there as a
       * tracer would be. It also means the loop is stopped by the screen change
       * itself, rather than running on under it.
       */
      audio.sustain(onMission ? firingVoice : null, listener)
      // NOT UPDATED WHILE HIDDEN. The session keeps stepping behind Boot Hill
      // and the mission card, so this would go on writing a clock and a roster nobody
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
      // is over exactly once, and there is no row that leaves `Mission` and
      // comes back to it in one step. An `ending === undefined` check would have
      // said the same thing until the screen after it was dismissed, at which
      // point it would fire again over a mission that had already been recorded
      // — and the campaign would bury the same men twice.
      if (outcome !== 'playing' && runner.screen() === 'Mission') endMission()
      stage.built.entities.update(elapsed, alpha)
      // EVERY FRAME, not only on a stepping one: a tracer fades on the display's
      // clock, so a frame that ran no simulation step still has to redraw the
      // streaks a little dimmer than it found them.
      stage.tracerFx.update(tracers.visible(elapsed))
      // AND THE EFFECTS, on the same clock and for the same reason: a burst
      // fades on the display's clock, so a frame that ran no simulation step
      // still has to redraw it a little dimmer than it found it.
      stage.effectFx.update(effects.visible(elapsed))
      // BEFORE the render, so this frame draws what this frame decided. Absent
      // `?debug=1` this is one optional-call check per frame and no debug module
      // was ever fetched, let alone evaluated.
      debug?.update()
      renderer.render(stage.built.scene, stage.rig.camera)
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
    `game-week: ${stage.level.name} ${String(stage.level.size.w)}x${String(stage.level.size.h)} ` +
      `(${String(stage.built.terrain.triangleCount)} tris, ` +
      `${String(stage.built.entities.drawCalls)} sprite draws, ` +
      // The campaign's length, so a manifest that shrank is visible in the
      // console of a build that otherwise looks fine.
      `${String(levels.length)} level(s), ` +
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
