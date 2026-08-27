/**
 * Which sound an event asks for, where it sits in the stereo field, and whether
 * it is allowed to start (ticket 027).
 *
 * DELIBERATELY THE SAME SPLIT AS THE FX LAYER, FOR THE SAME REASON. Vitest has
 * no `AudioContext`, so anything decided inside a Web Audio call is decided
 * where no test can see it. This module DECIDES — event to cue, world position
 * to pan and gain, and how many voices may be alive at once — and `src/audio`
 * owns the graph and makes the noise. `src/audio` is a declared sibling layer in
 * `eslint.config.js`, so `core` may not reach into it and does not need to.
 *
 * TIME ARRIVES AS AN ARGUMENT, exactly as it does in `render-state/tracers.ts`
 * and `render-state/fx.ts`. `src/core` may not read a clock (ARCHITECTURE.md's
 * engine-free boundary, enforced by ESLint), so the voice limiter is TOLD when a
 * voice started and how long it runs, and ASKED what is live at a given instant.
 * The caller passes `AudioContext.currentTime`, which is the only clock the
 * voices are actually scheduled against.
 *
 * NOT SIMULATION. Nothing here may reach a mission result: it is fed from the
 * drained event batch after the fact, and read by nothing the world can hear. A
 * headless replay and a rendered one produce the same mission whether or not
 * anybody ever heard a rifle — which is why `cueFor` may not draw from
 * `world.rng` for its death variation, and takes the unit's id instead. See
 * `variantForId`.
 */

import type { SimEvent } from '../world/events'

// ---------------------------------------------------------------------------
// The cues
// ---------------------------------------------------------------------------

/**
 * Every sound the game can ask for.
 *
 * A TUPLE RATHER THAN A UNION SPELLED OUT TWICE, the same bargain `FX_KINDS`
 * makes: `CUE_IS_POSITIONAL` below is a `Record` the compiler checks for
 * completeness, and a test can iterate the cues without being handed a list that
 * has drifted from the type.
 *
 * THE CUE LIST IS NOT THE ASSET FOLDER. `chest` is here and no `chest.wav` was
 * shipped; the two `throw` cues are here and nothing on the bus carries them yet
 * (see `cueFor`'s `ShotFired` arm). A cue with no file is skipped by the player
 * without throwing — a missing sound is a missing sound, not a broken mission —
 * and the day somebody drops the file in, nothing in `core` has to change.
 * Merging the two questions is how a mapping ends up describing an asset
 * directory instead of the game.
 */
export const CUES = [
  'rifle',
  'grenade-throw',
  'rocket-launch',
  'explosion',
  'death',
  'chest',
  'victory',
  'defeat',
] as const

export type Cue = (typeof CUES)[number]

/**
 * Whether a cue is placed in the world, and therefore panned.
 *
 * A COMPLETE `Record`, so adding a cue is a compile error here rather than a
 * sound that silently plays dead centre. It also decides the DOWNMIX: every
 * asset shipped is stereo and a `StereoPannerNode` cannot place a stereo source
 * — the image it already has fights the pan — so `src/audio` reduces exactly
 * these cues to mono at decode time and leaves the others alone.
 */
export const CUE_IS_POSITIONAL: Readonly<Record<Cue, boolean>> = {
  rifle: true,
  'grenade-throw': true,
  'rocket-launch': true,
  explosion: true,
  death: true,
  chest: true,
  /**
   * THE END OF THE MISSION IS NOT SOMEWHERE ON THE MAP. Panning it would put the
   * victory in one ear because of where the player happened to leave the camera,
   * and it would waste the stereo image these two files were authored with.
   */
  victory: false,
  defeat: false,
}

/**
 * A request to play one sound: which cue, which variation of it, and — for a
 * positional cue — where it happened.
 *
 * `x` AND `z` ARE OMITTED, NEVER SET TO `undefined`. `exactOptionalPropertyTypes`
 * is on, and the distinction is load-bearing here: "no position" is what tells
 * the player not to pan, so an explicit `undefined` and an absent field must not
 * be two spellings of the same thing.
 */
