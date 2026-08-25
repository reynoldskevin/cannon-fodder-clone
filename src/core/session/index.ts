/**
 * The session (ticket 008a): the wiring that turns a level into a running game.
 *
 * Nine tickets' worth of tested machinery — `World`, the fixed-timestep
 * `GameLoop`, the nav grid, the squad system, the combat system, the command
 * queue — existed before this file and none of it ran, because nothing built a
 * `World` and registered a system on it. This is that assembly, and it is
 * deliberately NOT in `src/app/main.ts`: `boot()` needs a DOM, a WebGL context
 * and two network fetches, so anything buried in it is verified only by looking
 * at the screen. Here it is a plain object with plain methods and the whole of
 * it is tested in `__tests__/` under Node.
 *
 * Engine-free like the rest of `src/core`: no `three`, no DOM, no clock read.
 * Real elapsed seconds arrive as the `dt` argument to `advance`, which is the
 * same division of labour `core/world/gameloop.ts` is built on.
 *
 * WHAT `main.ts` IS LEFT WITH. Building the session, pushing the frame delta
 * into `advance`, handing `renderEntities()` to the renderer and feeding the
 * returned alpha to it. Everything that decides what happens in the world is on
 * this side of the boundary.
 */

import { applyCommand, createCommandQueue } from '../command'
import { createCombatSystem } from '../combat'
import { bakeNavGrid } from '../pathing'
import { createSquadSystem } from '../squad'
import { createGameLoop, EMPTY_EVENTS, FIXED_TIMESTEP } from '../world'
import { World } from '../world'
import { worldToTile } from '../view/projection'
import { propRenderEntities } from './props'
import type { CombatOptions, CombatSystem } from '../combat'
import type { CommandQueue } from '../command'
import type { LevelData } from '../level'
import type { NavGrid } from '../pathing'
import type { RenderEntity } from '../render-state/entity'
import type { SquadOptions, SquadSystem } from '../squad'
import type { TileCoord } from '../view/projection'
import type { Entity, SimEvent, Team } from '../world'

/** How the ground height under a tile is sampled. Supplied by the terrain. */
export type GroundHeightAt = (tileX: number, tileY: number) => number

/** Everything the session needs that is not the level itself. */
export interface SessionOptions {
  /** Mission seed. The same seed, level and commands replay identically. */
  readonly seed?: number
  /** Movement tuning, passed straight to `createSquadSystem`. */
  readonly squad?: SquadOptions
  /**
   * Combat tuning. Passed to `createCombatSystem` OVER a default of
   * `autoEngageTeams: ['enemy']` — the session's own decision that the player
   * squad holds fire — so every other field arrives untouched and that one is a
   * default a caller may replace. See where it is passed, in `createSession`.
   */
  readonly combat?: CombatOptions
}

/** A running mission: the world, the loop driving it, and its render state. */
export interface Session {
  /** The simulation. Public because tests and the HUD read entity state off it. */
  readonly world: World
  /** Where commands are pushed. Drained at the top of every simulation step. */
  readonly queue: CommandQueue
  /** The squad pass, kept for `order`/`targetOf` as well as for the tick. */
  readonly squad: SquadSystem
  /**
   * The combat pass, kept for the fire orders as well as for the tick: the
   * command layer sends `fire`/`ceaseFire` here, and the HUD can ask `isFiring`.
   */
  readonly combat: CombatSystem
  /** The baked passability grid both systems path and sight against. */
  readonly grid: NavGrid
  /**
   * The registration order of the simulation systems, DECLARED.
   *
   * A statement of the decision `createSession` made, readable without following
   * the `addSystem` calls; it is not itself evidence that the world runs them in
   * that order. The behaviour is pinned separately, by the test that puts a unit
   * under a move order AND a fire order at once and reads `ShotFired.originX`
   * off a round he fires WHILE WALKING: the origin is where this tick's step
   * left him, which proves combat saw the position squad wrote the same step.
   */
  readonly systemOrder: readonly string[]
  /**
   * How many fixed steps the most recent `advance` actually ran: 0 for a frame
   * too short to buy one, `MAX_STEPS_PER_FRAME` for one long enough to be
   * capped, 0 for a frame rejected outright.
   *
   * The renderer holds two sim states and blends them by `alpha`, so it must be
   * handed new state only on a frame that produced some. Above 60 Hz most frames
   * run no steps, and pushing state on those makes the two states identical —
   * `alpha` then interpolates a state with itself and the motion it exists to
   * smooth is gone. This is how the caller tells the two kinds of frame apart.
   */
  readonly stepsLastAdvance: number
  /**
   * Fold `dt` real seconds into the fixed-timestep loop, run the steps it buys,
   * and return the interpolation alpha in [0, 1) for the renderer.
   */
  advance(dt: number): number
  /**
   * The events emitted across the steps of the last `advance`, drained: a
   * second call before the next `advance` returns nothing.
   */
  events(): readonly SimEvent[]
  /** This frame's drawables: every living unit, the recent dead, and the props. */
  renderEntities(groundHeightAt: GroundHeightAt): RenderEntity[]
  /** Living player unit ids, in spawn order — who an order is for. */
  selection(): readonly number[]
}

