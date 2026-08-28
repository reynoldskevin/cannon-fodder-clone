/**
 * The enemy state machine (ticket 012): one pass per tick that decides, for
 * every unit on the AI's team, whether it is standing about, walking toward
 * something, or shooting at somebody.
 *
 * A COORDINATOR, AND HONESTLY SO. This file owns no movement and no ballistics.
 * Its whole job is choosing which of two existing systems to drive this tick —
 * `SquadSystem` to close distance, `CombatSystem` to open fire — which is why
 * both arrive as required options rather than being built here. An AI that
 * moved a unit by writing `entity.x` would be a second movement implementation
 * that no test of the squad system covers, and an AI that emitted `ShotFired`
 * itself would be a round subject to no range check and no sightline. A dying
 * player must always be able to point at the wall or the distance that killed
 * him, and the only way to guarantee that is for the enemy's round to travel
 * through exactly the machinery the player's does.
 *
 * ACQUISITION OUTRANKS MEMORY. The transitions are ordered so that a live,
 * visible target beats anything the machine remembers: a soldier who finished
 * walking to a last-known position while the man he was looking for stood in
 * front of him would be a bug the state names would hide. `pursue` and `alert`
 * are what a unit does when it has nothing better; `engage` is better.
 *
 * LOSING A TARGET AND KILLING ONE ARE DIFFERENT THINGS, and the machine is
 * careful to tell them apart — the entity is gone in both cases, so the only
 * evidence is whether the id it was last shooting at is still alive. A man who
 * broke line of sight is somewhere else, so the machine stops firing and walks
 * to where he was. A man who went down is lying in plain view, so there is
 * nothing to walk toward: he goes back to idle and re-acquires. Treating both as
 * a pursuit would have a soldier walk onto a corpse; treating both as a kill
 * would have him forget a live player the moment a wall came between them.
 *
 * NEITHER SIGHT NOR HEARING IS DIRECTIONAL (ticket 086). Ticket 038 had given
 * `acquire` a 120 degree wedge around the unit's facing, so a man could be
 * approached from behind in the open; that is gone, and sight is now what
 * hearing always was — team, distance and a sightline, asked in every direction.
 * `nearestRumour` never had a wedge and never will, for a reason that outlived
 * the one on sight: gunfire is the ONLY way a soldier can learn about a shooter
 * he has no line to at all, through a wall or beyond his twelve tiles.
 *
 * FACING LIVES IN `Memory`, NOT ON `Entity`. `Entity`'s fields are readonly
 * because nothing in the design changes them, and `World.stateHash` folds it —
 * a per-tick-mutating heading there would put every unit's direction into the
 * world hash for no gain, exactly the bargain `combat`'s cooldown table makes.
 * `Memory` is already where per-unit AI state that outlives a tick lives.
 *
 * HEARING IS PUSHED IN, NOT PULLED. `world.drainEvents()` empties the bus and
 * the session already drains it, so an AI that drained it too would silently
 * starve FX, audio and the HUD. `hear()` is called by the owner with the batch
 * it drained, and this system runs BEFORE combat within a tick, so an enemy
 * reacts to gunfire on the tick after it was fired. One tick, and it is the
 * honest one.
 *
 * DETERMINISM IS STRUCTURAL HERE, not a property of using the seeded rng
 * carefully: the machine draws no random number at all and reads no clock, so
 * the only ordering that could reach a decision is iteration order. Units are
 * visited in `world.entities` order (spawn order, which ticket 005 guarantees is
 * stable) and targets are scanned the same way, scored on squared distance with
 * ties broken on the lower entity id — the same rule `CombatSystem` uses for
 * auto-engage, deliberately, because two target-choice rules in one codebase
 * disagree eventually and the disagreement is invisible: the man fires either
 * way. The one `Map` in the file is read by keyed lookup and iterated only to
 * delete the dead, so its order decides nothing.
 *
 * THE COORDINATE TRAP. There are two continuous tile spaces in this engine, half
 * a tile apart, and `core/squad/system.ts` documents both at length. This module
 * touches them in exactly two places: sightlines, which are CORNER-INDEXED like
 * everything `NavGrid` answers, and the destinations it hands to `squad.order`
 * and `combat.orderFire`, which are integer tile indices produced by
 * `worldToTile` (or its per-axis halves, which are the same arithmetic without
 * the object). Integer indices agree in both conventions, so the conversion is
 * `projection`'s and this file never spells one itself.
 */

import { hasLineOfSight, inRange, weaponFor } from '../combat'
import type { Difficulty } from '../combat'
import { INFANTRY } from '../pathing/navgrid'
import { TILE_WORLD_SIZE, tileToWorld, worldToTileX, worldToTileY } from '../view/projection'
import { ARCHETYPES } from './archetypes'
import {
  DEFAULT_ALERT_RADIUS_TILES,
  DEFAULT_ALERT_TIMEOUT_TICKS,
  DEFAULT_ARRIVAL_TILES,
  DEFAULT_CLOSE_TO_FRACTION,
  DEFAULT_ENEMY_FACING,
  DEFAULT_PURSUE_TIMEOUT_TICKS,
  DEFAULT_REACTION_TICKS,
  DEFAULT_SIGHT_RANGE_TILES,
} from './tuning'
import type { ArchetypeSpec } from './archetypes'
import type { CombatSystem } from '../combat'
import type { NavGrid, TraversalMask } from '../pathing/navgrid'
import type { SquadSystem } from '../squad'
import type { TileCoord } from '../view/projection'
import type { SimEvent } from '../world/events'
import type { Entity, SimSystem, Team, World } from '../world/world'

/**
 * Every state a unit under this machine can be in.
 *
 * ENUMERABLE, and exported as such, because a HUD, the debug overlay and any
 * later behaviour tree all need to name them — and because a fifth state added
 * without a decision is how a small machine stops being small.
 */
export const AI_STATES = ['idle', 'alert', 'engage', 'pursue'] as const

/** What a unit is currently doing. See the transition table in ticket 012. */
export type AiState = (typeof AI_STATES)[number]

/**
 * Which way a unit is looking, as a UNIT VECTOR in world units — the same
 * `dx`/`dz` convention `RenderEntity` carries, with `-z` north.
 *
 * A POSE, NOT A SENSE (ticket 086). This used to gate what a man could see, and
 * it no longer does: sight is all round, and the only reader left is
 * `session/index.ts`, which asks `facingOf` which way to point the sprite of an
 * enemy who is standing still. That is why the whole mechanism survived a ticket
 * that deleted the thing it was built for — take it away and every stationary
 * guard is drawn facing wherever the renderer last remembered.
 *
 * STILL ALWAYS NORMALISED, for a different reason than before. The old one was
 * that an unnormalised vector would scale a dot product against a half-angle
 * threshold, silently retuning what that man could see; now it is that
 * `renderEntities` reads `dx`/`dz` as a direction, and a zero-length or NaN one
 * draws a man pointing nowhere. `face` normalises what it is given and the
 * machine normalises what it derives; there is no path that writes an
 * unnormalised one.
 */
export interface Facing {
  readonly dx: number
  readonly dz: number
}

const IDLE: AiState = 'idle'
const ALERT: AiState = 'alert'
const ENGAGE: AiState = 'engage'
const PURSUE: AiState = 'pursue'

/**
 * What the machine needs to run. `squad` and `combat` are REQUIRED: this system
 * is a coordinator, and one built without the systems it coordinates would be a
 * state machine whose states have no consequences.
 */
export interface AiOptions {
  /** Where move orders and halts go. The same instance the player's pointer uses. */
  readonly squad: SquadSystem
  /** Where fire orders go. The same instance the player's `fire` command uses. */
  readonly combat: CombatSystem
  /**
   * The team this machine commands. The enemy, and only the enemy.
   *
   * ONE TEAM. If it ever grew a second, the player's squad would start fighting
   * on its own and ticket 011a's whole decision — that the owner chooses when
   * his men shoot — would be undone from a new file.
   */
  readonly team?: Team
  /**
   * How hard the enemy fights (ticket 093). `'normal'` when absent.
   *
   * REACHES THIS SYSTEM BECAUSE THE STOPPING DISTANCE IS A FRACTION OF THE
   * WEAPON. `closeToFraction` is applied to `rangeTiles`, so a machine left on
   * `'normal'` while combat ran `'hard'` would halt a man at 0.6 of 6.4 tiles
   * and then let him shoot from eight — and the reverse would halt him at 4.8
   * believing he could reach a target his rifle stops short of. Same value as
   * `CombatOptions.difficulty`, always; `createSession` is what guarantees it.
   */
  readonly difficulty?: Difficulty
  /**
   * The archetype table these units' stats are resolved from, by `Entity.kind`.
   * The shipped `ARCHETYPES` by default.
   *
   * IT REPLACES THE MODULE TABLE, IT DOES NOT MERGE OVER IT. A merge would make
   * "adding an archetype is a table row" true only for rows this module already
   * anticipated: a caller could add kinds but never take one away or reshape one
   * the module ships, and a test that passed a two-row table would silently be
   * testing a table of two plus everything else. A caller who wants the shipped
   * rows in his table spreads them into it himself, where the decision is visible.
   *
   * PRECEDENCE IS THREE DEEP, AND THE TABLE IS IN THE MIDDLE: a value stated
   * explicitly in these options wins, then this unit's archetype row, then
   * `tuning.ts`. Ticket 018 originally said the row wins outright, and that is
   * wrong in a way a shipped test catches — `states.test.ts`'s "gives up on the
   * timeout even when it never arrives" passes `pursueTimeoutTicks: 30` and
   * spawns riflemen, and a row saying 300 would quietly overrule it. The
   * general rule behind the special case: an explicit option is a deliberate
   * instruction about THIS session (a difficulty level, a test pinning one
   * number), while the table is a DEFAULT PER KIND. A default that overrode the
   * caller would leave those settings applying to exactly the kinds nobody had
   * written a row for, which is the least predictable rule available.
   */
  readonly archetypes?: Readonly<Record<string, ArchetypeSpec>>
  /**
   * Sight, hearing, patience and arrival — THE FALLBACK FOR A KIND THE TABLE
   * DOES NOT NAME, not the setting for everybody. Defaults in `tuning.ts`.
   *
   * That fallback is the whole compatibility story of ticket 018: every level
   * authored before archetypes existed spawns kinds nobody has written a row for,
   * and each of those units gets exactly the numbers it got when these were the
   * only numbers there were.
   */
  readonly sightRangeTiles?: number
  readonly alertRadiusTiles?: number
  readonly pursueTimeoutTicks?: number
  readonly alertTimeoutTicks?: number
  /**
   * How long a unit holds fire after raising his rifle at a man he was not
   * already engaging (ticket 012a) — once per unbroken contact, not once per
   * entry into `engage`; see `Memory.armedTargetId`. Same three-deep precedence
   * as the rest: this option, then the archetype row, then
   * `DEFAULT_REACTION_TICKS`.
   */
  readonly reactionTicks?: number
  /**
   * How close a unit walks before he halts and opens fire, as a fraction of his
   * own weapon range (ticket 037). Same three-deep precedence as the rest: this
   * option, then the archetype row, then `DEFAULT_CLOSE_TO_FRACTION`.
   *
   * The ENTRY threshold only — `engage` is left on the full weapon range, and
   * the reason the two must differ is at the decision itself in `step`.
   */
  readonly closeToFraction?: number
  readonly arrivalTiles?: number
  /**
   * The traversal class sightlines are tested against. Infantry by default,
   * because that is what the game spawns; a turret with a raised firing position
   * would pass a different mask rather than a different grid. Matches
   * `CombatOptions.sightMask`, and for the same reason.
   */
  readonly traversalMask?: TraversalMask
}

