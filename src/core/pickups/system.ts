/**
 * The pickup system (ticket 017): one pass per tick that hands a chest to the
 * first living player unit who walks near it.
 *
 * THIS IS THE MIDDLE OF SOMETHING ALREADY BUILT AT BOTH ENDS. Ticket 013 left
 * `ObjectiveSystem.collectChest()` with a docstring admitting nothing called it,
 * so a `collect_chests` mission loaded, reported honest partial progress and
 * could never be finished. Ticket 016 left `Armoury.grant` written for exactly
 * this caller. Neither changes here; this file is the caller they were waiting
 * for, and a change to either end would be evidence the seam was wrong.
 *
 * CHESTS ARE NOT ENTITIES. `World.spawnFromLevel` draws that line itself — props
 * and chests are "drawn and collided with, not simulated as combatants", and
 * everything in `world.entities` is walked by `CombatSystem.pickTarget` and by
 * the AI every tick, so a chest in the live array would become a thing soldiers
 * stop and shoot at. They live in this system's own array, exactly as
 * projectiles do, and the renderer gets `remaining()` instead.
 *
 * THE LEVEL DOCUMENT IS NEVER TOUCHED. Chests are copied out of
 * `level.spawns.chests` at construction and collected out of the copy. Two
 * sessions are built from one document — that is what `restart()` is — so a
 * system that spliced collected chests out of the level would hand the second
 * run a map the first one emptied, and a replayed mission would be unwinnable.
 *
 * DETERMINISM. Chests are tested in LEVEL ORDER and the collector is the LOWEST
 * ENTITY ID in range — a fact about the world rather than about loop order,
 * which is the same tie-break `CombatSystem.pickTarget` uses. Nothing here draws
 * from `world.rng` and nothing iterates a `Map` to reach a result.
 */

import { inRange } from '../combat/resolution'
import { TILE_WORLD_SIZE, tileToWorld } from '../view/projection'
import type { LevelData, SpawnPoint } from '../level/types'
import type { SimSystem, World } from '../world/world'

/**
 * How close a man must come, in tiles, before a chest is his.
 *
 * A SQUAD HALTS WHERE IT HALTS. Formation spreads a detachment over more than a
 * tile, so requiring a man to stand on the chest's exact centre would make
 * collection feel like a bug rather than like a rule. Generous, but not a
 * magnet: much beyond this and chests start collecting themselves from across a
 * clearing and the player never learns where they were.
 */
export const DEFAULT_COLLECT_RADIUS_TILES = 1.5

/**
 * What a chest that names no reward gives.
 *
 * AN UNANNOTATED CHEST IS AN AUTHORING OMISSION, NOT AN EMPTY BOX. A chest that
 * gave nothing would read as broken rather than as empty — the player walks over
 * it, it disappears, and nothing happens. One grenade is the smallest thing that
 * still reads as loot.
 */
const DEFAULT_REWARD: Readonly<Record<string, number>> = Object.freeze({ grenade: 1 })

/** What this system needs of the objective system: somewhere to push a chest. */
export interface PickupObjectives {
  collectChest(): void
}

/**
 * What this system needs of the armoury: somewhere to put the rounds, and a way
 * to find out whether they landed.
 *
 * `count` IS PART OF THE CONTRACT, not a convenience. `grant` is a `void` that
 * silently refuses a negative, fractional or non-finite amount (ticket 016), and
 * `ChestCollectedEvent.reward` promises what was ACTUALLY handed over — so this
 * has to be able to observe the outcome. Asking the pouch what changed is the
 * only way to report it without keeping a second copy of `grant`'s rules here,
 * and two copies of that rule is precisely how they drift: relax the armoury and
 * the event under-reports, tighten it and the event announces rounds the player
 * never received.
 */
export interface PickupArmoury {
  grant(ordnance: string, rounds: number): void
  count(ordnance: string): number
}

/** Everything the pass needs that is not the level. */
export interface PickupOptions {
  /** Told once per chest taken, so a `collect_chests` mission can finish. */
  readonly objectives: PickupObjectives
  /** Where the reward lands. Its own guards are leaned on; see `collect`. */
  readonly armoury: PickupArmoury
  /** Collection reach in TILES. Defaults to `DEFAULT_COLLECT_RADIUS_TILES`. */
  readonly radiusTiles?: number
}

/**
 * A chest still on the map, as the renderer sees it.
 *
 * A snapshot value: see `PickupSystem.remaining`.
 */
export interface RemainingChest {
  /**
   * Its position in `level.spawns.chests` — stable and unique for the whole
   * mission, so a renderer can pool per-chest state by it the way it pools by
   * entity id.
   */
  readonly index: number
  /** The authored tile. */
  readonly tileX: number
  readonly tileY: number
  /** The world point that tile sits at. */
  readonly x: number
  readonly z: number
  /** The resolved grant, already read out of the document. */
  readonly reward: Readonly<Record<string, number>>
}

