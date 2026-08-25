/**
 * The objective system (ticket 013): one pass per tick that decides whether the
 * mission is over, and the only thing that emits `MissionComplete` or
 * `MissionFailed`.
 *
 * REGISTERED LAST, after the systems whose results it judges. A mission is
 * judged on the world as it stands at the END of the tick, so the last enemy
 * killed by this tick's combat pass ends the mission in this tick and not the
 * next. Registered anywhere earlier and every mission ends one tick late, which
 * is invisible on screen and wrong in every replay.
 *
 * HOW IT LEARNS ABOUT DEATHS, which is the one real design decision here.
 * `kill_count` counts `UnitDied` events for enemy units, and this system may
 * NOT call `world.drainEvents()`: the drain is exactly-once and belongs to
 * presentation, so a system that drained for itself would silently starve the
 * HUD, FX and audio of everything it swallowed (`core/session/index.ts` says
 * the same thing about the AI). It cannot be handed the batch the way
 * `AiSystem.hear` is, either — `addSystem` calls it with nothing but the world,
 * and the session does not drain until the tick is over. So it PEEKS: it reads
 * `world.peekEvents()` and keeps its own high-water `seq`, which is what makes
 * the read idempotent across a frame that ran eight steps without a drain
 * between them.
 *
 * The alternative considered and rejected was surveying the world instead —
 * "enemies the level spawned, minus enemies still living". It reads no events
 * at all, and it is wrong twice: a mission whose squad and last enemy are both
 * gone before the first tick has no memory that anyone ever died (so it cannot
 * tell a wiped-out squad from a mission that has not started), and any enemy
 * that ever leaves the field without dying breaks `kill_count` for good.
 *
 * THE LATCH. After either outcome this system evaluates nothing, counts nothing
 * and emits nothing. A squad wiped out on the same tick the last enemy falls
 * must resolve one way rather than flicker, and a squad walking into an ambush
 * during the victory animation must not turn the win into a loss.
 *
 * AND THE TIE GOES TO `MissionFailed`. At `INFANTRY_HEALTH = 1` mutual
 * simultaneous kills are ordinary — combat decides a whole volley against one
 * snapshot precisely so that two men who see each other both die — so this tie
 * happens in real play. A player whose last man dies as the last enemy falls
 * did not win, and a game that awards the mission to a dead squad reads as a
 * bug even to the player it flatters.
 */

import { countLiving, evaluateMission, missionWon } from './evaluation'
import { SQUAD_WIPED_OUT } from './types'
import type { MissionOutcome, ObjectiveProgress, ObjectiveSystem } from './types'
import type { LevelData } from '../level/types'
import type { World } from '../world/world'

/** Build the objective pass for `level`. One per mission; it holds mission state. */
export function createObjectiveSystem(level: LevelData): ObjectiveSystem {
  /** `UnitDied` events seen for each side, over the whole mission. */
  let enemyDeaths = 0
  let playerDeaths = 0
  let chestsCollected = 0

  /**
   * The `seq` of the last event read.
   *
   * Sequence numbers are strictly increasing across the whole mission and never
   * reset, so "greater than this" is exactly "not yet counted" — however many
   * ticks run between two drains. A flag or a buffer length would both count
   * the same death twice on a frame that ran several steps.
   */
  let lastSeq = -1

  let elapsed = 0
  let resolved: MissionOutcome = 'playing'

  /** Whether a unit has ever existed in this world. Latched; see the tick pass. */
  let started = false

  /**
   * The last evaluation, handed out as-is.
   *
   * Frozen and replaced wholesale rather than mutated, so a HUD holding last
   * tick's array is holding last tick's numbers and not a half-updated view of
   * this tick's. After the latch it stops being replaced at all, which is what
   * "stops evaluating" means: progress the player is shown agrees with the
   * screen he is looking at forever after.
   */
  let snapshot: readonly ObjectiveProgress[] = evaluateMission(level, null, {
    enemyDeaths: 0,
    chestsCollected: 0,
  })

  /** Read every event emitted since the last read; count the deaths. */
  function observe(world: World): void {
    const pending = world.peekEvents()
    for (let i = 0; i < pending.length; i += 1) {
      const event = pending[i]
      if (event === undefined || event.seq <= lastSeq) continue
      lastSeq = event.seq
      if (event.type !== 'UnitDied') continue
      if (event.team === 'enemy') enemyDeaths += 1
      else playerDeaths += 1
    }
  }

  /**
   * Whether the squad has been wiped out.
   *
   * A DEATH IS REQUIRED, not merely an empty roster. A world between
   * `createSession` and `spawnFromLevel` has no living player either, and a
   * wipe check that counted only the living would declare the mission lost
   * before the first man was placed. Ids are never reused and nothing removes a
   * player unit except a death, so "one of ours has died and none are left" is
   * the whole of it.
   */
  function squadWipedOut(world: World): boolean {
    return playerDeaths > 0 && countLiving(world, 'player') === 0
  }

  /**
   * Which objective to name on `MissionComplete`: the one that finished the
   * mission.
   *
   * The one that flipped to complete on this tick, taking the last if several
   * did — several can, since combat resolves a whole volley at once. Falling
   * back to the last in the level's list covers the mission that was already
   * won on its first evaluation, where nothing flipped because nothing had a
   * previous state to flip from.
   */
  function finishedBy(
    before: readonly ObjectiveProgress[],
    after: readonly ObjectiveProgress[],
  ): string {
    let named = after[after.length - 1]?.type ?? ''
    for (let i = 0; i < after.length; i += 1) {
      const now = after[i]
      if (now === undefined || !now.complete) continue
      if (before[i]?.complete !== true) named = now.type
    }
    return named
  }

  function pass(world: World): void {
    // The latch, and it is the FIRST thing: a resolved mission ages no timer,
    // counts no death and re-evaluates nothing.
    if (resolved !== 'playing') return

    elapsed += 1
    observe(world)

    // A MISSION NOBODY IS FIGHTING YET IS NOT JUDGED AT ALL. An empty world is
    // a session between `createSession` and `spawnFromLevel`, and it satisfies
    // both endings at once on the emptiest of technicalities: no living enemy
    // is a `kill_all` complete, and no living player is a squad wiped out. Once
    // a unit has existed the mission has started, and it stays started — a
    // world emptied by the fighting is exactly the case that must be judged.
    if (!started) started = world.entityCount > 0 || enemyDeaths + playerDeaths > 0
    if (!started) return

    const before = snapshot
    snapshot = evaluateMission(level, world, { enemyDeaths, chestsCollected })

    // FAILURE IS TESTED FIRST. That is the tie, decided; see the header.
    if (squadWipedOut(world)) {
      resolved = 'failed'
      world.emit({ type: 'MissionFailed', reason: SQUAD_WIPED_OUT })
      return
    }
    if (missionWon(snapshot)) {
      resolved = 'complete'
      world.emit({ type: 'MissionComplete', objective: finishedBy(before, snapshot) })
    }
  }

  const system = Object.assign(pass, {
    progress: (): readonly ObjectiveProgress[] => snapshot,
    outcome: (): MissionOutcome => resolved,
    collectChest: (): void => {
      chestsCollected += 1
    },
  })

  // A GETTER, DEFINED RATHER THAN ASSIGNED. `Object.assign` copies the VALUE a
  // getter returns, so spelling `elapsedTicks` in the object above would freeze
  // the mission timer at zero — and it would keep answering, which is the kind
  // of wrong that gets shipped.
  Object.defineProperty(system, 'elapsedTicks', {
    enumerable: true,
    get: (): number => elapsed,
  })

  return system as ObjectiveSystem
}
