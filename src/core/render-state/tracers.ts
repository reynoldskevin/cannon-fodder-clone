/**
 * The live tracer buffer (ticket 025a).
 *
 * A round leaves no mark, so the game's primary verb produced almost no
 * feedback. This is the half of the fix that can be tested: the decision about
 * which streaks are on screen right now, and how faded each of them is. Turning
 * that answer into geometry is `src/render/tracer-renderer.ts`, which is a loop
 * over what this returns — the same split ticket 014 used for the debug overlay,
 * and for the same reason: Vitest has no DOM, so anything decided inside a
 * three.js call is decided where no test can see it.
 *
 * TIME ARRIVES AS AN ARGUMENT, AND THAT IS TWO CONSTRAINTS AT ONCE. `src/core`
 * may not read a clock (ARCHITECTURE.md's engine-free boundary, enforced by
 * ESLint), and a tracer measured in SIM ticks would be a different length at 30
 * fps and at 144 fps — an afterimage is a fact about the display, not about the
 * mission. So `add` is told when the shot happened and `visible` is told what
 * time it is now, exactly the way `interpolateEntities` is told its alpha. The
 * caller passes the RENDERER's animation clock, which `main.ts` already
 * accumulates for the sprite animations and already resets on restart.
 *
 * NOT SIMULATION. Nothing here may reach a mission result: it is fed from
 * `ShotFired` after the fact and read by nothing the world can hear. A headless
 * replay and a rendered one produce the same mission whether or not anybody drew
 * a tracer, which is why this lives beside the interpolation rather than
 * anywhere near `core/world`.
 */

/**
 * The two endpoints of a round, as `ShotFired` already reports them.
 *
 * A structural subset of the event rather than the event itself, so this module
 * depends on no event type and the renderer can feed it a synthesised shot. The
 * endpoints are stored VERBATIM and never recomputed: ticket 011a already clamps
 * a round's far end to the near face of whatever it meets first, so a tracer
 * drawn to `targetX`/`targetZ` stops at the wall rather than passing through it,
 * with no geometry code here at all. Adjusting them would throw that away.
 */
export interface TracerShot {
  readonly originX: number
  readonly originZ: number
  readonly targetX: number
  readonly targetZ: number
}

/** One live tracer, as the renderer sees it. */
export interface Tracer extends TracerShot {
  /**
   * Unique for the life of the buffer. The renderer pools its quads by index and
   * may want to key per-tracer state off this; two tracers sharing an id would
   * drop one of them.
   */
  readonly id: number
  /** How far through its life this streak is, in `[0, 1)`. 0 is the muzzle. */
  readonly fade: number
}

export interface TracerBufferOptions {
  /** Slots. Past this the OLDEST tracer is dropped. */
  readonly capacity?: number
  /** How long a streak stays on screen, in real seconds. */
  readonly lifetimeSeconds?: number
}

export interface TracerBuffer {
  /** Record a shot, stamped with the renderer-clock time it was fired at. */
  add(shot: TracerShot, atSeconds: number): void
  /**
   * The tracers alive at `nowSeconds`, oldest first.
   *
   * A QUERY: it mutates nothing. Expiring entries here — the obvious spelling —
   * would make the answer depend on the order the questions were asked, and both
   * orders happen for real. A renderer may ask twice in one frame (once to size
   * a buffer, once to fill it), and a frame that hitches asks about a time it has
   * already run past. Asking about a later instant must not destroy the answer to
   * an earlier one.
   */
  visible(nowSeconds: number): Tracer[]
  /** The slot count this buffer was built with. */
  readonly capacity: number
}

/**
 * Slots by default.
 *
 * NOT A TUNING KNOB — HEADROOM. Level 1 fields five soldiers, and the rifle's
 * cooldown means a whole roster firing flat out is single digits of rounds in
 * any tracer lifetime. 128 is far above the worst volley the game can produce,
 * which is what makes eviction a safety net rather than part of the look.
 */
export const DEFAULT_TRACER_CAPACITY = 128