export interface CueRequest {
  readonly cue: Cue
  /**
   * Which of the cue's samples to use, as a NON-NEGATIVE INTEGER the player
   * takes modulo however many files it actually holds for that cue.
   *
   * NOT AN INDEX INTO A LIST THIS MODULE KNOWS THE LENGTH OF. Three `death`
   * assets shipped and a fourth may arrive; `core` counting them would be `core`
   * describing the asset folder again. Every cue but `death` asks for 0, which
   * is "the first sample", and is correct for a cue with exactly one.
   */
  readonly variant: number
  /** World position on the ground plane. Absent for a cue that is not anywhere. */
  readonly x?: number
  readonly z?: number
}

/**
 * THE WEAPON TABLE IS GONE (ticket 044), and it is worth saying why rather than
 * leaving the next reader to wonder where the grenade's cue went.
 *
 * It mapped `ShotFired.weapon` to a cue with a rifle fallback, so an open enum
 * could not ship a weapon mute. `ShotFired` now asks for no cue at all — rifle
 * fire is one sustained voice — and the two other rows it held,
 * `grenade-throw` and `rocket-launch`, were NEVER REACHABLE THROUGH IT:
 * `ordnance/system.ts` has exactly one `world.emit`, the `Explosion` at
 * detonation, and emits no launch event of any kind. Those two cues are still in
 * `CUES` and their samples are still shipped and still unreachable, waiting for
 * an `OrdnanceLaunched` event that has been outstanding since ticket 027.
 *
 * The protection the fallback gave is now structural: `firingCue` is driven by
 * whether a man is DISCHARGING and never asks what he is holding, so a new
 * weapon cannot be silent for want of a row.
 */
/**
 * The sound `event` asks for, or `null` if it deliberately makes none.
 *
 * A `switch` WITH NO `default`, AND THAT IS ACCEPTANCE CRITERION 1. Over a
 * discriminated union with a declared return type, a variant added to `SimEvent`
 * and not handled here leaves a path that returns `undefined` and fails the
 * build. A `default: return null` reads as tidier and is the exact opposite: it
 * makes every future event type ship silently mute, with nothing anywhere
 * saying so. Do not add one.
 */
export function cueFor(event: SimEvent): CueRequest | null {
  switch (event.type) {
    /**
     * SILENT ON PURPOSE. `UnitSpawned` fires once per soldier during mission
     * setup, so a cue here is a burst of identical noises over the briefing —
     * not an effect, a fault. A despawn is the bookkeeping that FOLLOWS a death
     * (`UnitDespawnedEvent` says so), and the death has already been reported by
     * its own event; a cue on both would double every casualty.
     */
    case 'UnitSpawned':
    case 'UnitDespawned':
      return null

    /**
     * NO POSITION, BECAUSE THE EVENT CARRIES NONE. `UnitDiedEvent` reports the
     * id, the team, the killer and whether it was friendly fire — and not where
     * he fell. The FX layer had the same problem in ticket 025 and solved it by
     * finding the corpse among the frame's drawables; the mapping cannot see
     * those and must not pretend to. The caller may supply the position, or the
     * cue plays flat.
     */
    case 'UnitDied':
      return { cue: 'death', variant: variantForId(event.id) }

    /**
     * SILENT SINCE TICKET 044, AND THIS IS THE ONE ARM WORTH READING TWICE.
     *
     * A round used to ask for a whole `rifle` cue here. `gunfire.wav` was then
     * MEASURED: its RMS envelope is a shot every ~0.1 s held flat across the
     * whole 1.492 s at full amplitude to 1.45 s with no decay — a continuous
     * automatic burst, which is to say a LOOP that was being fired as a one-shot.
     *
     * So one round bought 1.5 s of automatic fire. Against a 32-tick (0.53 s)
     * rifle cooldown one man overlapped himself about three deep and a squad
     * about twelve, which is what `PER_CUE_VOICE_CAP` was quietly absorbing. And
     * releasing the trigger did nothing whatever: the voice ran to the end of its
     * buffer, so the shooting stayed audible for up to a second and a half after
     * the player let go.
     *
     * Rifle fire is now ONE SUSTAINED VOICE, started and stopped per frame from
     * `firingCue` below. This arm must stay silent or the two paths double up and
     * every round plays twice.
     *
     * WHAT WAS LOST, SAID PLAINLY: the shot's own origin. The sustained voice is
     * placed at the nearest firing man rather than at each barrel, so a single
     * round from across the map no longer pans to exactly where it came from. It
     * is the honest limit of one mono sample, not an oversight.
     */
    case 'ShotFired':
      return null

    /**
     * WHERE IT ACTUALLY WENT OFF. `ExplosionEvent` carries the detonation point
     * so nothing downstream has to look anything up, and the same position drives
     * the burst in `main.ts`.
     *
     * THE HEIGHT IS DROPPED, DELIBERATELY, and it is the one field an FX layer
     * uses that this one does not: `panFor` is a question about the horizontal
     * screen axis and `gainFor` about ground distance, and an airburst is at the
     * same place on both. There is no elevation cue to give it.
     *
     * ONE CUE FOR EVERY ORDNANCE, unlike the launch above. Only one `explosion`
     * asset shipped, and branching on `ordnance` to reach files that do not exist
     * would be the mapping describing a folder somebody hopes for.
     */
    case 'Explosion':
      return { cue: 'explosion', variant: 0, x: event.x, z: event.z }

    /**
     * SILENT, AND THE ONLY ARM HERE THAT IS UNCOMFORTABLE.
     * `FireRejectedEvent` exists precisely because "a right-click that produces
     * silence reads as a broken control" — an empty grenade pouch has to be
     * distinguishable from a dead button. But no refusal cue shipped, and there
     * is no honest cue in `CUES` to borrow: playing a rifle or an explosion for
     * a throw that never happened is worse than silence, because it tells the
     * player the throw DID happen. The HUD is where the refusal is shown until a
     * `denied` asset exists to add here.
     */
    case 'FireRejected':
      return null

    /** Where the chest was. No asset shipped; the player skips it. See `CUES`. */
    case 'ChestCollected':
      return { cue: 'chest', variant: 0, x: event.x, z: event.z }

    /** Not anywhere on the map — see `CUE_IS_POSITIONAL`. */
    case 'MissionComplete':
      return { cue: 'victory', variant: 0 }
    case 'MissionFailed':
      return { cue: 'defeat', variant: 0 }
  }
}