/**
 * The per-tick decision pass, with the machine's read side attached.
 *
 * A callable object rather than two separate things, exactly like `SquadSystem`
 * and `CombatSystem`: it is registered with `world.addSystem`, which wants a
 * plain `SimSystem`, and its owner needs somewhere to push events and somewhere
 * to read state from. Splitting them would mean handing callers two halves of
 * one piece of state and trusting them to keep the pair together.
 */
export interface AiSystem extends SimSystem {
  /**
   * What this unit is doing, or `undefined` for a unit this machine does not
   * command — the whole player team, anything that never existed, and anyone
   * who has died since the last tick.
   */
  stateOf(unitId: number): AiState | undefined
  /**
   * The entity this unit is currently shooting at, or `undefined` when it is
   * shooting at nobody — which is every state but `engage`, the whole player
   * team, and anyone this machine has never commanded.
   *
   * EXPOSED FOR THE DEBUG OVERLAY (ticket 014), and it is worth the two lines.
   * The alternative is for the overlay to recompute "nearest visible enemy"
   * itself, which would be a SECOND rule for target choice — the exact
   * dual-source-of-truth mistake this file's header spends a paragraph
   * avoiding between `AiSystem` and `CombatSystem`. Two rules disagree
   * eventually, and the disagreement here is the worst kind: the man fires
   * either way and only the picture lies, so the tuner goes hunting a bug in
   * the code that was right.
   *
   * Read-only, and a plain id rather than the entity: the id outlives the
   * entity and `World` never reuses one, so a caller cannot be handed a live
   * reference into the machine's memory.
   */
  targetOf(unitId: number): number | undefined
  /**
   * Whether this unit is inside the beat between engaging and firing (ticket
   * 012a) — he has raised his rifle and has not yet fired.
   *
   * EXPOSED THIS WAY RATHER THAN ON `Entity.state`, and that is a decision
   * rather than a preference. That field has exactly one writer,
   * `squad/system.ts`, and the squad system runs AFTER this one in `systemOrder`
   * — so anything the AI wrote there would be overwritten on the same tick,
   * every tick, and a cue hung off it would simply never appear. It is the
   * accessor shape `stateOf` and `targetOf` already use, for the same reason:
   * ask the system that owns the fact instead of deriving a second answer.
   *
   * FALSE, NEVER `undefined` AND NEVER A THROW, for a man in any other state,
   * for the whole player team and for an id that never existed. A boolean cannot
   * say "unknown", so the safe answer is the one that draws nothing.
   */
  isReacting(unitId: number): boolean
  /**
   * Hand the machine a batch of events to react to. Called by the owner with
   * what it drained, never by draining the bus here; see the note at the top.
   *
   * Everything given is considered on the NEXT tick and then forgotten, so an
   * event heard twice cannot alert a man twice.
   */
  hear(events: readonly SimEvent[]): void
  /**
   * Give this unit a beat to walk (ticket 018). An empty route removes one.
   *
   * TOLD, NOT DISCOVERED. The machine is handed a grid, not a level, and entity
   * ids do not exist until something spawns — so the session reads
   * `level.spawns.enemies[i].patrol` and calls this after `spawnFromLevel`.
   * Teaching `World` to remember which spawn point produced which entity would
   * put level authoring into the world's core, and matching by spawn order in
   * here would make the machine depend on an ordering it cannot see. It also
   * makes every patrol case testable without a level document at all.
   *
   * An id naming nothing, or naming a unit on another team, is accepted and
   * never acted on: the tick pass only ever visits this machine's own team, so
   * a route assigned to a player avatar cannot take the squad out of the
   * player's hands.
   */
  assignPatrol(unitId: number, route: readonly TileCoord[]): void
  /**
   * Which way this unit is looking (ticket 038), or `undefined` for a unit this
   * machine does not command — the whole player team, anything that never
   * existed, and anyone who has died since the last tick. Exactly `stateOf`'s
   * domain, because it is the same per-unit memory.
   *
   * EXPOSED SO THE RENDERER CAN DRAW IT — and since ticket 086 that is the ONLY
   * reason it exists. `renderEntities` derives a sprite facing from MOVEMENT, so
   * a stationary enemy would otherwise be drawn looking wherever he last walked.
   * Facing was a sight mechanic when this was written; now it is purely what the
   * man looks like, and this reader is what kept it alive. The session asks the
   * system that owns the fact rather than deriving a second answer, which is the
   * rule `targetOf` and `isReacting` already follow.
   *
   * A FRESH OBJECT PER CALL, so a caller cannot be handed a live reference into
   * the machine's memory and write a heading into it. The fields themselves are
   * plain numbers on `Memory`, so nothing is allocated per tick — only per read,
   * and the only per-frame reader already allocates a `RenderEntity` beside it.
   */
  facingOf(unitId: number): Facing | undefined
  /**
   * Point this unit somewhere (ticket 038). Called by the session with
   * `SpawnPoint.facing` for an enemy whose level authored one.
   *
   * TOLD, NOT DISCOVERED, exactly like `assignPatrol` and for the same reason:
   * the machine is handed a grid rather than a level, and entity ids do not
   * exist until something spawns.
   *
   * THE VECTOR IS NORMALISED, not taken at whatever length it arrived. This used
   * to matter because sight was a dot product against it; since ticket 086 it
   * matters because the renderer reads it as a direction, and
   * `FACING_VECTORS`'s diagonals are `(1, 1)`-shaped — length 1.41, which draws
   * nothing sensibly.
   *
   * A DEGENERATE VECTOR IS REFUSED, leaving whatever valid facing was already
   * there. A zero — or an infinite, or a NaN — has no direction to normalise and
   * would store NaN, which reaches the renderer and draws a man pointing
   * nowhere for the rest of the mission with nothing on screen to say why.
   *
   * An id naming nothing, or naming a unit on another team, is accepted and
   * never acted on — the tick pass only ever visits this machine's own team.
   */
  face(unitId: number, dx: number, dz: number): void
}

/**
 * One unit's slice of the machine.
 *
 * Mutable, allocated once per unit and never per tick, matching the step buffer
 * in `core/squad/system.ts`: this runs 60 times a second for the length of a
 * mission, and a fresh record per unit per tick is precisely the steady-state
 * garbage ticket 005's tick contract rules out.
 *
 * Positions are carried as plain numbers with an explicit `has*` flag rather
 * than as a nullable object, for the same reason: `null` would mean a fresh
 * object every time a target moved.
 */