/**
 * How long a streak lives, in seconds.
 *
 * Short enough to read as a streak rather than a laser: at 0.12 s a round is a
 * flick the eye catches and loses, which is what says "something went that way"
 * without leaving a line drawn between the shooter and his target for anyone to
 * aim along.
 */
export const DEFAULT_TRACER_LIFETIME_SECONDS = 0.12

/** A stored tracer: the shot, plus the two numbers the buffer adds. */
interface Entry {
  id: number
  originX: number
  originZ: number
  targetX: number
  targetZ: number
  firedAt: number
}

/**
 * Build a bounded tracer buffer.
 *
 * A RING, NOT A GROWING ARRAY. This is fed straight off an event bus for the
 * length of a mission; an array that only ever pushes is a leak with a fuse on
 * it, and one that splices out the dead does O(n) work per frame to keep an
 * unbounded thing bounded. The ring is allocated once, at full capacity, and
 * every entry is overwritten in place — no allocation per shot, and no growth
 * path for the renderer's geometry to have to follow.
 *
 * When it does overflow, the OLDEST goes: the round that just went off matters
 * more to a player than one from four volleys ago.
 */
export function createTracerBuffer(options: TracerBufferOptions = {}): TracerBuffer {
  // Floored and floored to at least one slot: a zero-capacity ring has nowhere
  // to write and a fractional one indexes off the end of the array.
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_TRACER_CAPACITY))
  // A non-positive lifetime would make every tracer either instantly dead or
  // divide-by-zero faded, so it falls back rather than being honoured.
  const requested = options.lifetimeSeconds ?? DEFAULT_TRACER_LIFETIME_SECONDS
  const lifetimeSeconds = requested > 0 ? requested : DEFAULT_TRACER_LIFETIME_SECONDS

  // Pre-filled with real objects, so `add` never allocates and the slots are
  // never `undefined` for `noUncheckedIndexedAccess` to make everybody prove.
  const ring: Entry[] = []
  for (let i = 0; i < capacity; i += 1) {
    ring.push({ id: 0, originX: 0, originZ: 0, targetX: 0, targetZ: 0, firedAt: 0 })
  }

  /** Total shots ever added. Doubles as the id source, so ids never repeat. */
  let written = 0

  function add(shot: TracerShot, atSeconds: number): void {
    const slot = ring[written % capacity]
    // Unreachable — the ring is full of entries from construction and its length
    // never changes — but the index is computed, and `noUncheckedIndexedAccess`
    // is right to make that be said out loud rather than asserted away.
    if (slot === undefined) return
    written += 1
    slot.id = written
    // Verbatim. See `TracerShot`: the endpoints are already clamped.
    slot.originX = shot.originX
    slot.originZ = shot.originZ
    slot.targetX = shot.targetX
    slot.targetZ = shot.targetZ
    slot.firedAt = atSeconds
  }

  function visible(nowSeconds: number): Tracer[] {
    const out: Tracer[] = []
    // Oldest first. Once the ring has wrapped, the oldest live entry is the one
    // the next write will claim; before it wraps, it is slot 0. `written -
    // count` is both.
    const count = written < capacity ? written : capacity
    const first = written - count
    for (let i = 0; i < count; i += 1) {
      const entry = ring[(first + i) % capacity]
      if (entry === undefined) continue
      const age = nowSeconds - entry.firedAt
      // A tracer cannot be un-fired. Asked about a moment before it existed —
      // which a clock that steps backwards will do — it is at worst brand new;
      // a negative fade would light it BRIGHTER than a live round.
      const fade = age <= 0 ? 0 : age / lifetimeSeconds
      // Strictly less than 1, so nothing ever draws a fully faded streak: the
      // last frame of a tracer's life is the frame before it is gone, not a
      // transparent one held for a frame.
      if (fade >= 1) continue
      out.push({
        id: entry.id,
        originX: entry.originX,
        originZ: entry.originZ,
        targetX: entry.targetX,
        targetZ: entry.targetZ,
        fade,
      })
    }
    return out
  }

  return { add, visible, capacity }
}