/**
 * A stable, non-negative integer variation for a unit id.
 *
 * FROM THE ID, NEVER FROM A DRAW. Nothing in presentation may touch `world.rng`:
 * a mission at a fixed seed would then depend on how many men had died in a
 * RENDERED run and not in a headless one, and the two would diverge — the replay
 * trap `core/tuning.ts` names. An id is free, already unique for the mission,
 * and gives the same man the same voice every time he is replayed.
 *
 * HASHED RATHER THAN TAKEN MODULO ANYTHING, because the modulus is the number of
 * files and this module must not know it. Two men killed by the same grenade
 * carry consecutive ids, and `id % 3` would march them through the samples in
 * lockstep — audible as a pattern once the player has heard it twice. The mix is
 * the standard 32-bit finaliser; all that is required of it is that it is a
 * function of the id alone and lands on a non-negative integer.
 *
 * A NON-FINITE OR FRACTIONAL ID falls to 0 rather than producing a NaN the
 * player would index an array with. Ids are integers; this only has to stay
 * total.
 */
function variantForId(id: number): number {
  if (!Number.isFinite(id)) return 0
  let h = Math.trunc(id) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h ^= h >>> 16
  // `>>> 0` reads the mix as unsigned: a non-negative integer below 2^32, which
  // is exactly what `variant` promises and safe to take a modulus of.
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Where it sits, and how loud
// ---------------------------------------------------------------------------

/**
 * How far a sound carries, in tiles.
 *
 * SIZED AGAINST THE VIEW, NOT AGAINST THE MAP. The camera's default viewport is
 * 16 world units tall (`render/camera-rig.ts`) and a tile is one world unit
 * (`core/view/projection.ts`), so on an ordinary widescreen window the player
 * sees on the order of fourteen tiles either side of the centre. A reach of 32
 * is a little over two of those half-widths: something just past the edge of the
 * screen is faint but present, which is what makes a firefight worth panning
 * towards.
 *
 * AND IT MUST REACH SILENCE. Level 2 is 92 tiles across and fields fifteen
 * enemies. Without a hard floor every round fired anywhere on the map is audible
 * at some tiny volume, and a dozen men fighting off screen is a constant wash the
 * player can neither locate nor act on. RAISE IT and that wash comes back; LOWER
 * IT much below the view's own width and sounds cut out inside the visible
 * screen, which reads as the audio dropping out.
 */
export const AUDIO_REACH_TILES = 32

/**
 * Where a world position sits in the stereo field, in `[-1, 1]`.
 *
 * A SCREEN-SPACE QUESTION WITH A WORLD-SPACE INPUT. `core` may not import the
 * renderer, so the caller passes the camera's centre and its half-width in world
 * units rather than a camera — which also lets the curve be tested without one.
 * The rig's yaw is zero (`render/camera-rig.ts`), so the world X axis IS the
 * screen's horizontal axis and no projection is needed here.
 *
 * BOUNDED HARD AT BOTH EARS. `StereoPannerNode.pan` is documented as `[-1, 1]`
 * and THROWS outside it. A sound from four screens away is not
 * more-than-fully-left; it is fully left, or better still inaudible, which is
 * `gainFor`'s job and not this one's.
 *
 * TOTAL, AND WRITTEN WITH POSITIVE COMPARISONS for the reason
 * `combat/resolution.ts` argues at length: a NaN reaching `AudioParam.value`
 * throws, and it would throw from inside a frame that was only trying to play a
 * rifle shot. Every degenerate input lands on the centre, which is the one
 * answer that is never wrong enough to notice.
 */
export function panFor(worldX: number, cameraX: number, halfWidth: number): number {
  // Zero, negative, NaN and infinite half-widths all land here. A camera with no
  // width has no field to place anything in, and dividing by it is the only way
  // to get a NaN out of the line below.
  if (!(halfWidth > 0 && halfWidth < Infinity)) return 0
  const offset = worldX - cameraX
  // A non-finite position is a caller bug; centre is the answer that neither
  // throws nor puts the sound somewhere the player can hear is wrong.
  if (!Number.isFinite(offset)) return 0
  const pan = offset / halfWidth
  // Linear, so the field is symmetric about the centre: an asymmetric pan would
  // put the same event in different places depending on which way the player
  // happened to walk into it.
  return pan < -1 ? -1 : pan > 1 ? 1 : pan
}

/**
 * How loud something `distanceTiles` away is, in `[0, 1]`.
 *
 * A SQUARED FALLOFF TO A HARD FLOOR. The square is what keeps a sound under the
 * camera clearly dominant over one at the edge of the view — a linear ramp
 * leaves the whole screen at a similar volume, so the player learns nothing
 * about distance from it. The floor at `AUDIO_REACH_TILES` is the important
 * half: see the constant.
 *
 * MONOTONIC AND BOUNDED FOR EVERY INPUT, including the ones that should never
 * arrive. Written with positive comparisons so NaN falls through to the LOUD
 * end rather than the silent one: distance is a magnitude, a negative or
 * corrupted one is a caller bug, and a cue that vanished would be read as a
 * missing asset — which is a bug in a different file, hunted for hours.
 */
export function gainFor(distanceTiles: number): number {
  // Zero, negative and non-finite distances all land here — see above.
  if (!(distanceTiles > 0)) return 1
  // At and beyond the reach, silence. Also catches `Infinity`.
  if (!(distanceTiles < AUDIO_REACH_TILES)) return 0
  const t = distanceTiles / AUDIO_REACH_TILES
  const remaining = 1 - t
  return remaining * remaining
}

// ---------------------------------------------------------------------------
// The sustained voice (ticket 044)
// ---------------------------------------------------------------------------

/** A man currently discharging his weapon, as the sustained voice needs him. */
export interface FiringSource {
  readonly id: number
  readonly x: number
  readonly z: number
}

/** Where the camera is looking. Matches `src/audio`'s `AudioListener`. */
interface ListenerAt {
  readonly x: number
  readonly z: number
  readonly halfWidth: number
}

/**
 * The one sustained rifle voice for this frame, or `null` for silence.
 *
 * CALLED EVERY FRAME WITH THE WHOLE LIST, not driven by events. That is the
 * point of it: a sound that starts and stops with the trigger cannot be built
 * out of `ShotFired`, which is a discrete thing that has already happened. The
 * caller passes who is firing NOW and gets back what should be sounding NOW, and
 * `null` genuinely means stop — see `cueFor`'s `ShotFired` arm for the
 * measurement that forced this shape.
 *
 * THE NEAREST MAN WINS, AND THAT IS A HONEST LIMIT RATHER THAN A COMPROMISE.
 * One `gunfire.wav` shipped, mono after the positional downmix, so a single
 * voice can represent exactly one place; the loudest source is the only
 * defensible choice of which. Fifteen enemies firing is not fifteen voices, and
 * it was never going to be — the per-cue cap would have stolen them anyway, but
 * arbitrarily rather than by distance.
 *
 * TIES BREAK ON THE LOWER ID, like every other ordering decision in this
 * codebase, so two equidistant men cannot make a replay diverge on which one the
 * voice followed. `>` and not `>=` in the comparison below is what does it.
 *
 * NON-FINITE POSITIONS ARE SKIPPED, NOT CLAMPED. This request goes straight to
 * `StereoPanner.pan` and `AudioParam.value`, and both THROW on a NaN — inside
 * the render loop, where a throw takes the frame and the mission with it. A man
 * whose position is not a number is not a man who can be placed, so he is not
 * heard; if he is the only one firing, the answer is silence.
 *
 * THE EXPLICIT GUARD IS BELT AND BRACES, AND DELETING IT CHANGES NOTHING TODAY —
 * checked by deleting it and watching the suite stay green. `Math.hypot` of a
 * non-finite coordinate is `NaN` or `Infinity`, and the `distance < bestDistance`
 * comparison below is written positively, so neither can ever win: `NaN < x` is
 * false, and `Infinity < Infinity` is false against the initial best. The guard
 * is kept because that is a property of a comparison three lines away rather
 * than of this rule, and the cost of restating the rule locally is one call to
 * `Number.isFinite`. It is NOT independently covered by a test, and this note
 * exists so nobody records a passing suite as proof that it does something.
 *
 * OUT OF EARSHOT IS SILENCE, not a quiet voice. A voice claimed for a sound at
 * zero gain is still a voice, and a firefight the player cannot hear must not
 * hold the sustained slot open while somebody beside him shoots. Measured with
 * the same `AUDIO_REACH_TILES` `gainFor` uses, so the two cannot disagree about
 * where earshot ends.
 */
export function firingCue(
  sources: readonly FiringSource[],
  listener: ListenerAt,
): CueRequest | null {
  let best: FiringSource | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const source of sources) {
    if (!Number.isFinite(source.x) || !Number.isFinite(source.z)) continue
    const distance = Math.hypot(source.x - listener.x, source.z - listener.z)
    // Nearer wins; an exact tie goes to the LOWER ID. Written as two explicit
    // comparisons rather than left to the order `sources` happens to arrive in:
    // that order is the caller's iteration order, and a rule that depended on it
    // would make the voice's choice a property of how the frame was assembled.
    //
    // The positive `distance < bestDistance` form means a NaN distance — which
    // the finiteness guard above should already have excluded — loses rather
    // than winning by failing a comparison.
    const nearer = distance < bestDistance
    const tied = distance === bestDistance && best !== undefined && source.id < best.id
    if (!nearer && !tied) continue
    bestDistance = distance
    best = source
  }
  if (best === undefined) return null
  // The same reach `gainFor` falls to zero at. Asked here as well as there so a
  // voice is never STARTED for something inaudible, rather than started and then
  // found to be silent.
  if (!(bestDistance < AUDIO_REACH_TILES)) return null
  return { cue: 'rifle', variant: 0, x: best.x, z: best.z }
}

