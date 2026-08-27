/**
 * The live effects buffer (ticket 025).
 *
 * Grenades and rockets were invisible: `Explosion` was emitted, the ordnance
 * resolved, men died — and nothing appeared on screen, so a player could not
 * tell a detonation from a coincidence. This is the half of that fix which can
 * be tested: the decision about which effects are on screen right now, what size
 * each one is and how far through its life it has got. Turning that answer into
 * geometry is `src/render/fx-renderer.ts`, which is a loop over what this
 * returns.
 *
 * DELIBERATELY THE SAME SHAPE AS `tracers.ts`, DOWN TO THE METHOD NAMES. Both
 * are fed off the event bus, both are read once a frame by a renderer that
 * cannot grow its geometry, and both have to expire on a clock `src/core` is not
 * allowed to read. A second pattern for the same problem would be two things to
 * keep correct; anything true of the ring below is already argued at length
 * there, and the arguments are not repeated here except where this module
 * differs.
 *
 * WHERE IT DIFFERS: an effect's lifetime comes from its KIND rather than from a
 * constructor option (see `FX_LIFETIME_SECONDS`), and an effect carries a
 * `scale`, because `Explosion` reports the radius of the blast and a burst that
 * ignored it would make a rocket and a grenade look identical.
 *
 * TIME ARRIVES AS AN ARGUMENT. `src/core` may not read a clock (ARCHITECTURE.md's
 * engine-free boundary, enforced by ESLint), and an effect measured in SIM ticks
 * would last a different span of wall time at 30 fps and at 144 — a flash is a
 * fact about the display, not about the mission. So `add` is told when the thing
 * happened and `visible` is told what time it is now. The caller passes the
 * RENDERER's animation clock, which `main.ts` already accumulates and already
 * resets on restart.
 *
 * NOT SIMULATION. Nothing here may reach a mission result: it is fed from
 * `ShotFired`, `Explosion` and `UnitDied` after the fact and read by nothing the
 * world can hear. A headless replay and a rendered one produce the same mission
 * whether or not anybody drew a burst, which is exactly why this layer could be
 * added this late without touching `core/ordnance` or `core/combat` — and why it
 * must never import from either.
 */

/**
 * Every kind of effect the game can stage.
 *
 * A TUPLE RATHER THAN A UNION SPELLED OUT TWICE, so `FX_LIFETIME_SECONDS` is a
 * `Record` the compiler checks for completeness and a test can iterate the kinds
 * without being handed a list that has drifted from the type. Adding a kind here
 * is a compile error everywhere it has to be handled, which is the point.
 */
export const FX_KINDS = ['muzzle', 'burst'] as const

export type FxKind = (typeof FX_KINDS)[number]

/**
 * How long each kind stays on screen, in real seconds.
 *
 * PER KIND, NOT ONE SHARED NUMBER. A muzzle flash is a blink at 0.05 s and a
 * detonation hangs for 0.4; one lifetime tuned for either makes the other look
 * broken, and it reads as "the effects are bad" rather than as a number somebody
 * chose. The spread was wider while the 45-second scorch mark (ticket 047) and
 * the 1.2-second death puff (051) were here, and the argument does not depend on
 * how many kinds there are — eight times is still more than one number serves.
 */
export const FX_LIFETIME_SECONDS: Record<FxKind, number> = {
  /**
   * The flash at the barrel.
   *
   * SHORTER THAN THE TRACER IT ACCOMPANIES (0.12 s), because the flash marks the
   * instant of firing and the streak carries the eye afterwards. RAISE IT and a
   * rifle at full cadence never stops glowing, so the shooter's position reads as
   * a lamp rather than as a man firing; LOWER IT much and a frame at 30 fps can
   * fall between two flashes and miss them entirely.
   */
  muzzle: 0.05,
  /**
   * The detonation itself.
   *
   * RAISE IT and the blast lingers over the bodies it made, which hides the very
   * thing the player threw it to see; LOWER IT and a grenade at the edge of the
   * screen is over before the eye reaches it.
   */
  burst: 0.4,
}