interface Memory {
  state: AiState
  /**
   * This unit's own stats, resolved ONCE from its `kind` when the machine first
   * sees it (ticket 018).
   *
   * Resolved once because `Entity.kind` never changes — a man does not become a
   * sniper mid-mission — and because the alternative is a table lookup and four
   * multiplies per unit per tick, sixty times a second, to compute a constant.
   * Held in WORLD units for the same reason the module-level ranges below are:
   * this is where the two spaces meet, and converting at the comparison would
   * scatter the tile-size assumption through the state machine.
   */
  sightRangeWorld: number
  alertRadiusWorld: number
  pursueTimeoutTicks: number
  alertTimeoutTicks: number
  /** This unit's beat before it opens fire, in ticks. See `reactionTicks`. */
  reactionTicks: number
  /**
   * The fraction of its own weapon range this unit closes to before halting and
   * firing (ticket 037). See `ArchetypeSpec.closeToFraction`.
   *
   * A FRACTION HELD RAW, not a world distance resolved once like the two ranges
   * above it, and that is the one field here that cannot be precomputed: it is a
   * fraction OF THE WEAPON, and the weapon is asked of `weaponFor` at the
   * decision so a retune in `weapons.ts` moves the halt distance with it. A
   * distance baked in here would be the enemy carrying his own private copy of a
   * range the weapon table had since changed — exactly the disagreement ticket
   * 036 produced when the range was looked up by kind alone.
   */
  closeToFraction: number
  /**
   * Ticks of that beat still to run, counted down while this unit is in
   * `engage` and reloaded from `reactionTicks` when the beat is ARMED — see
   * `armedTargetId` for when that is (ticket 012a).
   *
   * A COUNTDOWN IN THE UNIT'S OWN MEMORY, not a deadline in a module-level map
   * keyed by id. The memory is already the answer to "what does this man know",
   * and it is already buried when he dies — a second store would be a second
   * thing to remember to clean up, one casualty at a time, for the length of the
   * mission.
   *
   * IT SURVIVES LEAVING `engage`. Nothing drains it on the way out, so a man who
   * breaks off five ticks into a forty-five tick beat still carries forty. That
   * is deliberate rather than an oversight: a target that crosses the weapon's
   * range boundary while staying in sight drops him to `pursue` and back, and a
   * remainder zeroed on the way out would restart that beat every few ticks. The
   * arming rule below decides when it is reloaded, and `isReacting`'s state gate
   * is what stops the survivor being reported over a man who is not engaging.
   */
  reactionRemaining: number
  /**
   * The man this unit is currently engaging, as far as the beat is concerned —
   * `hasArmedTarget` false when it is engaging nobody.
   *
   * ARMED PER TARGET ACQUISITION, NOT PER STATE ENTRY, and that is the whole of
   * the rule (ticket 012a). Entering `engage` reloads the beat only when the
   * target is not the one recorded here. Inside `engage` the record follows the
   * aim without ever reloading, and going IDLE clears it.
   *
   * WHY NOT ON STATE ENTRY. `engage` is left whenever the target crosses out of
   * WEAPON range while staying in sight — the machine drops to `pursue` to close
   * the gap — so a man holding that boundary re-enters `engage` every few ticks,
   * and a beat reloaded on every entry never completes. Against a player
   * withdrawing at the enemy's own speed nothing closes the gap, so that is an
   * enemy permanently unable to fire: the same "switches and waits forever
   * without firing" failure the entering-engage rule was written to prevent,
   * arriving through range flicker instead of target switching.
   *
   * WHY NOT A BARE FLAG cleared on IDLE. A man who loses his quarry to cover,
   * pursues, and finds a DIFFERENT man in range along the way never touched
   * IDLE, and a flag would let him shoot that second man with no beat at all.
   * The id is what tells "the man I was already engaging" apart from "somebody
   * new", which is the distinction the beat is about.
   *
   * SWITCHING TARGET MID-ENGAGEMENT AND THEN FLICKERING COSTS NOTHING, because
   * this follows the aim. A nearer attacker taking over never re-arms (he is
   * already in the firefight, and a beat restarted on every re-aim is the
   * two-opponent deadlock), and re-entering `engage` on that same nearer man
   * must not re-arm either — otherwise two men alternating as nearest while the
   * range flickers would rebuild the deadlock exactly. The behaviour that falls
   * out is one beat per UNBROKEN CONTACT: he pays once when he first raises his
   * rifle at somebody, and pays again only after the machine has put him back to
   * IDLE — either because his target went down, or because he lost him and gave
   * up looking.
   */
  hasArmedTarget: boolean
  armedTargetId: number
  /** How far this unit may be drawn off its beat, in world units. See `aggression`. */
  leashWorld: number
  /**
   * Whether the errand below is a patrol waypoint rather than a pursuit or an
   * investigation.
   *
   * Needed because all three share one set of goal fields, and the patrol has to
   * know whether the goal it is looking at is its own — a man who resumed his
   * beat by inheriting the last-known position of a man he was chasing would
   * walk to a tile that is on nobody's route.
   */
  patrolling: boolean
  /** Destination of a `pursue` or `alert`, as a tile and as the world point of its centre. */
  hasGoal: boolean
  goalX: number
  goalY: number
  goalWorldX: number
  goalWorldZ: number
  /** The destination `squad` was last told about, so an unchanged one is not re-issued. */
  ordered: boolean
  orderedX: number
  orderedY: number
  /** The aim point `combat` was last told about, on the same principle. */
  aiming: boolean
  aimX: number
  aimY: number
  /** Where the target was when it was last SEEN — what a pursuit walks to. */
  hasLastKnown: boolean
  lastKnownX: number
  lastKnownZ: number
  /**
   * The last target acquired, so that losing it can be told apart from killing
   * it: the id outlives the entity, and `World` never reuses one.
   */
  hasTarget: boolean
  targetId: number
  /** The tick at which the current errand is abandoned. See the tuning file. */
  deadline: number
  /**
   * Which way this man is looking, as a unit vector (ticket 038). See `Facing`
   * for why it is always normalised, and the file header for why it lives here
   * rather than on `Entity`.
   *
   * TWO PLAIN NUMBERS, not a `Facing` object, for the allocation reason this
   * whole record is built on: it is rewritten on most ticks of a firefight, and
   * a fresh object each time is the steady-state garbage ticket 005 rules out.
   * `facingOf` builds the object, once per read.
   */
  facingDx: number
  facingDz: number
  /**
   * Where he stood when the machine last looked at him — the baseline the
   * DIRECTION OF TRAVEL is measured against while he is pursuing or alerted.
   *
   * HIS ACTUAL MOVEMENT, NOT THE BEARING OF HIS DESTINATION, and the difference
   * is the whole reason this pair exists. A man walking around a wall to reach a
   * last-known position is not looking through the wall at it; he is looking
   * along the path his feet are taking, which is what the flow field decided and
   * what the player watches him do. A facing derived from the goal would have
   * him stare at his destination through whatever cover lay between, and it
   * would be exactly the sprites-disagree-with-the-sim failure the renderer half
   * of this ticket exists to delete.
   *
   * ONE TICK STALE, HONESTLY. This system runs BEFORE squad within a tick, so
   * the difference read here is the step squad took LAST tick. Reading it after
   * movement would need a second pass, and a tick of lag on a heading is not
   * something an eye can see at 60 Hz.
   *
   * `hasTrack` is false until the first tick, when a man has not moved at all
   * and there is no travel to face along; a zero difference is refused anyway
   * (see `faceAlong`), so this only keeps the first tick from measuring against
   * the origin.
   */
  hasTrack: boolean
  trackX: number
  trackZ: number
}

/**
 * One unit's beat: the waypoints, which one he is walking to, and the post his
 * chases are measured from.
 *
 * THE POST IS WHERE HE WAS STANDING WHEN SOMETHING TOOK HIM OFF HIS BEAT — not
 * a waypoint at all. It is fixed at that moment and held for as long as the
 * contact lasts.
 *
 * IT IS NOT THE WAYPOINT HE IS WALKING TO. That was the defect adversarial
 * review rejected this ticket for: a man one tile into an eighteen-tile leg
 * measured his leash from the far end of it, and so was seventeen tiles from
 * "his post" while standing on his own route. He abandoned every pursuit the
 * instant he lost sight, which made a patrolling guard strictly worse at his
 * job than a static one.
 *
 * IT IS NOT THE NEAREST WAYPOINT EITHER, which was the first repair and left a
 * quieter version of the same symptom: nothing says a waypoint is within the
 * leash. Halfway along a leg longer than TWICE the leash — 24 tiles for a
 * rifleman, 18 for a sniper — a man standing exactly where he was authored to
 * stand is already outside it and will not fight. A 57x45 map clears that with
 * one wall patrol. The alternative was a comment telling route authors to keep
 * their legs short, which is a landmine with a label on it: the constraint
 * would be rediscovered by a designer wondering why his guards run away.
 *
 * His own position removes the class at any leg length, needs no rule anybody
 * has to remember, and is the truer reading of `aggression` besides: how far he
 * strays from where he was when interrupted, rather than from a waypoint he may
 * be nowhere near.
 *
 * Fixed at the interruption rather than tracking him, because a leash that
 * followed the man could never be exceeded: he would ratchet across the map a
 * chase at a time, which is the opposite failure and the harder one to see.
 */
interface Patrol {
  readonly route: readonly TileCoord[]
  index: number
  /**
   * False until a contact anchors the post, and false again the moment he is
   * back on his beat. An unanchored post is never measured against: `{ 0, 0 }`
   * is the MAP CENTRE, and treating it as a post is how the defect above put
   * every routed enemy on a leash to the middle of the level.
   */
  hasPost: boolean
  postWorldX: number
  postWorldZ: number
}

/** A shot this machine has been told about and has not yet reacted to. */
interface Rumour {
  x: number
  z: number
  shooterId: number
}

/**
 * Build the enemy state machine over `grid`.
 *
 * A factory rather than a bare `SimSystem` because the per-unit memory belongs
 * to ONE world for the length of a mission. Module-level state here would let
 * two worlds share what their soldiers remember, which is the determinism
 * failure that is hardest to reproduce: it depends on which test ran first.
 */