/**
 * The default mission seed.
 *
 * A constant rather than a clock read, and not only because `src/core` may not
 * read a clock: a fixed default is what makes "run the game twice and watch the
 * same firefight" the default experience, which is the property every
 * determinism test in this repo is protecting.
 */
const DEFAULT_SEED = 1

/** The teams that engage on their own. See where it is passed, in `createSession`. */
const AUTO_ENGAGE_TEAMS: readonly Team[] = ['enemy']

/** The atlas source every simulated unit is drawn from. */
const SOLDIER_SPRITE = 'soldier'

/** Enemies are tinted so the two sides read apart at a glance. */
const ENEMY_TINT = 0xff9a86

/** `Entity.state` the squad system writes while a unit is walking. */
const STATE_MOVING = 'moving'

const WALK_ANIMATION = 'walk'
const FIRE_ANIMATION = 'fire'
const DIE_ANIMATION = 'die'

/**
 * The resting pose.
 *
 * Named here as a plain string rather than imported from the renderer's
 * `IDLE_CLIP`, because `core/` may not depend on `src/render/` — the same reason
 * `walk`, `fire` and `die` are spelled out above rather than read from the
 * manifest. The renderer synthesises this clip; the two spellings must agree.
 */
const IDLE_ANIMATION = 'idle'

/**
 * The `die` clip's length, in frames and frames per second, from
 * `tools/spritegen/index.ts`: `SHEET_GRID.cols` is 4, so every animation is four
 * frames, and `FPS.die` is 8. Restated rather than imported because `tools/` is
 * offline build tooling that the game never loads, and read out of the sprite
 * manifest at runtime it would be `render/`'s business, not the sim's.
 */
const DIE_FRAME_COUNT = 4
const DIE_FPS = 8

/**
 * The `fire` clip's length, from the same table: `FPS.fire` is 12 and every
 * animation is four frames.
 */
const FIRE_FRAME_COUNT = 4
const FIRE_FPS = 12

/**
 * How many simulation steps the fire pose stands for: 4/12 s of clip at 60 Hz,
 * so 20 ticks.
 *
 * This used to be ONE tick — the pose was set from the events of the step just
 * run and cleared on the next — so a twenty-tick animation was on screen for a
 * sixtieth of a second. What you saw was a single frame of the four, chosen by
 * whatever the clock happened to read, flicking once per round.
 */
const FIRE_TICKS = Math.ceil(FIRE_FRAME_COUNT / FIRE_FPS / FIXED_TIMESTEP)

/**
 * How many simulation steps a corpse keeps being drawn for: 4/8 s of clip at
 * 60 Hz, so 30 ticks.
 *
 * Dropping a unit from the render list on the tick it dies makes corpses vanish
 * mid-fall — the death animation is a one-shot the renderer needs the entity to
 * still exist for. Rounded up, so the last frame of the clip is shown rather
 * than skipped by a fraction of a step.
 */