/**
 * What a caller knows about an effect when it asks for one.
 *
 * A STRUCTURAL SHAPE RATHER THAN AN EVENT TYPE, so this module depends on no
 * event and cannot be tempted into reading one: `main.ts` turns `Explosion` into
 * a burst, and this never learns that ordnance exists.
 */
export interface FxSpawn {
  readonly kind: FxKind
  /** World position on the ground plane. */
  readonly x: number
  readonly z: number
  /**
   * How big it is, in world units, relative to the kind's own natural size.
   *
   * STORED VERBATIM, NEVER RECOMPUTED. `Explosion` already reports its
   * `radiusTiles`; a burst that derived its own size would be a second opinion
   * about how big the detonation was, and the two would disagree the day the
   * ordnance table is retuned.
   */
  readonly scale: number
  /**
   * HEIGHT ABOVE THE GROUND, in world units. Defaults to nothing, which is
   * "wherever the terrain is under it" — the right answer for almost everything.
   *
   * IT EXISTS FOR AIRBURSTS. `ExplosionEvent` carries a `y` and says why in
   * capitals: a fuse that expires before impact detonates the round in mid-air,
   * and an airburst reported on the ground would hide the whole mechanic. The
   * grenade's fuse makes that reachable in ordinary play, so an FX layer that
   * dropped this would draw the one thing the event goes out of its way to
   * report as if it had never happened.
   *
   * RELATIVE, NOT ABSOLUTE. The renderer samples the terrain under the effect
   * and adds this to it, so a burst over a hillside sits above the hillside
   * rather than sinking into it — and `core` still needs to know nothing about
   * the terrain's shape, which it must not.
   */
  readonly y?: number
}

/** One live effect, as the renderer sees it. */
export interface Fx extends FxSpawn {
  /**
   * Unique for the life of the buffer. The renderer pools by index and may want
   * to key per-effect state off this; two effects sharing an id would drop one.
   */
  readonly id: number
  /** How far through its life this effect is, in `[0, 1)`. 0 is the instant it happened. */
  readonly fade: number
}

export interface FxBufferOptions {
  /** Slots. Past this the OLDEST effect is dropped. */
  readonly capacity?: number
}

export interface FxBuffer {
  /** Record an effect, stamped with the renderer-clock time it happened at. */
  add(spawn: FxSpawn, atSeconds: number): void
  /**
   * The effects alive at `nowSeconds`, oldest first.
   *
   * A QUERY: it mutates nothing. Expiring entries here — the obvious spelling —
   * would make the answer depend on the order the questions were asked, and both
   * orders happen for real. A renderer may ask twice in one frame (once to size
   * a buffer, once to fill it), and a frame that hitches asks about a time it has
   * already run past. Asking about a later instant must not destroy the answer to
   * an earlier one.
   */
  visible(nowSeconds: number): Fx[]
  /** The slot count this buffer was built with. */
  readonly capacity: number
}

/**
 * Slots by default.
 *
 * NOT A TUNING KNOB — HEADROOM, and sized for the SHORT-LIVED kinds. Level 1
 * fields five soldiers, and inside a 0.4 s burst even a squad throwing
 * everything it carries is single digits of detonations; the flashes are the
 * volume, and the rifle's cooldown caps those too. 64 is far above the worst
 * second the game can produce, which is what makes eviction a safety net rather
 * than part of the look.
 *
 * `capacity` IS STILL AN ARGUMENT, and it is worth keeping one even though every
 * caller now takes the default. It was added for the decal pool ticket 047
 * deleted — scars lived 45 s, so their pool was sized in "marks a map can carry"
 * rather than "things happening at once" — and the next long-lived effect will
 * want the same escape hatch. It costs a parameter with a default; a ring that
 * could only ever be 64 would have to grow one back.
 */
export const DEFAULT_FX_CAPACITY = 64

