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
import { CameraRig } from '../render/camera-rig'
import { SceneBuilder } from '../render/scene-builder'
import { PanController } from '../input/pan-controller'
import { ZoomController } from '../input/zoom-controller'
import { showControlHint } from '../ui/control-hint'
import { showFatalError, type FatalErrorReport } from '../ui/error-overlay'
import { CORE_VERSION } from '../core/version'

/**
 * Relative on purpose: `vite.config.ts` sets `base: './'`, so the built page may
 * be served from any path (Vercel root, a preview subdirectory, `file://`). A
 * leading slash would break every one of those but the root.
 */
const LEVEL_URL = './generated/levels/level1.json'

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

  const level = await fetchLevel(LEVEL_URL)
  const built = SceneBuilder.build(level)

  // `?elev=` is a look-tuning knob, not a game setting: the camera angle is a
  // judgement against the source art and the only way to settle it is to look at
  // it, so it is adjustable without a rebuild. Garbage falls back to the default.
  const elevation = parseElevation(new URLSearchParams(window.location.search).get('elev'))

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

  const onResize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight)
    rig.resize(window.innerWidth, window.innerHeight)
  }

  /** Tear the whole session down: loop, listeners, controllers, GPU resources. */
  const teardown = (): void => {
    renderer.setAnimationLoop(null)
    window.removeEventListener('resize', onResize)
    zoom.dispose()
    pan.dispose()
    built.dispose()
  }

  // "F to zoom out", not "F to fit": since ticket 009b the zoom-out limit stops
  // at the widest view that shows no background, which is deliberately short of
  // the whole level. A hint that still promised a fit would be a lie.
  showControlHint(
    mount,
    'WASD / arrows or screen edge to pan  ·  wheel or +/− to zoom  ·  F to zoom out fully',
  )

  window.addEventListener('resize', onResize)

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

  let previous = performance.now()
  renderer.setAnimationLoop((now) => {
    // A throw here repeats every frame and is invisible behind a frozen canvas.
    // Stop the loop on the first one and say so on screen instead.
    try {
      const dt = Math.min((now - previous) / 1000, MAX_FRAME_DT)
      previous = now
      pan.update(dt)
      rig.update(dt)
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
      `(${String(built.terrain.triangleCount)} tris, camera ${((elevation * 180) / Math.PI).toFixed(1)}°, ` +
      `core ${CORE_VERSION})`,
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