/**
 * The per-tick pickup pass, with the read API attached.
 *
 * A callable object rather than two separate things, exactly like `CombatSystem`
 * and `OrdnanceSystem`: it is registered with `world.addSystem`, which wants a
 * plain `SimSystem`, and the renderer needs somewhere to ask what is left.
 * Splitting them would hand callers two halves of one piece of state and trust
 * them to keep the pair together.
 */
export interface PickupSystem extends SimSystem {
  /**
   * Every uncollected chest, in level order.
   *
   * FRESH OBJECTS IN A FRESH ARRAY, never the live one. Handing back the
   * system's own storage is the obvious allocation win and it means a renderer
   * holding last frame's list watches chests vanish out from under it mid-draw —
   * the trap `render-state/tracers.ts` and `ordnance/system.ts` have each
   * already had caught once.
   */
  remaining(): RemainingChest[]
}

/**
 * A chest as the system stores it.
 *
 * The stored shape and the reported one are the same today, and the alias is
 * kept so they need not stay that way: a chest that later grows state the
 * renderer has no business seeing changes only this line, not `remaining`'s
 * return type.
 */
type Chest = RemainingChest

/**
 * A hand-authored `reward` field as a table of grants.
 *
 * A LEVEL DOCUMENT IS HAND-AUTHORED and survives a JSON round trip badly, so
 * `reward` arrives as `unknown` and is read rather than trusted. Anything that
 * is not a plain table of numbers cannot be a reward at all — a string, a
 * number, an array, `null` — and is treated as an omission, which is the case
 * `DEFAULT_REWARD` already exists for.
 *
 * THE NUMBERS THEMSELVES ARE NOT VETTED HERE, deliberately. `Armoury.grant`
 * already refuses non-positive, fractional and non-finite counts (ticket 016)
 * and refuses names its selector cannot show. A second copy of that guard here
 * would be a second answer to the same question, free to drift from the first —
 * and the first is the one the rest of the game spends through.
 */
function readReward(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_REWARD
  const out: Record<string, number> = {}
  let any = false
  for (const key of Object.keys(value)) {
    const amount = (value as Record<string, unknown>)[key]
    if (typeof amount !== 'number') continue
    out[key] = amount
    any = true
  }
  // A table with nothing numeric in it named no reward either.
  return any ? out : DEFAULT_REWARD
}

/**
 * Build the pickup pass over `level`.
 *
 * A factory rather than a bare `SimSystem`, for the reason `createCombatSystem`
 * gives: the chest list lives for the whole mission and belongs to ONE world.
 * Module-level mutable state here would let two worlds share it, which is the
 * determinism failure that is hardest to reproduce — it depends on which test
 * ran first.
 */