const DEATH_TICKS = Math.ceil(DIE_FRAME_COUNT / DIE_FPS / FIXED_TIMESTEP)

/**
 * Where prop ids start, chosen to clear both id spaces they share a renderer
 * with: simulation ids, which `World` issues from 1, and canopy scenery ids,
 * which `src/render/scenery-entities.ts` issues from its `SCENERY_ID_BASE` of
 * 1,000,000 plus one per fringe tile (level 1 has 727 of them).
 *
 * A base rather than a shared allocator for the reason that file gives: ids are
 * the key for the renderer's facing memory and animation phase, so a collision
 * has two things overwriting each other's state, and a constant far above any
 * plausible count is cheaper than an allocator three modules would have to agree
 * on. It is a constant here and not an import because `src/core` may not depend
 * on `src/render`.
 */
const PROP_ID_BASE = 2_000_000

/** A unit's position at the start of the step just run — the facing baseline. */
interface Track {
  x: number
  z: number
}

/** A facing as a direction vector, in the same units `RenderEntity.dx/dz` are. */
interface Direction {
  readonly dx: number
  readonly dz: number
}

/**
 * `SpawnPoint.facing` as a direction vector. `-z` is north — the convention
 * `core/render-state/facing` is built on.
 *
 * Inherited verbatim from the deleted `src/render/level-entities.ts`, which was
 * the only thing that ever read `facing`; the field is parsed and VALIDATED by
 * `core/level`, so losing its last consumer would have left it authored, checked
 * and silently ignored.
 */
const FACING_VECTORS: Readonly<Record<string, Direction>> = {
  N: { dx: 0, dz: -1 },
  NE: { dx: 1, dz: -1 },
  E: { dx: 1, dz: 0 },
  SE: { dx: 1, dz: 1 },
  S: { dx: 0, dz: 1 },
  SW: { dx: -1, dz: 1 },
  W: { dx: -1, dz: 0 },
  NW: { dx: -1, dz: -1 },
}

/**
 * A spawn's authored facing, or `undefined` when it authored none.
 *
 * `level-entities.ts` fell back to south — toward the camera — because it built
 * the entity list from scratch every call and had to say something. This does
 * not: `undefined` becomes (0, 0), which the renderer reads as "keep the facing
 * you had", and a man whose spawn says nothing about where he looks should be
 * left alone rather than turned to face the player.
 */
function facingVector(facing: string | undefined): Direction | undefined {
  if (facing === undefined) return undefined
  return FACING_VECTORS[facing.toUpperCase()]
}

/** A dead unit, still drawn until its death clip has played out. */
interface Corpse {
  readonly id: number
  readonly team: Team
  readonly x: number
  readonly z: number
  readonly diedAtTick: number
}

/**
 * Build a session for `level`.
 *
 * SYSTEM ORDER IS A DECISION: commands, then squad movement, then combat.
 * Commands first because the systems below them read what those orders wrote —
 * applied after, an order would take a whole tick to have any effect. Combat
 * last because a unit that moved this tick then shoots from where it now
 * stands, which is what a player watching the screen expects, and because it is
 * the order in which a man can step into a sightline and fire in the same tick.
 */
