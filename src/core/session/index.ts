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

import { createAiSystem } from '../ai'
import { createArmoury, DEFAULT_LOADOUT } from '../armoury'
import { applyCommand, createCommandQueue } from '../command'
import { createCombatSystem } from '../combat'
import { createObjectiveSystem } from '../objectives'
import { createOrdnanceSystem } from '../ordnance'
import { bakeNavGrid } from '../pathing'
import { createPickupSystem } from '../pickups'
import { createSquadSystem } from '../squad'
import { createGameLoop, EMPTY_EVENTS, FIXED_TIMESTEP } from '../world'
import { World } from '../world'
import { worldToTile } from '../view/projection'
import { propRenderEntities } from './props'
import type { AiSystem } from '../ai'
import type { Armoury } from '../armoury'
import type { SquadMember } from '../campaign'
import type { CombatOptions, CombatSystem } from '../combat'
import type { CommandQueue } from '../command'
import type { LevelData } from '../level'
import type { MissionOutcome, ObjectiveSystem } from '../objectives'
import type { NavGrid } from '../pathing'
import type { PickupSystem } from '../pickups'
import type { RenderEntity } from '../render-state/entity'
import type { SquadOptions, SquadSystem } from '../squad'
import type { TileCoord } from '../view/projection'
import type { Entity, SimEvent, SimSystem, Team } from '../world'

/** How the ground height under a tile is sampled. Supplied by the terrain. */
export type GroundHeightAt = (tileX: number, tileY: number) => number