// ---------------------------------------------------------------------------
// How many things may be making noise at once
// ---------------------------------------------------------------------------

/**
 * Voices in total.
 *
 * HEADROOM WITH A CEILING. Level 2 fields fifteen enemies, so a cap in single
 * digits would silence most of a mission's worth of sound; 16 lets a whole
 * firefight be heard while still bounding what the graph can be asked to decode
 * and mix at once.
 */
export const GLOBAL_VOICE_CAP = 16

/**
 * Voices of any ONE cue.
 *
 * MEASURED, NOT GUESSED, and this is the number the ticket's asset table
 * produced. `gunfire.wav` is 1.49 seconds long and the rifle's cooldown is 32
 * ticks — 0.53 s at 60 Hz — so one soldier firing steadily overlaps himself
 * about three deep, and a four-man squad twelve deep before a single enemy joins
 * in. Four is one soldier's full cadence plus a round of headroom.
 *
 * WHY IT IS NOT JUST THE GLOBAL CAP: under a global cap alone those twelve
 * rifles take every voice in the game, and the grenade that killed the squad
 * makes no sound at all. A per-cue cap is what reserves room for the thing that
 * matters. It must stay strictly below `GLOBAL_VOICE_CAP` or it can never bind
 * and the measurement above goes unaddressed while looking addressed.
 */