export function createSession(level: LevelData, options: SessionOptions = {}): Session {
  const grid = bakeNavGrid(level)
  const world = new World(level, { seed: options.seed ?? DEFAULT_SEED })
  // The constructor does not do this: a world is storage, and what populates it
  // is a decision the caller owns. Avatars then enemies, each in level order.
  world.spawnFromLevel()

  const squad = createSquadSystem(grid, options.squad ?? {})
  // WHO SHOOTS WITHOUT BEING TOLD (ticket 011a): the enemy, and only the enemy.
  // The player squad holds fire until a `fire` command puts it on a standing
  // order, which is the owner's call about when his men start a firefight. The
  // enemy has to engage on its own or nothing shoots back until ticket 012's AI
  // lands. A caller may override the policy wholesale through `options.combat`.
  //
  // THE DEFAULT GOES AFTER THE SPREAD, RESOLVED WITH `??`, NOT BEFORE IT.
  // Spreading over `{ autoEngageTeams: AUTO_ENGAGE_TEAMS }` looks equivalent and
  // is not: `{ ...x }` copies a key that is PRESENT AND UNDEFINED as readily as
  // one holding a value, so a caller writing `combat: { autoEngageTeams:
  // undefined }` — which the optional type invites, and which reads as "no
  // opinion" — would land that `undefined` on top of the default and leave
  // `createCombatSystem`'s own `??` falling through to BOTH teams. The player
  // squad would auto-engage, which is the single behaviour this line exists to
  // prevent, on the strength of an argument that said nothing at all.
  const combat = createCombatSystem(grid, {
    ...options.combat,
    autoEngageTeams: options.combat?.autoEngageTeams ?? AUTO_ENGAGE_TEAMS,
  })
  world.addSystem(squad)
  world.addSystem(combat)
  const systemOrder: readonly string[] = Object.freeze(['squad', 'combat'])

  const queue = createCommandQueue()
  const loop = createGameLoop()

  /** Steps run by the last `advance`; see `Session.stepsLastAdvance`. */
  let stepsLastAdvance = 0

  /**
   * Events accumulated across every step of the current frame.
   *
   * Accumulated rather than overwritten per step: a frame that ran eight steps
   * must report all eight steps' events, or a shot fired in the first step of a
   * long frame is never seen by FX or audio.
   */
  const pending: SimEvent[] = []

  /**
   * The tick each unit last fired on, so `renderEntities` can play `fire`.
   *
   * It has to come from the events: `CombatSystem` sets no `Entity.state` at
   * all, so there is nothing on the entity to read. Only ever asked `get`/`set`,
   * never iterated, so its order cannot reach a simulation result.
   *
   * A TICK, NOT A FLAG. This was a `Set` cleared every step, which made the fire
   * pose exactly one tick long — and the clip is four frames at 12fps, twenty
   * ticks. A twenty-tick animation shown for one tick is a single frame, chosen
   * by whatever the clock happened to read, which is exactly how it looked: one
   * of the four poses, flicking. Keeping the tick lets the pose stand for the
   * length of the clip and lets `animationStart` put its first frame on the
   * round that caused it.
   */
  const lastFiredTick = new Map<number, number>()

  /**
   * Position of every living unit at the start of the step just run.
   *
   * Two things read it, and both want the same number. Facing is the movement of
   * the last step — `entity.x - track.x` — and a unit that did not move reports
   * (0, 0), which the renderer takes as "keep the facing you had", unless it has
   * never moved and its spawn authored one (see `spawnFacings`). And a unit
   * killed during the step leaves no entity to read a position off afterwards,
   * so its corpse is placed here: at where he stood when the step began, which
   * is within one step of movement (0.05 tiles at the default 3 tiles/second) of
   * where the round actually caught him.
   *
   * Keyed lookup only, never iterated, for the determinism reason above.
   */
  const tracks = new Map<number, Track>()

  /** The recent dead, in death order. Pruned every step; see `DEATH_TICKS`. */
  const corpses: Corpse[] = []

  /**
   * The authored facing of every unit that has not moved yet, by entity id.
   *
   * Per-unit state that has to outlive the tick it was read on, because a unit
   * that never receives an order never moves and must keep reporting it. An
   * entry is dropped the first step its unit actually moves: movement is where
   * the man is looking NOW, and the authored value only ever described where he
   * started. Keyed lookup and keyed deletion only, never iterated, so its order
   * cannot reach a simulation result.
   */
  const spawnFacings = new Map<number, Direction>()
  {
    // Pairing by INDEX, not by id arithmetic: `spawnFromLevel` appends avatars
    // then enemies, each in level order, so the entity list it just built is the
    // two spawn lists concatenated. Nothing here assumes what ids `World` issues.
    const spawned = world.entities
    const points = [...level.spawns.avatars, ...level.spawns.enemies]
    for (let i = 0; i < spawned.length; i += 1) {
      const entity = spawned[i]
      const point = points[i]
      if (entity === undefined || point === undefined) continue
      const direction = facingVector(point.facing)
      if (direction !== undefined) spawnFacings.set(entity.id, direction)
    }
  }

  /** Apply everything queued, in push order. Validation lives in `applyCommand`. */
  function drainCommands(): void {
    const batch = queue.drain()
    for (let i = 0; i < batch.length; i += 1) {
      const command = batch[i]
      if (command === undefined) continue
      applyCommand(command, { world, squad, combat, grid })
    }
  }

  /** Refresh `tracks` to the world as it stands right now. */
  function snapshotPositions(): void {
    tracks.clear()
    const entities = world.entities
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i]
      if (entity === undefined) continue
      tracks.set(entity.id, { x: entity.x, z: entity.z })
    }
  }

  /** Take the step's events: keep them for the caller, and read the deaths. */
  function collectEvents(): void {
    const batch = world.drainEvents()
    for (let i = 0; i < batch.length; i += 1) {
      const event = batch[i]
      if (event === undefined) continue
      pending.push(event)
      if (event.type === 'ShotFired') lastFiredTick.set(event.shooterId, world.tickCount)
      if (event.type !== 'UnitDied') continue
      const track = tracks.get(event.id)
      corpses.push({
        id: event.id,
        team: event.team,
        x: track?.x ?? 0,
        z: track?.z ?? 0,
        diedAtTick: world.tickCount,
      })
    }
  }

  /**
   * Forget the authored facing of anyone who moved in the step just run.
   *
   * Here rather than in `renderEntities`, which is a pure read: the fact that a
   * unit has left its spawn is a fact about the simulation, and it must be true
   * whether or not anybody drew a frame.
   */
  function forgetMovedFacings(): void {
    if (spawnFacings.size === 0) return
    const entities = world.entities
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i]
      if (entity === undefined) continue
      const track = tracks.get(entity.id)
      if (track === undefined) continue
      if (entity.x !== track.x || entity.z !== track.z) spawnFacings.delete(entity.id)
    }
  }

  /** Drop corpses whose clip has finished. Compacted in place, order preserved. */
  function pruneCorpses(): void {
    const tick = world.tickCount
    let write = 0
    for (let i = 0; i < corpses.length; i += 1) {
      const corpse = corpses[i]
      if (corpse === undefined) continue
      if (tick - corpse.diedAtTick >= DEATH_TICKS) continue
      corpses[write] = corpse
      write += 1
    }
    corpses.length = write
  }

  /**
   * Drop fire timestamps that have outlived their clip.
   *
   * `lastFiredTick` is keyed by entity id and a mission never reuses one, so
   * without this it grows by one entry per unit that ever fired and holds them
   * to the end of the mission. Bounded by the roster rather than unbounded, so
   * not a leak in the dangerous sense — but it is a map that only ever grows,
   * and the entries are dead the moment the pose is over.
   *
   * Deletion during iteration is why this walks a snapshot of the keys. It is
   * the only place this map is iterated, and it feeds nothing back into the
   * simulation, so no `Map` order reaches a result.
   */
  function pruneFireTimes(): void {
    if (lastFiredTick.size === 0) return
    const tick = world.tickCount
    for (const id of [...lastFiredTick.keys()]) {
      const fired = lastFiredTick.get(id)
      if (fired !== undefined && tick - fired >= FIRE_TICKS) lastFiredTick.delete(id)
    }
  }

  function advance(dt: number): number {
    // Hostile and sub-step frames are the loop's business: it answers 0 steps
    // for a negative, NaN or infinite dt, and clamps a long frame to
    // MAX_STEPS_PER_FRAME rather than letting the backlog spiral.
    const steps = loop.advance(dt)
    // Overwritten, never accumulated: a caller reading a stale count would treat
    // a zero-step frame as a stepping one, which is the bug this exists to stop.
    stepsLastAdvance = steps
    pending.length = 0
    for (let step = 0; step < steps; step += 1) {
      // Commands at the TOP OF EVERY STEP, before the systems that read them.
      // Per step and not per frame: the queue is empty after the first one, so
      // the extra calls cost a swap of an empty array, and an order pushed by a
      // consumer mid-frame is picked up by the next step rather than waiting out
      // the whole frame.
      drainCommands()
      snapshotPositions()
      world.tick()
      collectEvents()
      forgetMovedFacings()
      pruneCorpses()
      pruneFireTimes()
    }
    return loop.alpha
  }

  function events(): readonly SimEvent[] {
    if (pending.length === 0) return EMPTY_EVENTS
    // A copy, because `pending` is refilled in place next frame and a caller
    // holding the live array would watch last frame's batch mutate under it.
    const batch = pending.slice()
    pending.length = 0
    return batch
  }

  function selection(): readonly number[] {
    const ids: number[] = []
    const entities = world.entities
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i]
      if (entity === undefined) continue
      if (entity.team === 'player') ids.push(entity.id)
    }
    return ids
  }

  /**
   * Which clip a living unit plays.
   *
   * `fire` OUTRANKS `walk`. It was the other way round to begin with, on the
   * reasoning that a man running is a man running whatever his rifle is doing —
   * defensible while nothing chose to fire, and wrong the moment firing became a
   * button the player holds. Advancing under fire is the shape of most of the
   * original's missions, and with the walk cycle winning, a squad ordered to
   * shoot while it moved looked like it was jogging through a firefight it was
   * not part of. The mechanics were never in question: a unit under a fire order
   * has always kept shooting while it moved.
   *
   * The pose follows the ORDER, not the round. The clip runs 20 ticks and the
   * rifle's cooldown is 32, so keying it to `ShotFired` leaves a 12-tick hole
   * between rounds — the man snapping back to idle three times a second. Holding
   * the button has to look like holding the button.
   *
   * An auto-engaging unit has no order to read, so it falls back to "fired
   * recently": enemies get the pose for the length of the clip after each round,
   * which is the best that can be said about a unit nobody is aiming.
   *
   * A man doing neither IDLES. `tools/spritegen` emits no idle art — `walk`,
   * `fire` and `die` and nothing else — so `idle` is synthesised by the renderer
   * from walk's first frame, held (`src/render/sprite-atlas.ts`). Returning
   * `walk` here instead, which is what this did first, plays a looping
   * four-frame cycle at a man who is not going anywhere: the whole squad jogs on
   * the spot. It read as a style choice for as long as there was no simulation
   * and therefore no soldier who was ever NOT standing still.
   */
  function animationFor(entity: Entity): string {
    if (combat.isFiring(entity.id)) return FIRE_ANIMATION
    if (firingTicksAgo(entity.id) !== null) return FIRE_ANIMATION
    if (entity.state === STATE_MOVING) return WALK_ANIMATION
    return IDLE_ANIMATION
  }

  /**
   * How many ticks ago this unit fired, or `null` if that is longer ago than the
   * fire clip runs for.
   *
   * The clip is one-shot, so once it has run out the pose is over and the unit
   * goes back to idling. It is NOT gated on the weapon cooldown: the two are
   * different lengths on purpose — the rifle's 32 ticks is how fast a man can
   * shoot, `FIRE_TICKS` is how long the recoil takes to look at — and tying the
   * animation to the cooldown would stretch or clip it every time the weapon
   * table was tuned.
   */
  function firingTicksAgo(id: number): number | null {
    const fired = lastFiredTick.get(id)
    if (fired === undefined) return null
    const ago = world.tickCount - fired
    return ago >= 0 && ago < FIRE_TICKS ? ago : null
  }



  /**
   * The tile a world position stands in — `core/view/projection`'s own
   * `worldToTile`, imported rather than restated.
   *
   * It matters that it is the shared one. A height sampler is indexed by
   * CENTRE-INDEXED tile coordinates, the inverse of `tileToWorld`'s
   * `(n - (w - 1) / 2) * TILE_WORLD_SIZE`; hand it raw world coordinates and it
   * reads a tile up to half the map away, which on flat terrain is invisible.
   * The clamp comes with it, and is what this wants: a unit is always on the
   * map, and if a rounding error ever put one a hair outside it the nearest
   * legal tile's height is the right answer rather than an undefined read.
   */
  const tileOf = (worldX: number, worldZ: number): TileCoord =>
    worldToTile(worldX, worldZ, level.size)

  /**
   * This frame's drawables. A PURE READ: it consults the world, the corpse list
   * and the tracks, and writes to none of them. A headless replay and a rendered
   * one must produce the same mission, and the only way to guarantee that is for
   * looking to change nothing.
   */
  function renderEntities(groundHeightAt: GroundHeightAt): RenderEntity[] {
    const out: RenderEntity[] = []

    const entities = world.entities
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i]
      if (entity === undefined) continue
      const track = tracks.get(entity.id)
      const tile = tileOf(entity.x, entity.z)
      const dx = track === undefined ? 0 : entity.x - track.x
      const dz = track === undefined ? 0 : entity.z - track.z
      // Movement WINS. The authored facing is only ever a starting pose, and the
      // entry is gone the moment he moves anyway; this covers the frames before
      // the first step, when there is no movement to read at all.
      const authored = dx === 0 && dz === 0 ? spawnFacings.get(entity.id) : undefined
      const animation = animationFor(entity)
      out.push({
        id: entity.id,
        unit: SOLDIER_SPRITE,
        animation,
        x: entity.x,
        z: entity.z,
        y: groundHeightAt(tile.x, tile.y),
        dx: authored?.dx ?? dx,
        dz: authored?.dz ?? dz,
        // Zero for every living unit, including `fire`.
        //
        // `fire` loops now, and a looping clip's phase comes from the renderer's
        // own clock plus a per-id offset — the same machinery that stops a
        // marching squad moving in lockstep, and just as welcome on a firing one.
        // Handing it the tick of the last round instead would restart the cycle
        // on every shot, which is the per-round model this deliberately is not.
        // Only corpses carry a real start, because `die` is one-shot and has to
        // begin at the death that caused it.
        animationStart: 0,
        tint: entity.team === 'enemy' ? ENEMY_TINT : undefined,
      })
    }

    for (let i = 0; i < corpses.length; i += 1) {
      const corpse = corpses[i]
      if (corpse === undefined) continue
      const tile = tileOf(corpse.x, corpse.z)
      out.push({
        id: corpse.id,
        unit: SOLDIER_SPRITE,
        animation: DIE_ANIMATION,
        x: corpse.x,
        z: corpse.z,
        y: groundHeightAt(tile.x, tile.y),
        // No facing: the renderer's facing memory is keyed on id and a zero
        // vector leaves it alone, so a corpse falls the way the man was looking.
        dx: 0,
        dz: 0,
        // The simulation time of the death, which is what the one-shot `die`
        // clip measures its hold from. It agrees with the renderer's animation
        // clock for as long as the caller never hands `advance` a frame longer
        // than `MAX_STEPS_PER_FRAME` steps; past that the loop discards the
        // backlog and sim time falls behind wall time by whatever it dropped.
        animationStart: corpse.diedAtTick * FIXED_TIMESTEP,
        // A body stays the colour the man was, so it is still recognisably one
        // of theirs or one of ours. The team comes off the `UnitDied` event,
        // which is the last thing that knew it — the entity is already gone.
        tint: corpse.team === 'enemy' ? ENEMY_TINT : undefined,
      })
    }

    for (const prop of propRenderEntities(level, groundHeightAt, PROP_ID_BASE)) out.push(prop)

    return out
  }

  return {
    world,
    queue,
    squad,
    combat,
    grid,
    systemOrder,
    // A getter, not a snapshot: the object is built once and the count changes
    // every frame, so a plain property would freeze at its initial zero.
    get stepsLastAdvance(): number {
      return stepsLastAdvance
    },
    advance,
    events,
    renderEntities,
    selection,
  }
}