/** Everything the session needs that is not the level itself. */
export interface SessionOptions {
  /** Mission seed. The same seed, level and commands replay identically. */
  readonly seed?: number
  /**
   * Movement tuning, passed straight to `createSquadSystem`.
   *
   * RENAMED FROM `squad` BY TICKET 021, which needed that word for the men
   * themselves — a session takes a squad in the sense the player means, and
   * `squad: { speed: 3 }` next to `squad: [aMan, anotherMan]` is a name doing
   * two jobs. Nothing in the repo passed it; the capability is kept because the
   * squad system's tuning has to be reachable from somewhere.
   */
  readonly movement?: SquadOptions
  /**
   * The men on this mission, in the order they take the avatar spawn points
   * (ticket 021).
   *
   * OPTIONAL, AND ITS ABSENCE MUST CHANGE NOTHING. Every session built before
   * this ticket — the whole test suite, and `main.ts` until the campaign is
   * wired up — passes no squad and must play exactly the mission it always did.
   * Absent, `assignment` is EMPTY rather than missing, so no consumer needs a
   * branch for it.
   *
   * `selectSquad` guarantees exactly one man per avatar slot, which is why
   * nothing here has to reconcile the two counts.
   */
  readonly squad?: readonly SquadMember[]
  /**
   * Combat tuning. Passed to `createCombatSystem` OVER a default of
   * `autoEngageTeams: ['enemy']` — the session's own decision that the player
   * squad holds fire — so every other field arrives untouched and that one is a
   * default a caller may replace. See where it is passed, in `createSession`.
   */
  readonly combat?: CombatOptions
  /**
   * Starting rounds per ordnance type, REPLACING `DEFAULT_LOADOUT` rather than
   * merging over it (ticket 016).
   *
   * Replacing, because the thing a caller most wants to say is "this squad has
   * NO rockets" and a merge makes that unsayable — the default would fill in
   * every type the caller left out, which is precisely the types it meant to
   * empty. Ammunition is level data where a level names it; this is where it
   * arrives.
   */
  readonly ammo?: Readonly<Record<string, number>>
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
  /**
   * The enemy's state machine (ticket 012), exposed read-only alongside the
   * other three passes.
   *
   * NOTHING IN THE SESSION NEEDED THIS UNTIL THE DEBUG OVERLAY (ticket 014) —
   * the AI is driven entirely by its own tick and hears events pushed into it
   * from `collectEvents`. It is public now because `core/debug` cannot draw a
   * state machine it cannot ask, and because the only alternative was for the
   * overlay to infer the state from positions and gunfire, which is a second,
   * lying copy of the machine.
   *
   * A READ SIDE ONLY, in practice: `stateOf` and `targetOf` are pure, and
   * `hear` remains the owner's to call — this session drains the bus exactly
   * once and hands it over, and a second caller feeding the machine would
   * alert a man twice to the same round.
   */
  readonly ai: AiSystem
  /**
   * The mission's win/lose evaluation (ticket 013). Public because the HUD
   * draws `progress()` and the mission timer straight off it.
   */
  readonly objectives: ObjectiveSystem
  /**
   * The squad's ammunition and its selected weapon (ticket 016).
   *
   * Public because it is read from both ends: the HUD draws `slots()` and the
   * input layer reads `selected` when it builds a `fire` command. It is per
   * SESSION, so ticket 013's `restart()` — which builds a whole new session —
   * hands the new mission a full pouch rather than the last run's losses.
   */
  readonly armoury: Armoury
  /**
   * Loot chests and their collection (ticket 017).
   *
   * Public for the reason `ordnance.inFlight()` is: chests are NOT entities —
   * `World.spawnFromLevel` refuses to make them one, because everything in the
   * live array goes through the AI's target scan every tick — so `remaining()`
   * is the only way a renderer or the HUD can learn what is still out there.
   */
  readonly pickups: PickupSystem
  /** The baked passability grid both systems path and sight against. */
  readonly grid: NavGrid
  /**
   * Which campaign recruit each player entity IS: entity id -> recruit id
   * (ticket 021).
   *
   * THE ONE PLACE THE SIM'S VOCABULARY AND THE CAMPAIGN'S MEET. The simulation
   * has never heard of a recruit and must not have to; the campaign has never
   * heard of an entity id. `missionReport(events, assignment, levelId)` takes
   * this map verbatim, so there is no conversion step for the two to be
   * mismatched in silently — and a mismatch here is the worst bug available:
   * the campaign would be telling the truth about the wrong people, and nothing
   * inside either half could notice.
   *
   * EMPTY, NEVER MISSING, when no squad was given. `undefined` would make every
   * consumer test for it.
   *
   * NEVER PRUNED. Entity ids are not reused, so a dead man's entry stays
   * meaningful, and that is precisely what lets the report name him afterwards.
   * Pruning on death would silently drop every casualty from the campaign's
   * record — the one thing Boot Hill exists to remember.
   */
  readonly assignment: ReadonlyMap<number, string>
  /**
   * The registration order of the simulation systems, DERIVED.
   *
   * The names of the ordered list `createSession` registers FROM, not a second
   * list written out beside it — so it cannot be edited into a lie about what
   * the world was actually handed. See that list for why it is built this way.
   *
   * It is still not evidence that the world RUNS them in that order, which is
   * `World.tick`'s business. The behaviour is pinned separately, by the test
   * that puts a unit under a move order AND a fire order at once and reads
   * `ShotFired.originX` off a round he fires WHILE WALKING: the origin is where
   * this tick's step left him, which proves combat saw the position squad wrote
   * the same step.
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
  /**
   * How the mission stands: `'playing'` until it is won or lost, then latched.
   *
   * State, alongside the one-shot `MissionComplete`/`MissionFailed` events,
   * because the app is not guaranteed to be listening on the tick one fires —
   * a frame that ran eight steps drains them all at once, and an end screen
   * must be rebuildable from what is true rather than from what was announced.
   */
  outcome(): MissionOutcome
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

/**
 * The teams that engage on their own: NOBODY, since ticket 012.
 *
 * It was `['enemy']`, and it had to be while the enemy was a stationary turret
 * with nothing else to decide for it. The AI now owns that decision and issues
 * `orderFire`/`ceaseFire` exactly as the player's pointer does. ONE SOURCE OF
 * TRUTH: two mechanisms that both decide when an enemy shoots can disagree, and
 * the disagreement is invisible — the man fires either way, and only the state
 * machine's `engage`/`pursue` bookkeeping goes quietly wrong.
 *
 * `CombatOptions.autoEngageTeams` keeps its own both-teams default; ticket 011's
 * contract is untouched, and this is the session changing its mind.
 */
const AUTO_ENGAGE_TEAMS: readonly Team[] = []

/**
 * How a hit is decided in the game the player actually plays (ticket 011b).
 *
 * THE WEAPON'S OWN CURVE, ROLLED. `CombatOptions.hitPolicy` defaults to
 * `'certain'` — range and line of sight decide and the round lands — which is
 * what every combat test written before accuracy existed describes, and it is
 * the right default for a suite that wants to assert damage without also
 * asserting a dice roll. It is the wrong behaviour for the MISSION: with
 * `INFANTRY_HEALTH` at 1, a certain round turns every sightline into an
 * execution, so an enemy who reaches eight tiles kills a man every thirty-two
 * ticks and no cover, manoeuvre or reaction changes the outcome.
 *
 * Named here beside `AUTO_ENGAGE_TEAMS` because it is the same kind of decision
 * made for the same reason: the combat system keeps its default, and this file
 * is the one place that says which game is being run.
 */
const HIT_POLICY = 'weapon' as const

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
  /**
   * THE LONG NAMES ARE NOT A CONVENIENCE (ticket 038).
   *
   * `core/level` validates `facing` as a non-empty STRING and nothing more, and
   * `level/__tests__/schema.test.ts` pins `'south'` as a value a level may
   * legitimately carry — while this table knew only the abbreviations, so
   * `facingVector` returned `undefined` for it and the spawn fell through to the
   * default with nothing said.
   *
   * That cost a sprite its starting pose until ticket 038. It now decides what a
   * guard can SEE, so the two vocabularies have to be one vocabulary: an author
   * who writes `south` and gets a man looking north has no way to tell that from
   * the field being ignored.
   */
  NORTH: { dx: 0, dz: -1 },
  NORTHEAST: { dx: 1, dz: -1 },
  EAST: { dx: 1, dz: 0 },
  SOUTHEAST: { dx: 1, dz: 1 },
  SOUTH: { dx: 0, dz: 1 },
  SOUTHWEST: { dx: -1, dz: 1 },
  WEST: { dx: -1, dz: 0 },
  NORTHWEST: { dx: -1, dz: -1 },
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

/**
 * A spawn point's `patrol` field as a route, or `null` if it is not one.
 *
 * `SpawnPoint` is open (`[field: string]: unknown`) and `core/level` copies
 * fields it does not know about verbatim, which is exactly the extension point
 * ticket 018 rides — and the price of riding it is that NOTHING HAS VALIDATED
 * THIS. A level document is hand-authored (and `tools/mapgen` emits it), so the
 * value arriving here may be a number, a string, or an array of half-written
 * waypoints, and it reaches the sim untouched.
 *
 * A MALFORMED ROUTE IS NO ROUTE AT ALL, rather than the waypoints that happened
 * to parse. A beat with a hole in it is a different beat: the guard would walk
 * a line the author never drew, past ground the author meant him to cover, and
 * the mission would look subtly wrong rather than obviously broken. Holding
 * position is what every enemy in the game does today, so it is the failure the
 * player cannot misread.
 */
function patrolRoute(patrol: unknown): TileCoord[] | null {
  if (!Array.isArray(patrol)) return null
  const route: TileCoord[] = []
  for (const waypoint of patrol as readonly unknown[]) {
    if (typeof waypoint !== 'object' || waypoint === null) return null
    const { x, y } = waypoint as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    route.push({ x, y })
  }
  // An authored empty array is not malformed, it is simply no route — and
  // `assignPatrol` reads it that way too, so the two agree without either
  // needing to know it.
  return route
}

/**
 * Hand every enemy spawn's authored beat to the AI (ticket 018).
 *
 * PAIRED BY POSITION IN THE ENEMY LIST, NOT BY ID ARITHMETIC.
 * `World.spawnFromLevel` appends avatars then enemies, each in level order, so
 * the nth enemy ENTITY is the nth enemy SPAWN POINT — but writing that as
 * `entities[avatars.length + i]` would bake in a second fact (that every avatar
 * spawn produced exactly one entity) that this file has no business asserting.
 * Counting enemies as they come out of the entity list survives a level whose
 * avatars are filtered, capped, or spawned some other way entirely; it depends
 * only on ORDER WITHIN A TEAM, which is the guarantee `spawnFromLevel`
 * documents. Nothing here assumes what ids `World` issues.
 *
 * Called once, at build time, before the first tick: routes are startup data,
 * and a session that re-derived them per tick would be reading the level
 * document sixty times a second to learn something that cannot change.
 */
function assignPatrolRoutes(world: World, level: LevelData, ai: AiSystem): void {
  const points = level.spawns.enemies
  const spawned = world.entities
  let enemyIndex = 0
  for (let i = 0; i < spawned.length; i += 1) {
    const entity = spawned[i]
    if (entity === undefined || entity.team !== 'enemy') continue
    const point = points[enemyIndex]
    enemyIndex += 1
    if (point === undefined) continue
    const route = patrolRoute(point['patrol'])
    // `undefined` is the overwhelmingly common case — every enemy in every
    // level shipped today — and it must not reach `assignPatrol` as an empty
    // route, because "no beat" and "a beat that was withdrawn" are different
    // things to say to a machine that keeps per-unit state.
    if (route === null || route.length === 0) continue
    ai.assignPatrol(entity.id, route)
  }
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

  const squad = createSquadSystem(grid, options.movement ?? {})
  // WHO IS WHO (ticket 021), built once, before the first tick. Pairing is by
  // COUNTING PLAYER ENTITIES AS THEY COME OUT OF `world.entities`, exactly as
  // `assignPatrolRoutes` counts enemies and for the reason given there: writing
  // `entities[i]` would bake in a second fact about what `spawnFromLevel` does
  // with the avatar list, and ticket 018 paid for that assumption once already.
  // Insertion order is player-entity order, so `assignment.values()` reads back
  // in squad order.
  const assignment = new Map<number, string>()
  {
    const chosen = options.squad ?? []
    const spawned = world.entities
    let index = 0
    for (let i = 0; i < spawned.length; i += 1) {
      const entity = spawned[i]
      if (entity === undefined || entity.team !== 'player') continue
      const man = chosen[index]
      index += 1
      // A squad shorter than the level's avatar list leaves the remaining men
      // unassigned rather than throwing: `selectSquad` guarantees the counts
      // match, and a session handed a hand-built squad should still run the
      // mission — an unassigned entity simply does not reach the campaign.
      if (man === undefined) continue
      assignment.set(entity.id, man.id)
    }
  }
  // WHO SHOOTS WITHOUT BEING TOLD (tickets 011a, 012): nobody at all. The player
  // squad holds fire until a `fire` command puts it on a standing order, which
  // is the owner's call about when his men start a firefight, and the enemy
  // shoots when the state machine below tells it to. A caller may override the
  // policy wholesale through `options.combat`.
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
  //
  // AND THE ROLL IS SWITCHED ON HERE (ticket 011b), by the same argument and
  // resolved the same way. `CombatOptions.hitPolicy` defaults to `'certain'` so
  // that every combat test written before accuracy existed still describes a
  // round that lands; the GAME is the thing that wants a shot to be a chance,
  // because a certain round plus one point of infantry health makes any
  // sightline an execution and no cover or manoeuvre changes it. This line is
  // where the session says which of the two it is running.
  const combat = createCombatSystem(grid, {
    ...options.combat,
    autoEngageTeams: options.combat?.autoEngageTeams ?? AUTO_ENGAGE_TEAMS,
    hitPolicy: options.combat?.hitPolicy ?? HIT_POLICY,
  })
  // The enemy's brain (ticket 012). It is handed the two systems it drives
  // rather than building any of its own: a pursuit is a `squad.order`, opening
  // fire is the same `combat.orderFire` the player's pointer sends, and an
  // enemy round is therefore subject to exactly the range and sightline checks
  // a player's is.
  const ai = createAiSystem(grid, { squad, combat })
  assignPatrolRoutes(world, level, ai)
  // The mission's judge (ticket 013). It is handed the level and reads the
  // world; it never drains the event bus, which is presentation's and
  // exactly-once — it peeks at it instead (`World.peekEvents`), for the same
  // reason the AI is handed its batch rather than taking one.
  const objectives = createObjectiveSystem(level)
  // Grenades and rockets (tickets 015, 016). The pouch is per-squad and per
  // SESSION: `restart()` builds a new session, so a new mission cannot inherit
  // the last one's empty pouch. See `SessionOptions.ammo` for why the option
  // replaces the default rather than merging over it.
  const ordnance = createOrdnanceSystem(grid)
  const armoury = createArmoury({ starting: options.ammo ?? DEFAULT_LOADOUT })
  // Loot chests (ticket 017), which is what makes finite ammo a decision rather
  // than an annoyance. It is handed the two things it pays into — the pouch and
  // the mission's judge — and reads the level for where the chests are; it never
  // writes to the level, because `restart()` builds a second session from the
  // same document and a chest spliced out of it would never come back.
  const pickups = createPickupSystem(level, { objectives, armoury })

  /**
   * THE SIMULATION PASSES, IN THE ORDER THEY RUN — and the ONLY place that
   * order is stated.
   *
   * `systemOrder` is derived from this list rather than written out beside it,
   * and that is the whole point of the list existing. It used to be a
   * hand-written frozen literal sitting next to a column of `addSystem` calls:
   * two statements of the same fact, free to disagree. They did not merely
   * theoretically disagree — a reviewer moved the ordnance registration ABOVE
   * combat and all 1315 tests stayed green, because every assertion on
   * `systemOrder` reads the array of names and nothing reads the registration.
   * At that moment the exported "documented contract" was documenting an order
   * the world was not running, which is precisely the failure the wrong
   * `attached` comment in `core/ordnance/system.ts` cost ticket 015 a review
   * round over.
   *
   * So there is one list, `addSystem` walks it, and `systemOrder` is its names.
   * Reordering an entry moves the pass AND the declaration together; there is no
   * edit that can make one lie about the other.
   *
   * Still not a proof that the world RUNS them in this order — that is
   * `World.tick`'s business, and it is pinned separately by the test that puts a
   * unit under a move order and a fire order at once and reads `ShotFired.originX`
   * off a round he fires WHILE WALKING. What this buys is that the name and the
   * registration cannot come apart.
   */
  const systems: readonly (readonly [string, SimSystem])[] = [
    // AI FIRST. A pursue order given this tick must move the man this tick, and
    // a halt must land before the movement it is cancelling; ordered after
    // squad, every decision the machine makes would take a whole tick to have
    // any effect and the man would overshoot his firing position by a step.
    ['ai', ai],
    // Movement before the two things that shoot, so a unit fires from where it
    // now stands rather than from where it stood at the top of the tick.
    ['squad', squad],
    ['combat', combat],
    // ORDNANCE AFTER COMBAT. A man killed by a rifle this tick must not also be
    // killed by a grenade in the same one: the blast measures the world combat
    // left behind, which is the same reason combat itself runs after movement.
    // Reversed, a squad's rifles and its grenades would each resolve against a
    // roster the other had not yet edited, and two weapons would spend
    // themselves killing one man.
    ['ordnance', ordnance],
    // PICKUPS AFTER MOVEMENT AND BEFORE OBJECTIVES, and both halves of that are
    // decisions. After squad, because a man is judged to be standing on a chest
    // where this tick's step actually left him — ordered before movement, every
    // chest would be collected from where the squad stood at the top of the
    // tick and collection would lag the sprite by a step. Before objectives,
    // because a `collect_chests` mission is judged on the world at the END of
    // the tick: registered after the judge, the last chest of the mission would
    // end it one tick late, which is invisible on screen and wrong — the same
    // argument the objectives entry below makes for itself.
    ['pickups', pickups],
    // OBJECTIVES LAST. A mission is judged on the world as it stands at the END
    // of the tick, so the last enemy killed by this tick's combat or blast ends
    // the mission in this tick rather than the next. Registered anywhere
    // earlier and every mission ends one tick late — invisible on screen, and
    // wrong.
    ['objectives', objectives],
  ]
  for (const [, system] of systems) world.addSystem(system)
  const systemOrder: readonly string[] = Object.freeze(systems.map(([name]) => name))

  // PRIMED WITH THE WORLD BEFORE ANY COMMAND CAN REACH IT, AND NOT A NO-OP
  // HOWEVER MUCH IT LOOKS LIKE ONE. `launch` reads the launcher's position out
  // of the world this system was last TICKED with, and `advance` below drains
  // the command queue at the TOP of every step — before `world.tick()` runs a
  // single system. So the first throw of every mission would otherwise arrive
  // while the system still holds no world, and be refused silently: no
  // projectile, no event, no error, and the pouch not charged. The player's
  // first right-click with grenades selected does nothing and his second one
  // works. See `attached` in `core/ordnance/system.ts`, which explains the same
  // thing from the other end. The pass itself is over an empty sky and does
  // nothing else.
  ordnance(world)
  // OBJECTIVES LAST. A mission is judged on the world as it stands at the END
  // of the tick, so the last enemy killed by this tick's combat pass ends the
  // mission in this tick rather than the next. Registered anywhere earlier and
  // every mission ends one tick late — invisible on screen, and wrong.

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
      if (direction === undefined) continue
      spawnFacings.set(entity.id, direction)
      // AND THE SIMULATION IS TOLD TOO, for an enemy (ticket 038). The authored
      // facing has only ever been a starting POSE for a sprite; it is now also
      // the direction the man is actually watching, and the arc he can see
      // inside is measured from it. Seeded here rather than read by the AI
      // because the machine is handed a grid and not a level — the same reason
      // `assignPatrolRoutes` exists — and gated on the team because the AI holds
      // no state for a player unit and must not start.
      //
      // `FACING_VECTORS`'s diagonals are `(1, 1)`-shaped rather than unit
      // vectors; `face` normalises, which is why they can be passed straight in.
      if (entity.team === 'enemy') ai.face(entity.id, direction.dx, direction.dz)
    }
  }

  /** Apply everything queued, in push order. Validation lives in `applyCommand`. */
  function drainCommands(): void {
    const batch = queue.drain()
    for (let i = 0; i < batch.length; i += 1) {
      const command = batch[i]
      if (command === undefined) continue
      applyCommand(command, { world, squad, combat, grid, ordnance, armoury })
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
    // THE AI IS TOLD, IT DOES NOT LISTEN. `drainEvents` empties the bus, so a
    // machine that drained it for itself would silently starve FX, audio and
    // the HUD of everything it consumed. Handing it the batch drained here is
    // also what fixes the reaction time at one tick: the AI runs before combat
    // within a step, so there is nothing of this step's for it to read anyway,
    // and an enemy hears a shot on the step after it was fired.
    ai.hear(batch)
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
   * Whether a unit's aim point is the tile it is standing on — a DEGENERATE aim,
   * with no direction in it (ticket 025a).
   *
   * A zero vector has no direction and `facingFromVector` answers SOUTH for one,
   * so honouring an aim at your own feet spins the man round to face the camera.
   * Right-clicking your own squad is an easy misclick and it must not do that.
   *
   * COMPARED AS TILES, NOT AS AN EXACT ZERO. An order names a TILE and
   * `orderFire` stores its CENTRE, while a walking man is somewhere inside his
   * tile rather than on its centre — so "aimed at the tile under my feet"
   * produces a vector that is small, non-zero, and pointing at whichever side of
   * the centre he has not reached yet. A man mid-stride would therefore be
   * turned to face backwards by a fifth of a tile, which is precisely the spin
   * this exists to stop. The tile comparison is the question actually being
   * asked. Both sides go through `worldToTile`, so the centre-indexed convention
   * is stated in exactly one place (see `tileOf`).
   */
  function aimedAtOwnTile(aim: { x: number; z: number }, standingOn: TileCoord): boolean {
    const aimed = tileOf(aim.x, aim.z)
    return aimed.x === standingOn.x && aimed.y === standingOn.y
  }

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
      let dx = track === undefined ? 0 : entity.x - track.x
      let dz = track === undefined ? 0 : entity.z - track.z
      // AIM OUTRANKS MOVEMENT (ticket 025a), and the mechanic it is catching up
      // with is years older than this line. A right-click has always fired along
      // the ray from the shooter to the CURSOR rather than along his facing, so
      // a man marching north with the cursor east put his rounds east — and was
      // drawn facing north, because movement was the only thing feeding the
      // facing. With no tracer to contradict it the sprite was the player's only
      // feedback, and it was pointing the wrong way: it reads as "he fires where
      // he is facing", which is a targeting bug that does not exist.
      //
      // Firing wins for the same reason `fire` outranks `walk` in `animationFor`
      // — the player is holding a button that means "look there". `stableFacing`
      // downstream smooths the result, and its dead zone is what stops a dragged
      // cursor strobing between two sprites.
      const aim = combat.aimOf(entity.id)
      if (aim !== undefined && !aimedAtOwnTile(aim, tile)) {
        dx = aim.x - entity.x
        dz = aim.z - entity.z
      }
      /**
       * AND THE SIMULATION OUTRANKS BOTH, for a unit the AI commands (ticket
       * 038).
       *
       * THIS IS THE LINE THAT MAKES THE VISION CONE A MECHANIC RATHER THAN AN
       * INVISIBLE RULE. An enemy now has a facing in the SIMULATION that decides
       * what he can see, and everything above derives one from MOVEMENT and AIM
       * — so the two can disagree, and a man drawn looking east while watching
       * south is a blind arc the player cannot see. That does not read as
       * stealth; it reads as being killed by nothing.
       *
       * ASKED OF THE SYSTEM THAT OWNS THE FACT, never recomputed here: two rules
       * for where a man is looking would disagree eventually, and the
       * disagreement is exactly the one above.
       *
       * GATED ON THE ANSWER, NOT ON THE TEAM. `facingOf` is `undefined` for
       * every unit the machine does not command, which is the whole player
       * squad — so the squad keeps taking its facing from movement and aim, and
       * ticket 025a's contract is untouched, without this file restating who the
       * AI commands.
       *
       * It is always a unit vector, so the authored fallback below cannot fire
       * for a unit that has one.
       */
      const commanded = ai.facingOf(entity.id)
      if (commanded !== undefined) {
        dx = commanded.dx
        dz = commanded.dz
      }
      // The authored facing is only ever a starting pose, and the entry is gone
      // the moment he moves anyway; this covers the frames before the first step,
      // when there is neither an aim nor any movement to read at all.
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
    ai,
    objectives,
    armoury,
    pickups,
    grid,
    assignment,
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
    // Delegated rather than mirrored: the mission's standing is the objective
    // system's to own, and a copy kept here would be a second answer to the
    // same question, one tick behind on the tick that matters most.
    outcome: (): MissionOutcome => objectives.outcome(),
  }
}