export function createPickupSystem(level: LevelData, options: PickupOptions): PickupSystem {
  const { objectives, armoury } = options
  // Converted from tiles to WORLD units here, at the one place the two spaces
  // meet, exactly as `combat/system.ts` converts `WeaponSpec.rangeTiles`.
  // `inRange` is unit-agnostic on purpose, and today `TILE_WORLD_SIZE` is 1 so
  // this multiply changes nothing — but omitting it would leave this the only
  // place the scale factor is not applied, and a later change to the tile size
  // would make the reach silently wrong by exactly that factor.
  const reachWorld = (options.radiusTiles ?? DEFAULT_COLLECT_RADIUS_TILES) * TILE_WORLD_SIZE

  /**
   * The chests still out there, in level order — which is the order they are
   * tested in and reported in, and therefore the order two identical missions
   * agree on.
   *
   * A plain array compacted in place, built ONCE from a document this system
   * only ever reads. The per-tick pass allocates nothing.
   */
  const chests: Chest[] = []
  {
    const points: readonly SpawnPoint[] = level.spawns.chests
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i]
      if (point === undefined) continue
      // A chest authored off the map is still a chest. `tileToWorld` is pure
      // arithmetic with no clamp, so it lands somewhere nobody can reach and is
      // simply never collected — which beats refusing to load the level.
      const where = tileToWorld(point.x, point.y, level.size)
      chests.push({
        index: i,
        tileX: point.x,
        tileY: point.y,
        x: where.x,
        z: where.z,
        reward: readReward(point['reward']),
      })
    }
  }

  /**
   * Who takes this chest: the lowest-id living PLAYER unit within reach, or
   * `null` if nobody is.
   *
   * ONLY THE PLAYER COLLECTS. An enemy walking over an ammo crate would empty it
   * by accident, and from the player's side that is indistinguishable from the
   * chest having despawned on its own.
   *
   * THE LOWEST ID RATHER THAN THE FIRST FOUND. `world.entities` is spawn-ordered
   * today, so the two agree — but the tie-break has to be a fact about the world
   * rather than about this loop, or the day compaction reorders the array two
   * identical missions start disagreeing about who picked what up.
   */
  function collectorFor(world: World, chest: Chest): number | null {
    let best: number | null = null
    const entities = world.entities
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i]
      if (entity === undefined) continue
      if (entity.team !== 'player') continue
      // A dead man collects nothing. `world.entities` holds only the living, so
      // this is belt and braces against an entity whose health has been zeroed
      // within the tick but not yet despawned.
      if (entity.health <= 0) continue
      if (best !== null && entity.id > best) continue
      if (!inRange(entity.x, entity.z, chest.x, chest.z, reachWorld)) continue
      best = entity.id
    }
    return best
  }

  /**
   * Hand the chest over. Pays, then announces.
   *
   * THE EVENT REPORTS WHAT LANDED, NOT WHAT THE TABLE OFFERED, which is why the
   * grant happens first. A kill feed reads this and nothing else — the bus is
   * the only channel from sim to presentation — so a chest whose table says
   * `{ grenade: -5, rocket: 2 }` must announce the rocket and say nothing at all
   * about the grenade. Echoing the table verbatim had the feed render "+ -5
   * grenades" beside a pouch that had not moved.
   *
   * THE GRANT'S GUARDS STAY THE ARMOURY'S. What was accepted is MEASURED — the
   * pouch is asked what changed — rather than predicted by re-testing `grant`'s
   * conditions here. A second copy of that rule would be free to drift from the
   * first, and the first is the one the rest of the game spends through.
   *
   * The `pending`/`granted` pair is allocated per COLLECTION, which is bounded by
   * the number of chests on the map. Nothing here runs on a tick that collects
   * nothing.
   */
  function collect(world: World, chest: Chest, collectorId: number): void {
    const granted: Record<string, number> = {}
    for (const ordnance of Object.keys(chest.reward)) {
      const amount = chest.reward[ordnance]
      if (amount === undefined) continue
      const before = armoury.count(ordnance)
      armoury.grant(ordnance, amount)
      const gained = armoury.count(ordnance) - before
      // A refused grant moves nothing and is therefore reported as nothing. The
      // finiteness test is arithmetic rather than validation: the rifle's count
      // is `Infinity`, and `Infinity - Infinity` is `NaN`, which must not reach
      // an event that presentation renders as a number.
      if (Number.isFinite(gained) && gained > 0) granted[ordnance] = gained
    }
    // AFTER the pouch and BEFORE the objective is told, so a consumer that reads
    // the armoury on this event sees the rounds it has just been told about —
    // the coherent-world half of the ordering contract `Explosion` holds against
    // the deaths it causes.
    world.emit({
      type: 'ChestCollected',
      index: chest.index,
      x: chest.x,
      z: chest.z,
      collectorId,
      reward: granted,
    })
    objectives.collectChest()
  }

  function pickupSystem(world: World): void {
    // Most ticks have nothing to do and every mission ends with nothing left, so
    // the common case costs one comparison.
    if (chests.length === 0) return
    // One pass, in level order, that both awards and compacts. `write` trails
    // `i` by however many chests have been taken, so the survivors keep their
    // relative order and the array never allocates.
    //
    // AWARDED IN THE SAME PASS THAT REMOVES IT, which is what makes a chest
    // collected EXACTLY ONCE with the whole squad standing on it. Five men
    // arriving together is the normal case, not an edge one — a detachment moves
    // as a detachment — so awarding per man in range would quintuple every chest
    // in the game, and the bug would look like generous loot rather than a
    // defect.
    let write = 0
    for (let i = 0; i < chests.length; i += 1) {
      const chest = chests[i]
      if (chest === undefined) continue
      const collectorId = collectorFor(world, chest)
      if (collectorId !== null) {
        collect(world, chest, collectorId)
        continue
      }
      chests[write] = chest
      write += 1
    }
    chests.length = write
  }

  function remaining(): RemainingChest[] {
    const out: RemainingChest[] = []
    for (let i = 0; i < chests.length; i += 1) {
      const chest = chests[i]
      if (chest === undefined) continue
      out.push({
        index: chest.index,
        tileX: chest.tileX,
        tileY: chest.tileY,
        x: chest.x,
        z: chest.z,
        // THE COPY GOES ONE LEVEL DOWN, and stopping at the array and the chest
        // is the version of this bug that survives a fresh-array test. Handing
        // out the system's own table lets a renderer that pokes at it change
        // what the next man to walk over the chest receives. It also made the
        // two kinds of chest behave differently for no reason a caller could
        // see: an unannotated one shares the frozen `DEFAULT_REWARD` and
        // silently ignores writes, an annotated one accepted them.
        reward: { ...chest.reward },
      })
    }
    return out
  }

  return Object.assign(pickupSystem, { remaining })
}