export const PER_CUE_VOICE_CAP = 4

export interface VoiceLimiterOptions {
  /** Voices in total. Past this the OLDEST live voice is stolen. */
  readonly globalCap: number
  /** Voices of any one cue. Past this the oldest live voice OF THAT CUE is stolen. */
  readonly perCueCap: number
}

/** What `start` answers: which voice was claimed, and whether it was taken. */
export interface VoiceStart {
  /**
   * Whether an already-playing voice was stopped for this one.
   *
   * The acceptance criterion: past the cap the oldest is STOLEN rather than the
   * new one dropped, so a sustained firefight keeps making noise instead of
   * going quiet after the first few rounds and staying quiet — which reads as
   * the audio having broken rather than as a limit.
   */
  readonly stolen: boolean
  /**
   * Which slot this voice occupies, in `[0, globalCap)`.
   *
   * THE HANDLE THAT LETS THE STEAL ACTUALLY HAPPEN. `stolen` says a voice was
   * taken; this says WHICH, so `src/audio` can stop the exact source node in
   * that slot rather than re-deriving "the oldest" from a second copy of the
   * policy above. Two copies of a rule this fiddly would disagree the first time
   * either was touched, and the symptom would be a stopped sound that was not
   * the one the limiter counted out.
   */
  readonly slot: number
}