export function createAiSystem(grid: NavGrid, options: AiOptions): AiSystem {
  const squad = options.squad
  const combat = options.combat
  const team = options.team ?? 'enemy'
  // Resolved once at construction, for the reason `combat/system.ts` gives where
  // it does the same: a difficulty that could change mid-mission breaks replay.
  const difficulty = options.difficulty ?? 'normal'
  const mask = options.traversalMask ?? INFANTRY
  // Sight, hearing and the two timeouts are NOT resolved here any more: they are
  // per unit as of ticket 018 and are settled once each in `memoryFor`, where
  // the archetype is known. Resolving them here as well would leave two answers
  // to the same question in one file, and the one at the top would be the one a
  // reader believed.
  const arrivalTiles = options.arrivalTiles ?? DEFAULT_ARRIVAL_TILES
  // REPLACES, never merges — see `AiOptions.archetypes`.
  const archetypes = options.archetypes ?? ARCHETYPES

  /**
   * Tile distances converted to WORLD units once, here, at the one place the two
   * spaces meet. `TILE_WORLD_SIZE` is 1 today so these multiplies change
   * nothing — but omitting them would leave this the only module that reads a
   * tile count as a world distance, and a later change to the tile size would
   * make every range in the machine silently wrong by exactly that factor.
   */
  const arrivalWorld = arrivalTiles * TILE_WORLD_SIZE
  // Sight and hearing are converted the same way and for the same reason, but
  // PER UNIT now (ticket 018) — see `Memory`. Arrival stays here because it
  // describes the squad system's stopping distance, which is one fact about the
  // engine rather than a fact about a man.

  /**
   * The level's extent, so destinations can be converted with the shared
   * `worldToTile`/`tileToWorld` rather than a second copy of their arithmetic.
   * The grid is baked from the level, so it always agrees with it.
   */
  const levelSize = { w: grid.w, h: grid.h }

  /**
   * The MIDDLE of the level, in world units, resolved once (ticket 039). It is
   * what a man who has never moved and never been told where to look points at.
   *
   * TILES IN, WORLD OUT, and that conversion is the whole reason this is not
   * `grid.w / 2`. `grid.w`/`grid.h` are TILE COUNTS, and every position it is
   * compared against — `unit.x`, `unit.z` — is in world units, so a midpoint
   * taken in tiles and subtracted from a world position would be an offset in
   * neither space. `tileToWorld` is the one spelling of that mapping in the
   * codebase; see `view/projection.ts`.
   *
   * BOTH AXES, SEPARATELY. Every shipped map is wider than it is tall (57 x 45
   * and 92 x 72), so one axis's midpoint used for both would aim every enemy at
   * a point that is the middle of nothing — the obvious slip, and the one
   * `facing.test.ts` builds a 24 x 12 arena specifically to catch.
   *
   * THE CENTRE TILE, NOT THE GEOMETRIC CENTRE POINT, and the rounding is
   * deliberate. The middle of a `w` wide grid is tile `(w - 1) / 2`, which on an
   * EVEN width is a half tile — a place no unit can ever stand, because
   * everything in this engine is placed at a tile centre. Left unrounded, "a man
   * standing exactly on the centre" would be an unreachable state on half of all
   * maps and the zero-offset fallback below would be dead code that no fixture
   * could exercise. `Math.round` is exactly what `worldToTileX`/`worldToTileY`
   * apply to name the tile a world point falls in, so this IS the tile
   * containing the geometric centre, found the same way everything else here
   * finds a tile. What it costs is at most half a tile of aim point, and only
   * on an even dimension: level 1 (57 x 45) is odd on both, so the rounding
   * moves nothing there at all, and on level 2 (92 x 72) the nearest enemy to
   * the middle is 16.97 tiles from it, where half a tile is 1.7 degrees of
   * bearing — a thirty-fifth of the 60-degree half-arc it feeds.
   */
  const levelCentre = tileToWorld(
    Math.round((grid.w - 1) / 2),
    Math.round((grid.h - 1) / 2),
    levelSize,
  )

  /**
   * What each unit under this machine is doing, by entity id.
   *
   * Keyed by the id and never by an index into the entity array, which
   * `World.despawn` compacts. Read by keyed lookup, so its iteration order
   * cannot reach a decision; it IS walked once a tick to bury the dead, which
   * only ever deletes entries and therefore decides nothing.
   */
  const memories = new Map<number, Memory>()

  /**
   * The beat each routed unit walks, by entity id.
   *
   * Read by KEYED LOOKUP ONLY and never iterated to reach a decision, which is
   * the rule every system here follows: an iteration order that decided which
   * man moved first would be a determinism failure that reproduces only in the
   * test that happened to run second. It is walked once a tick alongside
   * `memories` to drop the dead, and that loop only ever deletes.
   */
  const patrols = new Map<number, Patrol>()

  /**
   * Facings handed to `face` for a unit the machine has not met yet, by entity
   * id (ticket 038).
   *
   * IT EXISTS BECAUSE OF WHEN THE SESSION CALLS. `SpawnPoint.facing` is seeded
   * at build time, before the first tick, and a unit's `Memory` is not created
   * until the tick pass first visits it — so there is nothing to write the
   * authored direction into yet. The alternative is creating memories eagerly,
   * which this system cannot do: it is handed a grid rather than a world, so it
   * has no entity list to walk and no `kind` to resolve the stats from.
   *
   * CONSUMED ONCE, AT MEMORY CREATION, and deleted there — so it holds at most
   * one entry per authored enemy and only until his first tick. Read by keyed
   * lookup and keyed deletion only, never iterated, so its order cannot reach a
   * decision.
   */
  const pendingFacings = new Map<number, Facing>()

  /**
   * Shots heard since the last tick, in the order they were reported.
   *
   * A buffer that is reused and never shrunk, for the allocation reason above;
   * `rumourCount` is how much of it is live. It settles at the largest volley
   * the mission ever fired, which is bounded by the entity count.
   */
  const rumours: Rumour[] = []
  let rumourCount = 0

  /**
   * Scratch endpoints for the sightline walk.
   *
   * Safe to reuse because `hasLineOfSight` reads both and retains neither: it
   * floors them into tile indices and walks integers from there.
   */
  const sightFrom = { x: 0, y: 0 }
  const sightTo = { x: 0, y: 0 }

  /**
   * The one-element argument every order this machine issues is made of.
   *
   * Reused rather than allocated per call for the tick-contract reason above,
   * and safe because none of the three callees retains it: `squad.order` copies
   * the ids it accepts into a roster of its own, and `squad.halt` and
   * `combat.orderFire`/`ceaseFire` iterate it and are done.
   */
  const commanded: number[] = [0]
  function just(unitId: number): readonly number[] {
    commanded[0] = unitId
    return commanded
  }

  /**
   * A world coordinate in the CORNER-INDEXED tile space the grid walks.
   *
   * The two spaces share a scale (`TILE_WORLD_SIZE` is 1) but not an origin: a
   * level is centred on the world origin, so world x = tile x - (n - 1) / 2, and
   * the `+ n / 2` here is that inverse composed with `hasLineOfSight`'s flooring
   * convention. `core/combat/system.ts` bridges the same gap the same way, and
   * for the same consumer.
   *
   * Not `worldToTile`, deliberately: that clamps to the grid, which is right for
   * pointer picking and wrong here — a unit that had somehow left the map would
   * be teleported onto the edge and handed a sightline it does not have.
   */
  const toTileAxis = (world: number, tiles: number): number => world / TILE_WORLD_SIZE + tiles / 2

  /**
   * This unit's memory, created — and its stats resolved — the first time the
   * machine sees it.
   *
   * The lookup is by `kind` and misses on purpose for anything the table does
   * not name: the system options are the fallback, and every enemy in every
   * level authored before ticket 018 takes that path. See `AiOptions.archetypes`.
   */
  /**
   * Which way a man standing HERE looks before anything has happened to him
   * (ticket 039): inward, at the middle of the level.
   *
   * A SPAWN POSTURE, NOT A BEHAVIOUR, which is why it is called from `memoryFor`
   * and from nowhere else. It is read once, on the tick the machine first sees
   * him — while he is still standing where the level put him — and never again.
   * Recomputed on every idle tick instead, it would spin a guard who walked east
   * and halted back toward the middle the moment he stopped, which contradicts
   * rung 3 of `turn`'s ladder ("an idle man keeps the facing he had") and is not
   * what a soldier does.
   *
   * WHY INWARD RATHER THAN A COMPASS POINT. A fixed default is wrong for
   * whoever stands on the wrong side of the map: ticket 038 shipped a southward
   * one, and level 2's enemies standing south of its middle spent the mission
   * watching the void past the bottom edge. Sampling both shipped levels' arcs
   * every 5 degrees out to twelve tiles, that default left 88% of level 2's
   * sampled arc on the map where this one leaves 100%. An inward direction cannot leave
   * the map from anywhere on it, so the property holds on the three levels not
   * yet imported as well, with no authored data.
   *
   * THE EXACT CENTRE HAS NO DIRECTION TO COMPUTE. Its offset is the zero vector,
   * and dividing by that length stores NaN — which reaches the renderer and
   * draws that one man pointing nowhere for the rest of the mission, with
   * nothing on screen to say why. `DEFAULT_ENEMY_FACING` is the finite unit vector he gets
   * instead; it is a guard on a degenerate input and not a policy, and
   * `tuning.ts` says so.
   *
   * An object per call, allocated once per unit at memory creation and never per
   * tick — `memoryFor` is already allocating the record it goes into.
   */
  function facingTowardCentre(unit: Entity): Facing {
    const dx = levelCentre.x - unit.x
    const dz = levelCentre.z - unit.z
    const lengthSq = dx * dx + dz * dz
    // The same finiteness-and-zero test `faceAlong` applies, on a squared length
    // for the same reason: it is the cheaper multiply, and an infinite or NaN
    // position fails `Number.isFinite` here just as surely as a zero offset does.
    if (!Number.isFinite(lengthSq) || lengthSq <= 0) return DEFAULT_ENEMY_FACING
    const length = Math.sqrt(lengthSq)
    return { dx: dx / length, dz: dz / length }
  }

  function memoryFor(unit: Entity): Memory {
    const unitId = unit.id
    const existing = memories.get(unitId)
    if (existing !== undefined) return existing
    /**
     * PRECEDENCE, AND IT IS THREE DEEP: what the caller stated explicitly, then
     * this unit's archetype, then `tuning.ts`.
     *
     * The caller's value outranks the table on purpose. `AiOptions` is a
     * decision about THIS session — a test dialling the whole map's patience
     * down to thirty ticks, a difficulty level slackening every enemy's eyes —
     * and a table row that quietly overrode it would make those settings apply
     * to exactly the kinds nobody had written a row for, which is the least
     * predictable rule available. The table is the DEFAULT PER KIND, not an
     * override of the operator.
     */
    const spec = archetypes[unit.kind]
    // Whatever the session seeded before this man had a memory to seed into;
    // taken now and dropped, so the map never outlives its one use. See
    // `pendingFacings`.
    const authoredFacing = pendingFacings.get(unitId)
    pendingFacings.delete(unitId)
    /**
     * The fourth and last rung of the precedence ladder in `turn`, reached by a
     * man who has never moved and never made contact: the AUTHORED direction if
     * the level gave him one, otherwise the inward default computed from where
     * he is standing right now (ticket 039).
     *
     * AUTHORED WINS OUTRIGHT, and `??` short-circuits so the computation is not
     * even run for a man who has one. That precedence matters more after this
     * ticket than before it: the inward default is good enough that writing a
     * `SpawnPoint.facing` is now a deliberate choice about one guard rather than
     * a correction of a default that did not suit the map.
     *
     * Both are unit vectors by the time they land here — `face` normalised the
     * authored one before parking it, and `facingTowardCentre` normalises its
     * own answer and falls back to a vector that is already normal — which the
     * arc's dot product depends on.
     */
    const spawnFacing = authoredFacing ?? facingTowardCentre(unit)
    const sight =
      (options.sightRangeTiles ?? spec?.sightRangeTiles ?? DEFAULT_SIGHT_RANGE_TILES) *
      TILE_WORLD_SIZE
    const created: Memory = {
      state: IDLE,
      sightRangeWorld: sight,
      alertRadiusWorld:
        (options.alertRadiusTiles ?? spec?.alertRadiusTiles ?? DEFAULT_ALERT_RADIUS_TILES) *
        TILE_WORLD_SIZE,
      pursueTimeoutTicks:
        options.pursueTimeoutTicks ?? spec?.pursueTimeoutTicks ?? DEFAULT_PURSUE_TIMEOUT_TICKS,
      alertTimeoutTicks:
        options.alertTimeoutTicks ?? spec?.alertTimeoutTicks ?? DEFAULT_ALERT_TIMEOUT_TICKS,
      reactionTicks: options.reactionTicks ?? spec?.reactionTicks ?? DEFAULT_REACTION_TICKS,
      closeToFraction:
        options.closeToFraction ?? spec?.closeToFraction ?? DEFAULT_CLOSE_TO_FRACTION,
      // Zero because no beat has been armed yet, which is the honest starting
      // value — NOT because it is what keeps a cue off an idle man. That is
      // `isReacting`'s state gate and nothing else: a mutation putting the full
      // count here survived the entire suite, precisely because a man who has
      // never engaged anybody is never in `engage` for the gate to let through.
      reactionRemaining: 0,
      hasArmedTarget: false,
      armedTargetId: 0,
      // A multiple of this unit's OWN sight, so a retune of the eyes moves the
      // leash with them; a kind with no row has no post to be leashed to either,
      // and `Infinity` is how "the timeout alone decides" is spelled without a
      // second branch in the pursuit test below.
      leashWorld: spec === undefined ? Infinity : spec.aggression * sight,
      patrolling: false,
      hasGoal: false,
      goalX: 0,
      goalY: 0,
      goalWorldX: 0,
      goalWorldZ: 0,
      ordered: false,
      orderedX: 0,
      orderedY: 0,
      aiming: false,
      aimX: 0,
      aimY: 0,
      hasLastKnown: false,
      lastKnownX: 0,
      lastKnownZ: 0,
      hasTarget: false,
      targetId: 0,
      deadline: 0,
      // Settled just above, once, and never recomputed. See `spawnFacing`.
      facingDx: spawnFacing.dx,
      facingDz: spawnFacing.dz,
      hasTrack: false,
      trackX: 0,
      trackZ: 0,
    }
    memories.set(unitId, created)
    return created
  }

  /**
   * The best target for `hunter`, or `null`.
   *
   * NEAREST LIVING ENEMY IN SIGHT, which is `CombatSystem`'s auto-engage rule
   * with sight range in place of weapon range — see the note at the top on why
   * it is that rule and not a cleverer one. Sight is longer than any weapon, so
   * a target found here may still be out of range; that is the difference
   * between `engage` and `pursue`, and it is decided by the caller.
   *
   * IT LOOKS IN EVERY DIRECTION (ticket 086). Ticket 038 had made this a 120
   * degree forward wedge, so a player could walk up behind a guard in the open
   * and go unnoticed; that test is gone, and with it the four-tile awareness
   * radius which existed only to stop the wedge reading as a bug at point-blank
   * range. Direction is no longer a sense here — it is only what the man's
   * sprite is doing.
   *
   * WHAT REMAINS IS STILL FOUR TESTS, and widening the angle weakened none of
   * them: team, health, sight range and the sightline. A man beyond sight range,
   * or behind cover, is not seen from any bearing.
   *
   * The sightline raycast is done LAST, after team, health and the distance
   * comparison. It walks a tile at a time and is by far the most expensive test
   * here; almost every candidate is eliminated by a subtraction and a multiply
   * first.
   */
  function acquire(world: World, hunter: Entity, memory: Memory): Entity | null {
    const sightRangeWorld = memory.sightRangeWorld
    let best: Entity | null = null
    let bestDistanceSq = 0
    const candidates = world.entities
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      if (candidate.team === hunter.team) continue
      if (candidate.health <= 0) continue
      const dx = candidate.x - hunter.x
      const dz = candidate.z - hunter.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > sightRangeWorld * sightRangeWorld) continue
      if (best !== null) {
        if (distanceSq > bestDistanceSq) continue
        // Equal distance is common — a squad advancing abreast — and without an
        // explicit tie-break the winner would be whichever the scan reached
        // first, which is stable today only by accident of spawn order. Lower id
        // wins, which is a fact about the world rather than about the loop.
        if (distanceSq === bestDistanceSq && candidate.id >= best.id) continue
      }
      sightFrom.x = toTileAxis(hunter.x, grid.w)
      sightFrom.y = toTileAxis(hunter.z, grid.h)
      sightTo.x = toTileAxis(candidate.x, grid.w)
      sightTo.y = toTileAxis(candidate.z, grid.h)
      if (!hasLineOfSight(grid, sightFrom, sightTo, mask)) continue
      best = candidate
      bestDistanceSq = distanceSq
    }
    return best
  }

  /**
   * The nearest shot this unit has been told about and ought to care about, or
   * `null`.
   *
   * A unit never reacts to its OWN gunfire: otherwise a man who fires walks
   * toward himself, which reads as an engaged soldier drifting off his firing
   * position for no reason the player can see. Ties go to the earlier report,
   * which is emission order and therefore a fact about the simulation.
   */
  function nearestRumour(listener: Entity, alertRadiusWorld: number): Rumour | null {
    let best: Rumour | null = null
    let bestDistanceSq = 0
    for (let i = 0; i < rumourCount; i += 1) {
      const rumour = rumours[i]
      if (rumour === undefined) continue
      if (rumour.shooterId === listener.id) continue
      const dx = rumour.x - listener.x
      const dz = rumour.z - listener.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > alertRadiusWorld * alertRadiusWorld) continue
      if (best !== null && distanceSq >= bestDistanceSq) continue
      best = rumour
      bestDistanceSq = distanceSq
    }
    return best
  }

  /**
   * Point this unit's errand at the tile containing a world position.
   *
   * A no-op when the tile has not changed, which is what stops a pursuit of a
   * man walking across one tile from rebuilding a detachment every tick: the
   * order dedupe downstream compares against `goalX`/`goalY`, and leaving them
   * untouched is what makes the comparison meaningful.
   *
   * The destination is the tile's CENTRE in world units, because that is where
   * `squad` actually walks a unit to; measuring arrival against the raw position
   * that produced the tile would call the errand finished up to 0.71 tiles early.
   */
  function aimErrandAt(memory: Memory, worldX: number, worldZ: number): void {
    // The axes SEPARATELY, and before anything is built: `worldToTile` returns a
    // fresh object, and a man pursuing another across open ground asks this
    // question 60 times a second to be told the tile has not changed. The pair
    // of helpers is `worldToTile`'s own arithmetic — it is defined in terms of
    // them — so this is the same rounding and the same clamp, not a second
    // spelling of the half-tile convention.
    setGoalTile(memory, worldToTileX(worldX, levelSize), worldToTileY(worldZ, levelSize))
  }

  /**
   * Point this unit's errand at a TILE it was given directly.
   *
   * Split out of `aimErrandAt` for the patrol, whose waypoints are already tile
   * indices: converting a waypoint to a world point only to have it converted
   * straight back would round a route through the half-tile convention twice for
   * no reason, and the two roundings are not each other's inverse at a boundary.
   */
  function setGoalTile(memory: Memory, tileX: number, tileY: number): void {
    if (memory.hasGoal && memory.goalX === tileX && memory.goalY === tileY) return
    // Only the change allocates.
    const point = tileToWorld(tileX, tileY, levelSize)
    memory.hasGoal = true
    memory.goalX = tileX
    memory.goalY = tileY
    memory.goalWorldX = point.x
    memory.goalWorldZ = point.z
  }

  /**
   * Whether this unit has been drawn further off its beat than its archetype
   * will tolerate (ticket 018's `aggression`).
   *
   * ONLY A UNIT WITH A ROUTE HAS A BEAT. A routeless enemy — which is every
   * enemy in the game today — has nothing to measure from, so it is bounded by
   * `pursueTimeoutTicks` alone exactly as it was before archetypes existed, and
   * this returns false without touching anything. `leashWorld` is `Infinity` for
   * a kind the table does not name, so an unknown kind on a route is likewise
   * unchanged.
   *
   * Measured from the WAYPOINT HE WAS WALKING TO, not from where he broke off:
   * the post is the fixed thing, and a leash anchored to the point of
   * interruption would let a man ratchet across the map one chase at a time.
   */
  function offTheLeash(unit: Entity, memory: Memory, patrol: Patrol | undefined): boolean {
    if (patrol === undefined || !patrol.hasPost || memory.leashWorld === Infinity) return false
    return !inRange(unit.x, unit.z, patrol.postWorldX, patrol.postWorldZ, memory.leashWorld)
  }

  /**
   * Fix this unit's post at WHERE HE IS STANDING, right now.
   *
   * Called ONCE, on the tick a contact takes him off his beat, and never again
   * until he is back on it — that is what stops the leash from following the man
   * it is supposed to restrain. A man is therefore always zero tiles from his
   * post at the moment a chase begins, whatever his route looks like, so nothing
   * about a leash can stop him giving chase: `aggression` BOUNDS a pursuit, and
   * a knob that forbade one would be a bug wearing a design's name. See `Patrol`
   * for the two anchors this replaced and the symptom each one produced.
   *
   * Two field writes and no allocation, which is why it can sit on the decision
   * path without a second thought.
   */
  function anchorPost(unit: Entity, patrol: Patrol): void {
    patrol.hasPost = true
    patrol.postWorldX = unit.x
    patrol.postWorldZ = unit.z
  }

  /** Whether this unit is standing on the errand it was sent on. */
  const arrived = (unit: Entity, memory: Memory): boolean =>
    inRange(unit.x, unit.z, memory.goalWorldX, memory.goalWorldZ, arrivalWorld)

  /**
   * Put this unit on the march, if it is not already marching to that tile.
   *
   * ONE ORDER PER DESTINATION, NOT ONE PER TICK. `squad.order` is a flow-field
   * lookup and a detachment rebuild; re-issuing an unchanged order 60 times a
   * second would pay both for nothing, and would reset the detachment the unit
   * is already in every tick.
   */
  function march(memory: Memory, unitId: number): void {
    if (!memory.hasGoal) return
    if (memory.ordered && memory.orderedX === memory.goalX && memory.orderedY === memory.goalY) {
      return
    }
    memory.ordered = true
    memory.orderedX = memory.goalX
    memory.orderedY = memory.goalY
    // A fresh object per order, not per tick: `SquadSystem.order` reads the
    // coordinate and keeps its own copy, and the dedupe above is what makes this
    // rare. `TileCoord` is readonly, so it cannot be a reused scratch.
    const target: TileCoord = { x: memory.goalX, y: memory.goalY }
    squad.order(just(unitId), target)
  }

  /** Take this unit off the march and forget where it was going. */
  function stop(memory: Memory, unitId: number): void {
    memory.hasGoal = false
    memory.ordered = false
    // A halted man is not on his beat any more, and the next idle tick has to
    // choose a waypoint afresh rather than resume one he was already walking to
    // — that choice is what makes an interrupted guard carry on from where he
    // was standing instead of trudging back to the top of the list.
    memory.patrolling = false
    squad.halt(just(unitId))
  }

  /**
   * The waypoint this unit is nearest to, as an index into its route.
   *
   * RESUMING, NOT RESTARTING. A guard shot at three quarters of the way along a
   * wall who went back to index 0 would walk the whole wall backwards before
   * carrying on, and the player reads that as the AI forgetting what it was
   * doing. Squared distance, so no square root; ties go to the LOWER INDEX,
   * which is a fact about the route rather than about the scan order, and a
   * route with two waypoints the same distance away must not resolve differently
   * on two machines.
   *
   * The caller guarantees a non-empty route, so index 0 is always a real answer.
   */
  function nearestWaypoint(unit: Entity, route: readonly TileCoord[]): number {
    let best = 0
    let bestDistanceSq = Infinity
    for (let i = 0; i < route.length; i += 1) {
      const waypoint = route[i]
      if (waypoint === undefined) continue
      // The waypoint's CENTRE, through the shared conversion rather than a
      // second spelling of the half-tile convention. It allocates, and that is
      // affordable HERE and nowhere else in this file: choosing a waypoint
      // happens when a man resumes his beat, not on the ticks he walks it.
      const centre = tileToWorld(waypoint.x, waypoint.y, levelSize)
      const dx = centre.x - unit.x
      const dz = centre.z - unit.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq >= bestDistanceSq) continue
      best = i
      bestDistanceSq = distanceSq
    }
    return best
  }

  /** Send this unit to the waypoint its patrol is currently pointed at. */
  function headForWaypoint(memory: Memory, patrol: Patrol): void {
    const waypoint = patrol.route[patrol.index]
    if (waypoint === undefined) return
    memory.patrolling = true
    setGoalTile(memory, waypoint.x, waypoint.y)
  }

  /**
   * Walk the beat. Called only from `idle`, which is the whole of the design:
   * an enemy who kept strolling his route while being shot at would read as an
   * AI that had not noticed the player, which is worse than one that stands still.
   */
  function patrolStep(memory: Memory, unit: Entity, patrol: Patrol): void {
    if (!memory.patrolling || !memory.hasGoal) {
      patrol.index = nearestWaypoint(unit, patrol.route)
      headForWaypoint(memory, patrol)
    }
    if (arrived(unit, memory)) {
      // WRAPPING, so a beat is a beat and not a slow march to a new post. The
      // advance happens in the same tick as the resume above on purpose: a man
      // who resumes onto the waypoint he is already standing on would otherwise
      // spend a tick ordering himself to where he is, which is a flow field
      // replanned for nothing.
      patrol.index = (patrol.index + 1) % patrol.route.length
      headForWaypoint(memory, patrol)
    }
    march(memory, unit.id)
  }

  /**
   * Open — or re-aim — fire on a target.
   *
   * Aimed at the target's TILE, which is what `CombatSystem` takes, and re-aimed
   * only when that tile changes. Combat reads that tile as a DIRECTION and hits
   * the first man within `AIM_CORRIDOR_TILES` of the line to it (ticket 011c) —
   * which is normally the man aimed at, and is his mate if the mate has stepped
   * in front of him. So this is the player's pointer's own path to a round
   * leaving a rifle, with the machine holding the pointer.
   */
  function shootAt(memory: Memory, unitId: number, target: Entity): void {
    // Axes first, object second — see `aimErrandAt`. An engaged man asks this
    // every tick of the firefight and the answer changes only when his target
    // crosses a tile boundary.
    const tileX = worldToTileX(target.x, levelSize)
    const tileY = worldToTileY(target.z, levelSize)
    if (memory.aiming && memory.aimX === tileX && memory.aimY === tileY) return
    memory.aiming = true
    memory.aimX = tileX
    memory.aimY = tileY
    // A fresh object per re-aim, not per tick: `CombatSystem.orderFire` converts
    // the coordinate and keeps its own copy, and `TileCoord` is readonly, so it
    // cannot be a reused scratch.
    const aim: TileCoord = { x: tileX, y: tileY }
    combat.orderFire(just(unitId), aim)
  }

  /** Take this unit off its standing fire order. */
  function holdFire(memory: Memory, unitId: number): void {
    if (!memory.aiming) return
    memory.aiming = false
    combat.ceaseFire(just(unitId))
  }

  /**
   * Point a unit along a direction, normalising it, and say whether it took.
   *
   * REFUSING A DEGENERATE VECTOR IS THE WHOLE OF THE ERROR HANDLING, and it is
   * load-bearing rather than defensive. Dividing by a zero length stores NaN,
   * which reaches the renderer and draws that man pointing nowhere for the rest
   * of the mission with nothing on screen to say why. Refusing leaves
   * whatever valid unit vector was already there, which is always something
   * sensible: the worst case is that he keeps looking where he was looking.
   *
   * A SQUARED LENGTH RATHER THAN `Math.hypot`, and the finiteness test is done
   * on it: it is the cheaper multiply, and an infinite or NaN input fails
   * `Number.isFinite` here just as surely.
   */
  function faceAlong(memory: Memory, dx: number, dz: number): boolean {
    const lengthSq = dx * dx + dz * dz
    if (!Number.isFinite(lengthSq) || lengthSq <= 0) return false
    const length = Math.sqrt(lengthSq)
    memory.facingDx = dx / length
    memory.facingDz = dz / length
    return true
  }

  /**
   * Where this man is looking at the END of his tick, in precedence order
   * (ticket 038):
   *
   *   1. ENGAGING — he faces his target. He has stopped walking and is shooting
   *      at somebody; there is nothing else he could be looking at.
   *   2. PURSUING OR ALERTED — he faces the DIRECTION OF TRAVEL. He is walking
   *      at something, and a man drawn walking sideways at a noise looks wrong.
   *   3. IDLE — he keeps the facing he had. A man who has stopped looking at
   *      something does not snap back to a compass default; a guard the squad
   *      lured east stays looking east, which is what the player last saw.
   *   4. NEVER MOVED, NEVER CONTACTED — the authored facing if the level gave
   *      him one, otherwise INWARD, at the middle of the level (ticket 039).
   *      That rung is settled once in `memoryFor` rather than here, because it
   *      is the value the other three start from — and because it is a spawn
   *      posture rather than a behaviour: recomputed here it would re-aim every
   *      man at the centre the moment he stopped walking, which is rung 3
   *      deleted.
   *
   * DETERMINISTIC BY CONSTRUCTION. It reads two positions and the previous
   * facing, all of which are already deterministic, and it is written only here,
   * inside the per-unit step. No `Map` iteration order reaches it and no rng
   * draw is taken — a heading seeded from the rng would make a mission depend on
   * how many men had been spawned before it, which is the trap `tuning.ts` names
   * at the top.
   *
   * The track is refreshed on EVERY tick and in every state, not only the two
   * that read it: a baseline updated only while pursuing would make the first
   * pursuing tick after a spell of standing still measure travel from wherever
   * he was when he last stopped.
   */
  function turn(unit: Entity, memory: Memory, next: AiState, target: Entity | null): void {
    if (next === ENGAGE) {
      // `target` is non-null on every path that reaches `ENGAGE` — it is the
      // only branch that can produce it — and the guard is the type system's
      // rather than a doubt about that.
      if (target !== null) faceAlong(memory, target.x - unit.x, target.z - unit.z)
    } else if (memory.hasTrack) {
      /**
       * ANY MOVEMENT AT ALL, NOT A LIST OF STATES — and the difference is a bug
       * this ticket shipped in its first draft.
       *
       * Written as `next === PURSUE || next === ALERT` it skipped PATROL, because
       * a patrol runs inside the IDLE branch: `patrolStep` is on the
       * `next === IDLE` tail. So a routed guard kept whatever facing he spawned
       * with and walked his whole beat looking somewhere else. Measured on that
       * draft: a man routed due north crossed five and a half tiles with a player
       * standing in plain sight directly ahead of him and never acquired him —
       * he would notice only by tripping over him inside the awareness radius.
       *
       * And because the renderer now takes an enemy's sprite direction from this
       * value, he was DRAWN facing south while marching north. That is worse than
       * the movement-derived facing it replaced, which at least looked right.
       *
       * A man who did not move this tick has no travel to face along, and
       * `faceAlong` refuses the zero vector, so he keeps his heading — which is
       * the right answer both for a sentry standing his post and for a soldier
       * halted against geometry.
       */
      faceAlong(memory, unit.x - memory.trackX, unit.z - memory.trackZ)
    }
    memory.hasTrack = true
    memory.trackX = unit.x
    memory.trackZ = unit.z
  }

  /**
   * One unit's tick: decide the state, then make it true of the world.
   *
   * The two halves are kept apart on purpose. The first reads the world and
   * writes only to `Memory`; the second is the only place an order is issued,
   * so "which transitions command what" is one readable block rather than a
   * rule scattered through the branches above it.
   */
  function step(world: World, unit: Entity, tick: number): void {
    const memory = memoryFor(unit)
    const previous = memory.state
    // SCAN FIRST, TURN AFTER. The order no longer changes what he SEES — sight
    // stopped reading his facing in ticket 086 — but `turn` below is still what
    // he does about what the scan found, and running it the other way round
    // would have him pose at a contact before the tick that acquired it.
    const target = acquire(world, unit, memory)
    const patrol = patrols.get(unit.id)
    let next: AiState

    if (target !== null) {
      // Seen. Remembered whether or not it is shootable, because this is the
      // position a pursuit walks to the moment sight is broken.
      memory.hasLastKnown = true
      memory.lastKnownX = target.x
      memory.lastKnownZ = target.z
      memory.hasTarget = true
      memory.targetId = target.id
      // Range is the WEAPON'S, asked of the weapon table rather than stated
      // here: a retune in `weapons.ts` must move the distance at which enemies
      // stop walking and start shooting, or the two quietly disagree. An unarmed
      // kind has no range at all and therefore never engages — it closes and
      // keeps closing, which is the honest behaviour for something that cannot
      // shoot back.
      // ASKED BY TEAM AS WELL AS KIND (ticket 036), for the same reason the
      // range is asked of the table at all: the enemy's rifle is shorter than
      // the squad's, so a lookup by kind alone would halt him at the PLAYER'S
      // eight tiles and leave him shooting from 1.6 tiles outside his own
      // envelope — closing to a distance at which he cannot hit anything.
      const spec = weaponFor(unit.kind, unit.team, difficulty)
      const rangeWorld = spec === null ? 0 : spec.rangeTiles * TILE_WORLD_SIZE
      /**
       * TWO THRESHOLDS, NOT ONE (ticket 037), and the gap between them is the
       * behaviour rather than a tolerance around it.
       *
       * He ENTERS `engage` only once the target is inside `closeToFraction` of
       * his range — the distance he actually wants to fight at, because the
       * accuracy curve is at its worst at the far edge of the envelope and the
       * old single threshold halted him at precisely that edge, for the rest of
       * the firefight, since nothing moves a man once `engage` is entered. He
       * LEAVES it only when the target passes beyond the FULL range, which is
       * the distance past which the rifle simply does not reach.
       *
       * A SINGLE THRESHOLD WOULD MAKE HIM VIBRATE. A man halted at his closing
       * distance stands a hair inside it; a target drifting a foot either way
       * would drop him to `pursue` and put him back into `engage` sixty times a
       * second. That is a soldier shaking on the spot, and it would also churn
       * `Memory.armedTargetId` — the reaction beat is armed per acquisition
       * precisely to survive boundary flicker (see the note below it), and a
       * second boundary that flickered faster is what that rule was written
       * against.
       *
       * THE WIDER THRESHOLD IS HELD PER TARGET, NOT PER STATE, and that
       * distinction is the whole correctness of this block.
       *
       * `previous === ENGAGE` alone is a question about the STATE MACHINE, not
       * about which man he was shooting at — so a soldier whose target went down,
       * or ducked behind cover while a second was visible, carried the full-range
       * threshold over to somebody he had never closed on. He engaged the new man
       * at the far edge of his envelope and halted there for the rest of the
       * firefight: verbatim the behaviour this ticket exists to delete,
       * reappearing on the most ordinary event in the game. Level 1 puts three
       * riflemen against a four-man squad, so "his target fell and he snapped to
       * the next one" is not an edge case, and it shipped in this ticket's first
       * draft with every test green.
       *
       * `armedTargetId` still holds LAST tick's target here — it is rewritten
       * further down — which is exactly the comparison wanted: did he arrive at
       * this tick already engaging THIS man? The same field, for the same reason,
       * as the reaction beat below.
       *
       * NO DIVISION AND NO NaN. An unarmed kind has `rangeWorld = 0`, a
       * fraction of zero is zero, and the `spec !== null` guard means neither
       * comparison is even reached — he closes forever and never engages,
       * exactly as before.
       */
      const closeWorld = rangeWorld * memory.closeToFraction
      const heldOnThisTarget =
        previous === ENGAGE && memory.hasArmedTarget && memory.armedTargetId === target.id
      const holdWorld = heldOnThisTarget ? rangeWorld : closeWorld
      if (spec !== null && inRange(unit.x, unit.z, target.x, target.z, holdWorld)) {
        next = ENGAGE
      } else {
        next = PURSUE
        aimErrandAt(memory, target.x, target.z)
        // The clock on a pursuit runs from the last sight of the man being
        // pursued, not from the start of the chase: a soldier who can still see
        // his target has not lost the trail, and retiring him on a timer while
        // the player is in plain view is the state names hiding a bug again.
        memory.deadline = tick + memory.pursueTimeoutTicks
      }
    } else if (previous === ENGAGE && memory.hasTarget && !world.isAlive(memory.targetId)) {
      // GUARDED ON `previous === ENGAGE`, DELIBERATELY. A man already in
      // `pursue` whose quarry is killed by somebody else keeps walking to the
      // last-known tile, and that is not an inconsistency: an engaging man
      // watched his target fall and knows there is nothing left to look for,
      // where a pursuing one never saw it happen. He finds out by arriving.
      //
      // HE WENT DOWN, which is not the same as getting away. Losing sight leaves
      // a question — where did he go? — and `pursue` is the answer to it; a dead
      // man leaves no question, so there is nothing to walk toward and nothing
      // to keep shooting at. Rounds poured into the spot where a corpse fell are
      // rounds the player watches an enemy waste. The man goes back to idle, and
      // because acquisition outranks memory anything else in sight is picked up
      // on the very next tick.
      next = IDLE
    } else if (previous === ENGAGE) {
      // Lost him, and he is still out there. Walk to where he was — the only
      // place a man who has just ducked out of sight can possibly be — and stop
      // shooting on the way, because the round would be going into the cover he
      // is behind rather than into him.
      if (memory.hasLastKnown) {
        next = PURSUE
        aimErrandAt(memory, memory.lastKnownX, memory.lastKnownZ)
        memory.deadline = tick + memory.pursueTimeoutTicks
      } else {
        next = IDLE
      }
    } else if (previous === PURSUE || previous === ALERT) {
      // An errand in progress, with nothing in sight to outrank it. It ends on
      // arrival, or on the timeout that stops an unreachable destination from
      // being walked at for the rest of the mission.
      next =
        !memory.hasGoal ||
        tick >= memory.deadline ||
        arrived(unit, memory) ||
        offTheLeash(unit, memory, patrol)
          ? IDLE
          : previous
    } else {
      // Idle, and therefore available to be curious. Gunfire is the only thing
      // that reaches a man who can see nothing; `alert` deliberately cannot
      // interrupt anything, which is why this branch is last.
      const rumour = nearestRumour(unit, memory.alertRadiusWorld)
      if (rumour === null) {
        next = IDLE
      } else {
        next = ALERT
        aimErrandAt(memory, rumour.x, rumour.z)
        memory.deadline = tick + memory.alertTimeoutTicks
      }
    }

    memory.state = next
    // BEFORE THE ORDERS BELOW, AND UNCONDITIONALLY, because the `engage` branch
    // returns early — twice — and a heading updated after it would never be
    // written for the men who are actually shooting at somebody.
    turn(unit, memory, next, target)

    /**
     * The post is fixed HERE, on the tick his beat is interrupted, and released
     * the tick he is back on it.
     *
     * Both halves matter. Anchoring on the transition is what makes it the place
     * he actually broke off from rather than wherever the chase has since taken
     * him; releasing it on the return is what makes the NEXT contact anchor
     * afresh, so a guard cannot inherit a post from an hour ago at the far end
     * of his route. `previous === IDLE` is the transition, and `!hasPost` covers
     * a unit whose route was assigned while he was already in contact — a
     * session hands out routes at build time, but nothing in the type forbids a
     * later one.
     *
     * Costs a `Map` lookup and a branch per unit per tick, and the scan behind
     * `anchorPost` only on the transition itself. A routeless enemy — which is
     * every enemy in the shipped game — reaches the `undefined` and stops.
     */
    if (patrol !== undefined) {
      if (next === IDLE) patrol.hasPost = false
      else if (previous === IDLE || !patrol.hasPost) anchorPost(unit, patrol)
    }

    if (next === ENGAGE) {
      // HALT ON ENTERING, NOT EVERY TICK. A man who walks into his own weapon's
      // range and keeps walking ends the engagement in knife range, which wastes
      // every piece of cover the level contains — but halting a man who is
      // already halted would take him out of a detachment he is not in, 60 times
      // a second, for as long as the firefight lasts.
      if (previous !== ENGAGE) stop(memory, unit.id)
      // THE BEAT IS ARMED PER TARGET ACQUISITION (ticket 012a) — see
      // `Memory.armedTargetId` for the rule and for the two failures that shape
      // it. Both halves of the condition carry weight. `previous !== ENGAGE` is
      // what keeps a NEARER attacker taking over the aim mid-firefight from
      // buying the first one a second beat; the id comparison is what keeps a
      // target flickering across the weapon's range boundary — out of `engage`
      // to `pursue` and straight back, on the same man — from restarting a beat
      // that would then never complete. The record is then written on every
      // engage tick, so it follows the aim and a switch followed by a flicker
      // costs nothing either. Going IDLE clears it, so a man who lost his quarry
      // found him again pays afresh.
      if (
        previous !== ENGAGE &&
        (!memory.hasArmedTarget || memory.armedTargetId !== memory.targetId)
      ) {
        memory.reactionRemaining = memory.reactionTicks
      }
      memory.hasArmedTarget = true
      memory.armedTargetId = memory.targetId
      if (memory.reactionRemaining > 0) {
        // Raising the rifle. FIRING IS THE ONLY THING HELD: he has already been
        // halted above, he keeps his target and his last-known position, and his
        // leash and post are untouched — a delay that also moved him would be a
        // retune of engagement distance wearing a reaction delay's name. No
        // `holdFire` either: a positive remainder and a standing fire order
        // cannot coexist. `aiming` starts false and only `shootAt` sets it,
        // `shootAt` is reached only once the remainder has run out, and every
        // tick that leaves `engage` passes through the cease below — so the only
        // way back to a positive remainder is through a tick that cleared the
        // order.
        memory.reactionRemaining -= 1
        return
      }
      if (target !== null) shootAt(memory, unit.id, target)
      return
    }

    // Everything below is a state that does not shoot. Ceasing fire is idempotent — `holdFire` returns immediately unless an
    // order stands — so it can be stated once here rather than per branch.
    holdFire(memory, unit.id)
    // NOTHING CLEARS THE REACTION REMAINDER HERE, and clearing it would be a
    // bug rather than a redundancy now: `pursue` is the state a man passes
    // through when his target steps outside the weapon's range, and zeroing the
    // remainder on the way would hand him a free round the moment it stepped
    // back in. What re-arming costs is decided above, off `armedTargetId`, and
    // the surviving remainder is kept out of `isReacting` by its state gate.
    if (next === IDLE) {
      // He is engaging nobody, so the next man he raises his rifle at is a
      // fresh contact and pays the beat — whether that is the one he just lost
      // or somebody else entirely. This is the ONE place the record is cleared;
      // see `Memory.armedTargetId`.
      memory.hasArmedTarget = false
      // A man retired mid-march has to be stopped, or he finishes walking to a
      // destination the machine has already given up on.
      if (previous === PURSUE || previous === ALERT) stop(memory, unit.id)
      // And only THEN, with the errand cancelled, may he pick his beat back up:
      // patrol is what a man does with nothing better to do, so it is the last
      // thing considered and the first thing anything else overrides.
      if (patrol !== undefined) patrolStep(memory, unit, patrol)
      return
    }
    // Off his beat: whatever he is walking to now, it is not a waypoint, and
    // the next idle tick must choose one rather than inherit this goal.
    memory.patrolling = false
    march(memory, unit.id)
  }

  function aiSystem(world: World): void {
    // Bury the memory of the dead. An id is never reused, so a leaked entry
    // could never be inherited by a live unit — but `stateOf` would keep
    // answering about a man who is gone, and the table would grow by one per
    // casualty for the length of the mission.
    // Walked LIVE, not over a copy of the keys. Deleting the entry a `Map`
    // iterator is standing on is defined behaviour — the walk continues from the
    // next entry, and an entry deleted before it is reached is simply never
    // visited — so the snapshot would buy nothing but an array per tick, for
    // every tick of the mission. It is safe to iterate a `Map` here at all only
    // because this loop DELETES and decides nothing: no simulation result can
    // depend on the order it happens to walk in.
    for (const id of memories.keys()) {
      if (!world.isAlive(id)) memories.delete(id)
    }
    // Routes go the same way, and for the same reason: a beat outliving the man
    // walking it is a table that grows by one per casualty for the length of the
    // mission. Deleting only, so the walk order still decides nothing. A route
    // assigned to an id that has never lived is dropped on the first tick, which
    // is the honest reading of "an unknown id is ignored".
    for (const id of patrols.keys()) {
      if (!world.isAlive(id)) patrols.delete(id)
    }
    // And any authored facing seeded for a man who never lived to be visited.
    // Normally empty by the end of the first tick — `memoryFor` takes the entry
    // — so this is only ever cleaning up after a `face` for an id that names
    // nothing, which the contract accepts and never acts on. Deleting only, so
    // the walk order still decides nothing.
    for (const id of pendingFacings.keys()) {
      if (!world.isAlive(id)) pendingFacings.delete(id)
    }

    // Spawn order, and nothing is added to or removed from the entity list by
    // anything below, so the plain index walk is safe: this pass issues orders
    // and never spawns or despawns.
    const entities = world.entities
    const tick = world.tickCount
    for (let i = 0; i < entities.length; i += 1) {
      const unit = entities[i]
      if (unit === undefined) continue
      if (unit.team !== team) continue
      step(world, unit, tick)
    }

    // Heard once, acted on once. Anything not reacted to this tick is stale by
    // the next one — a shot fired two ticks ago is not news — and leaving the
    // buffer full would alert a man over and over to the same round.
    rumourCount = 0
  }

  function hear(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event === undefined) continue
      if (event.type !== 'ShotFired') continue
      // The ORIGIN, not the target: what a man hears is the rifle going off, and
      // walking toward where the round landed would send him somewhere nobody
      // has ever been.
      const slot = rumours[rumourCount]
      if (slot === undefined) {
        rumours.push({ x: event.originX, z: event.originZ, shooterId: event.shooterId })
      } else {
        slot.x = event.originX
        slot.z = event.originZ
        slot.shooterId = event.shooterId
      }
      rumourCount += 1
    }
  }

  /**
   * See `AiSystem.assignPatrol`.
   *
   * THE ROUTE IS COPIED, not retained. The caller's array is a level document
   * the session read, and a route shared with it would let a second
   * `loadLevel` — or a `restart()` — edit the beat of a man already walking it.
   * `TileCoord` is readonly, so the elements themselves cannot be written
   * through, and this is a startup call rather than a per-tick one.
   *
   * Waypoints are CLAMPED to the grid rather than refused: a hand-authored
   * level with a waypoint one tile past the edge should produce a guard walking
   * to the edge, not a mission that will not start. A coordinate that is not a
   * number at all is dropped, because there is no honest tile to clamp it to.
   */
  function assignPatrol(unitId: number, route: readonly TileCoord[]): void {
    const copied: TileCoord[] = []
    for (let i = 0; i < route.length; i += 1) {
      const waypoint = route[i]
      if (waypoint === undefined) continue
      if (!Number.isFinite(waypoint.x) || !Number.isFinite(waypoint.y)) continue
      copied.push({
        x: Math.min(grid.w - 1, Math.max(0, Math.round(waypoint.x))),
        y: Math.min(grid.h - 1, Math.max(0, Math.round(waypoint.y))),
      })
    }
    // AN EMPTY ROUTE IS NO ROUTE, which is also how a route is taken away. Any
    // beat in progress ends here rather than at the next waypoint: a man whose
    // orders are withdrawn stands where he is.
    if (copied.length === 0) {
      patrols.delete(unitId)
      const forgotten = memories.get(unitId)
      if (forgotten !== undefined) forgotten.patrolling = false
      return
    }
    // The index is deliberately NOT chosen here — the first idle tick picks the
    // nearest waypoint, which is the same rule a resumption uses. Choosing at
    // assignment would make a man's first waypoint depend on where he happened
    // to spawn versus where he happened to be told, which are different moments.
    // NEITHER THE INDEX NOR THE POST IS CHOSEN HERE, and `hasPost: false` is
    // load-bearing rather than a lazy initialiser: this call has no entity to
    // measure from — the AI is handed a grid, not a world — so any post written
    // now would be a guess, and the guess this code shipped with was `{ 0, 0 }`,
    // the map centre. The first idle tick picks the index by the same
    // nearest-waypoint rule a resumption uses, and the first contact picks the
    // post; both are decided where the man's own position is known.
    patrols.set(unitId, { route: copied, index: 0, hasPost: false, postWorldX: 0, postWorldZ: 0 })
    const memory = memories.get(unitId)
    if (memory !== undefined) memory.patrolling = false
  }

  const stateOf = (unitId: number): AiState | undefined => memories.get(unitId)?.state

  /**
   * See `AiSystem.targetOf`.
   *
   * GATED ON `engage`, not merely on `hasTarget`. A pursuing man remembers the
   * id he was last shooting at — that is how losing a target is told apart from
   * killing one, above — but he is not shooting at it, and a ray drawn to a man
   * who has ducked behind a wall would show a sightline that does not exist.
   * The two facts are different and this reports the narrower one.
   */
  function targetOf(unitId: number): number | undefined {
    const memory = memories.get(unitId)
    if (memory === undefined) return undefined
    if (memory.state !== ENGAGE || !memory.hasTarget) return undefined
    return memory.targetId
  }

  /**
   * See `AiSystem.isReacting`.
   *
   * GATED ON `engage` AS WELL AS ON THE COUNT, like `targetOf` is — and the gate
   * is the SOLE guarantee here, not a restatement of the count. The remainder
   * SURVIVES leaving the state: nothing drains it, deliberately (see
   * `Memory.reactionRemaining`), so a man who breaks off five ticks into a
   * forty-five tick beat walks away carrying forty. Drop the state check and
   * ticket 025's alerted cue burns over him for the rest of the mission,
   * wherever he goes. A mutation removing it survived all 1803 tests before
   * `reaction.test.ts` pinned it.
   */
  function isReacting(unitId: number): boolean {
    const memory = memories.get(unitId)
    if (memory === undefined) return false
    return memory.state === ENGAGE && memory.reactionRemaining > 0
  }

  /** See `AiSystem.facingOf`. A fresh object per read; see there for why. */
  function facingOf(unitId: number): Facing | undefined {
    const memory = memories.get(unitId)
    if (memory === undefined) return undefined
    return { dx: memory.facingDx, dz: memory.facingDz }
  }

  /**
   * See `AiSystem.face`.
   *
   * NORMALISED THROUGH THE SAME `faceAlong` the machine's own decisions go
   * through, rather than a second spelling of the division: one place decides
   * what a valid facing is, so a caller's vector and a derived one cannot end up
   * held to different rules.
   *
   * A unit the machine has not met yet is PARKED rather than dropped — the
   * session seeds `SpawnPoint.facing` before the first tick, when no memory
   * exists to write into. `memoryFor` takes it from there. The degenerate check
   * is run BEFORE parking, so a refused vector is refused in both paths and
   * never sits waiting to become a NaN on the first tick.
   */
  function face(unitId: number, dx: number, dz: number): void {
    const memory = memories.get(unitId)
    if (memory !== undefined) {
      faceAlong(memory, dx, dz)
      return
    }
    const lengthSq = dx * dx + dz * dz
    if (!Number.isFinite(lengthSq) || lengthSq <= 0) return
    const length = Math.sqrt(lengthSq)
    pendingFacings.set(unitId, { dx: dx / length, dz: dz / length })
  }

  return Object.assign(aiSystem, {
    stateOf,
    targetOf,
    isReacting,
    hear,
    assignPatrol,
    facingOf,
    face,
  })
}