/** A stored effect: the spawn, plus the two numbers the buffer adds. */
interface Entry {
  id: number
  kind: FxKind
  x: number
  z: number
  /** Height above the ground. Stored as a plain number, 0 meaning "on it". */
  y: number
  scale: number
  spawnedAt: number
}

/**
 * Build a bounded effects buffer.
 *
 * A RING, NOT A GROWING ARRAY. This is fed straight off an event bus for the
 * length of a mission; an array that only ever pushes is a leak with a fuse on
 * it, and one that splices out the dead does O(n) work per frame to keep an
 * unbounded thing bounded. The ring is allocated once, at full capacity, and
 * every entry is overwritten in place — no allocation per effect, and no growth
 * path for the renderer's geometry to have to follow.
 *
 * When it does overflow, the OLDEST goes: the grenade that just went off matters
 * more to a player than one from four volleys ago.
 *
 * A SECOND POOL WOULD BE A SECOND INSTANCE OF THIS, NOT A SECOND MODULE, and
 * there was one until ticket 047: the 45-second scorch mark could not share a
 * ring with a 0.4-second burst, because one busy second would evict every mark on
 * the map. That argument was always about CAPACITY rather than about code, which
 * is why `capacity` is an argument and why a duplicate implementation would have
 * been a second thing to keep correct. Every effect is short-lived now and one
 * ring holds them all.
 */
export function createFxBuffer(options: FxBufferOptions = {}): FxBuffer {
  // Floored, and floored to at least one slot: a zero-capacity ring has nowhere
  // to write and a fractional one indexes off the end of the array.
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_FX_CAPACITY))

  // Pre-filled with real objects, so `add` never allocates and the slots are
  // never `undefined` for `noUncheckedIndexedAccess` to make everybody prove.
  const ring: Entry[] = []
  for (let i = 0; i < capacity; i += 1) {
    ring.push({ id: 0, kind: 'burst', x: 0, z: 0, y: 0, scale: 1, spawnedAt: 0 })
  }

  /** Total effects ever added. Doubles as the id source, so ids never repeat. */
  let written = 0

  function add(spawn: FxSpawn, atSeconds: number): void {
    const slot = ring[written % capacity]
    // Unreachable — the ring is full of entries from construction and its length
    // never changes — but the index is computed, and `noUncheckedIndexedAccess`
    // is right to make that be said out loud rather than asserted away.
    if (slot === undefined) return
    written += 1
    slot.id = written
    slot.kind = spawn.kind
    slot.x = spawn.x
    slot.z = spawn.z
    // Verbatim. See `FxSpawn.scale`.
    // `?? 0` and not `spawn.y!`: height is optional and almost always absent,
    // and a slot reused from a previous airburst must not inherit its altitude.
    slot.y = spawn.y ?? 0
    slot.scale = spawn.scale
    slot.spawnedAt = atSeconds
  }

  function visible(nowSeconds: number): Fx[] {
    const out: Fx[] = []
    // Oldest first. Once the ring has wrapped, the oldest live entry is the one
    // the next write will claim; before it wraps, it is slot 0. `written -
    // count` is both.
    const count = written < capacity ? written : capacity
    const first = written - count
    for (let i = 0; i < count; i += 1) {
      const entry = ring[(first + i) % capacity]
      if (entry === undefined) continue
      const age = nowSeconds - entry.spawnedAt
      // An effect cannot un-happen. Asked about a moment before it existed —
      // which a clock that steps backwards will do — it is at worst brand new; a
      // negative fade would draw it BRIGHTER than a live one.
      const fade = age <= 0 ? 0 : age / FX_LIFETIME_SECONDS[entry.kind]
      // Strictly less than 1, so nothing ever draws a fully faded effect: the
      // last frame of a burst's life is the frame before it is gone, not a
      // transparent one held for a frame.
      if (fade >= 1) continue
      out.push({
        id: entry.id,
        kind: entry.kind,
        x: entry.x,
        z: entry.z,
        y: entry.y,
        scale: entry.scale,
        fade,
      })
    }
    return out
  }

  return { add, visible, capacity }
}