export interface VoiceLimiter {
  /**
   * Claim a voice for `cue`, starting at `atSeconds` and running for
   * `durationSeconds`.
   *
   * ALWAYS GRANTED. There is no "refused" answer: the caller is told whether
   * something had to be stopped, not whether it may play. See `VoiceStart`.
   */
  start(cue: Cue, atSeconds: number, durationSeconds: number): VoiceStart
  /** How many voices are playing at `nowSeconds`. A query: it mutates nothing. */
  liveCount(nowSeconds: number): number
  /** How many voices of `cue` are playing at `nowSeconds`. A query. */
  liveCountFor(cue: Cue, nowSeconds: number): number
}

/** A tracked voice. `startedAt >= endsAt` means the slot is free. */
interface Voice {
  cue: Cue
  startedAt: number
  endsAt: number
  /** Strictly increasing. Breaks ties when two voices started at the same instant. */
  issued: number
}

/**
 * Build a voice limiter.
 *
 * A FIXED ARRAY OF SLOTS, ALLOCATED ONCE, for the reason the tracer and FX rings
 * give: this is fed straight off the event bus for the length of a mission, and
 * a list that only ever pushes is a leak with a fuse on it. The slot count IS
 * the global cap, so the structure cannot represent a state that breaks it.
 *
 * NOT A RING, THOUGH, and that is the one place it differs from those two. A
 * voice may be freed by EXPIRING as well as by being overwritten, and the per-cue
 * cap steals a voice from the middle rather than the end, so slots are claimed by
 * search instead of by a write cursor. The search is over `globalCap` entries —
 * sixteen — once per sound.
 *
 * THE QUERIES MUTATE NOTHING, which is the same bargain `FxBuffer.visible` makes
 * and for the same reason: expiring entries inside `liveCount` would make the
 * answer depend on the order the questions were asked, and a caller that asked
 * about a later instant would destroy the answer to an earlier one.
 */
export function createVoiceLimiter(options: VoiceLimiterOptions): VoiceLimiter {
  // Floored to at least one slot, and floored to integers: a zero-cap limiter
  // has nowhere to put a voice and a fractional one sizes an array off the end.
  const globalCap = Math.max(1, Math.floor(options.globalCap))
  // Clamped to the global cap as well as to one. A per-cue cap above it cannot
  // bind, and letting it read higher than the number of slots would be a
  // configuration that quietly describes something the structure cannot do.
  const perCueCap = Math.min(globalCap, Math.max(1, Math.floor(options.perCueCap)))

  // Pre-filled with real objects, so `start` never allocates and the slots are
  // never `undefined` for `noUncheckedIndexedAccess` to make everybody prove.
  // `endsAt <= startedAt` is the free marker; both zero reads as free.
  const voices: Voice[] = []
  for (let i = 0; i < globalCap; i += 1) {
    voices.push({ cue: 'rifle', startedAt: 0, endsAt: 0, issued: 0 })
  }

  /** Voices ever started. The tiebreak source, so two are never equally old. */
  let issued = 0

  /**
   * Whether `voice` is sounding at `nowSeconds`.
   *
   * HALF-OPEN: a voice that ends exactly now has finished. The alternative keeps
   * a slot occupied by something nobody can hear, which at the cap costs a live
   * sound its voice.
   */
  function isLive(voice: Voice, nowSeconds: number): boolean {
    return voice.startedAt <= nowSeconds && nowSeconds < voice.endsAt
  }

  /** Whether `a` started before `b`. Ties go to whichever was issued first. */
  function isOlder(a: Voice, b: Voice): boolean {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt
    return a.issued < b.issued
  }

  function start(cue: Cue, atSeconds: number, durationSeconds: number): VoiceStart {
    // A non-positive or non-finite duration would be a voice that is never live
    // and therefore never counted. Floored to zero rather than rejected: the
    // caller still gets its `stolen` answer, and the slot frees itself at once
    // because nothing is playing in it.
    const endsAt = atSeconds + (durationSeconds > 0 ? durationSeconds : 0)

    // Slot INDICES rather than the voices themselves: the index is what `start`
    // hands back, and `-1` is "none found" so the search needs no optionals.
    let free = -1
    let oldest = -1
    let oldestOfCue = -1
    // The voices those last two index, carried alongside so the comparison below
    // needs no second lookup (and no optional to prove away).
    let oldestVoice: Voice | undefined
    let oldestOfCueVoice: Voice | undefined
    let live = 0
    let liveOfCue = 0

    for (let i = 0; i < voices.length; i += 1) {
      const voice = voices[i]
      // Unreachable — the array is full of entries from construction and its
      // length never changes — but the index is computed, and
      // `noUncheckedIndexedAccess` is right to make that be said out loud.
      if (voice === undefined) continue
      if (!isLive(voice, atSeconds)) {
        // The first dead slot will do; they are interchangeable.
        if (free < 0) free = i
        continue
      }
      live += 1
      if (oldestVoice === undefined || isOlder(voice, oldestVoice)) {
        oldest = i
        oldestVoice = voice
      }
      if (voice.cue !== cue) continue
      liveOfCue += 1
      if (oldestOfCueVoice === undefined || isOlder(voice, oldestOfCueVoice)) {
        oldestOfCue = i
        oldestOfCueVoice = voice
      }
    }

    // THE PER-CUE CAP FIRST, and the order matters. A fifth rifle must take a
    // rifle's voice even when the graph has room, or the rifles grow until they
    // hit the global cap and start stealing from the explosions — which is the
    // exact failure the per-cue cap exists to prevent.
    let index = free
    let stolen = false
    if (liveOfCue >= perCueCap) {
      index = oldestOfCue
      stolen = true
    } else if (live >= globalCap) {
      index = oldest
      stolen = true
    }
    const slot = voices[index]
    // Unreachable: a cap that binds always names the voice it counted, and below
    // both caps there are fewer live voices than slots so a free one exists.
    // Written out rather than asserted away, and slot 0 is a safe thing to name
    // for a caller that is about to stop whatever is in it.
    if (slot === undefined) return { stolen: false, slot: 0 }

    issued += 1
    slot.cue = cue
    slot.startedAt = atSeconds
    slot.endsAt = endsAt
    slot.issued = issued
    return { stolen, slot: index }
  }

  function liveCount(nowSeconds: number): number {
    let count = 0
    for (const voice of voices) if (isLive(voice, nowSeconds)) count += 1
    return count
  }

  function liveCountFor(cue: Cue, nowSeconds: number): number {
    let count = 0
    for (const voice of voices) if (voice.cue === cue && isLive(voice, nowSeconds)) count += 1
    return count
  }

  return { start, liveCount, liveCountFor }
}
