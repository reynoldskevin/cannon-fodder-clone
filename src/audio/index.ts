/**
 * The Web Audio player (ticket 027): the half of the audio bus that makes noise.
 *
 * IT DECIDES NOTHING. Which sound an event asks for, where it sits in the stereo
 * field, how loud it is at a distance and whether it may start at all are all
 * answered in `core/audio-events`, where Vitest can see them — this file owns the
 * `AudioContext`, the decoded buffers and the node graph, and nothing else. That
 * is the same split ticket 025 used for the FX layer, for the same stated reason:
 * anything decided inside a Web Audio call is decided where no test can see it.
 *
 * NOTHING HAPPENS BEFORE A USER GESTURE. The context is not merely suspended
 * until then — it is not CONSTRUCTED until then. A context built at boot starts
 * suspended, and the first `start()` against a suspended context is what earns
 * the browser's autoplay warning in the console; building it inside the gesture
 * handler and resuming it there means there is never a suspended moment to warn
 * about. `play()` before that point is a no-op, which is correct rather than
 * merely safe: there is nothing to hear yet either way.
 *
 * NOT SIMULATION, and it must never become so. It is fed from the drained event
 * batch after the sim has already decided everything, and reads nothing the world
 * can hear. A headless replay and a played one produce the same mission whether
 * or not the speakers were on.
 *
 * WHAT IS DELIBERATELY NOT HERE: a music bed and its ducking. No music asset
 * exists, and inventing a ducking curve against a file that does not exist would
 * be untestable guesswork (ticket 027, "Out of scope").
 */

import {
  createVoiceLimiter,
  gainFor,
  panFor,
  CUE_IS_POSITIONAL,
  GLOBAL_VOICE_CAP,
  PER_CUE_VOICE_CAP,
  type Cue,
  type CueRequest,
} from '../core/audio-events'

import death1Url from '../../assets/source/audio/death1.wav?url'
import death2Url from '../../assets/source/audio/death2.wav?url'
import death3Url from '../../assets/source/audio/death3.wav?url'
import defeatUrl from '../../assets/source/audio/defeat.wav?url'
import explosionUrl from '../../assets/source/audio/explosion.wav?url'
import grenadeThrowUrl from '../../assets/source/audio/grenade-throw.wav?url'
import gunfireUrl from '../../assets/source/audio/gunfire.wav?url'
import rocketLaunchUrl from '../../assets/source/audio/rocket-launch.wav?url'
import victoryUrl from '../../assets/source/audio/victory.wav?url'

/**
 * The samples each cue may use, in variant order.
 *
 * PARTIAL, AND THAT IS THE POINT. Two cues in `CUES` have no file — `chest`, and
 * the music bed that is not a cue at all — and a cue with no entry here is
 * SKIPPED by `play` without throwing. A missing sound is a missing sound, not a
 * broken mission. The mapping in `core` still requests it, so the day somebody
 * drops `chest.wav` in, this table is the only line that changes.
 *
 * `death` HOLDS THREE, and `CueRequest.variant` picks between them modulo this
 * array's length — see `variantForId`. A cue that always played its first sample
 * would waste the other two and make a firefight sound like one man dying over
 * and over.
 */
const CUE_SAMPLES: Partial<Readonly<Record<Cue, readonly string[]>>> = {
  rifle: [gunfireUrl],
  'grenade-throw': [grenadeThrowUrl],
  'rocket-launch': [rocketLaunchUrl],
  explosion: [explosionUrl],
  death: [death1Url, death2Url, death3Url],
  victory: [victoryUrl],
  defeat: [defeatUrl],
}

/** Where localStorage keeps the two settings that outlive the page. */
const MUTED_KEY = 'game-week.audio.muted'
const VOLUME_KEY = 'game-week.audio.volume'

/**
 * Master volume on a fresh browser.
 *
 * Short of 1 on purpose: the assets were not normalised against each other (see
 * ticket 027's "Still open"), so the loudest of them wants headroom before the
 * mix clips. The player can raise it, and the choice is remembered.
 */
const DEFAULT_VOLUME = 0.7

/**
 * How long the master gain takes to follow a change, in seconds.
 *
 * NOT ZERO. Writing `gain.value` outright steps the signal on the next audio
 * block, and a step in a running waveform is a click — the one artefact a mute
 * button can produce that is louder than what it muted. A few milliseconds is
 * below the threshold of feeling laggy and above the threshold of clicking.
 */
const GAIN_RAMP_SECONDS = 0.02

/** Where the camera is looking, in world units. Everything positional is placed against it. */
export interface AudioListener {
  /** The point the camera is centred on, on the ground plane. */
  readonly x: number
  readonly z: number
  /**
   * Half the visible world width, in world units.
   *
   * The rig's yaw is zero, so this is exactly `rig.camera.right` and the world X
   * axis is the screen's horizontal axis. `panFor` divides by it.
   */
  readonly halfWidth: number
}

export interface AudioBus {
  /**
   * Play one cue request, placed against the listener.
   *
   * SILENT UNTIL THE FIRST GESTURE, silent for a cue with no asset, and silent
   * for a cue out of earshot — none of which throw. This is called from inside
   * the render loop's event drain, where a throw would take the frame and the
   * whole mission with it.
   */
  play(request: CueRequest, listener: AudioListener): void
  /**
   * Drive the ONE sustained voice for this frame (ticket 044).
   *
   * CALLED EVERY FRAME, INCLUDING WITH `null`. This is not an event handler —
   * `null` is an instruction to stop, and a caller that only called it when
   * somebody was firing would never turn the gunfire off. `core`'s `firingCue`
   * produces the argument.
   *
   * Idempotent: passing a request while one is already sounding moves the
   * existing voice rather than starting a second, so holding the trigger is one
   * continuous loop and not a new voice per frame.
   */
  sustain(request: CueRequest | null, listener: AudioListener): void
  /** Master mute. Persisted across sessions. */
  setMuted(muted: boolean): void
  /** Master volume in `[0, 1]`. Persisted across sessions. */
  setVolume(volume: number): void
  readonly muted: boolean
  readonly volume: number
  /** Stop everything, drop the gesture listeners and close the context. */
  dispose(): void
}

/**
 * Read a persisted setting, tolerating every way storage can fail.
 *
 * `localStorage` THROWS rather than returning null in a Safari private window
 * and under some enterprise policies, and a getter that threw here would take
 * the boot down over a volume slider. Absent, unreadable and malformed all fall
 * back to the default.
 */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A setting that could not be saved is not worth a message: the session it
    // was made in still honours it, and the next one starts at the default.
  }
}

/** `[0, 1]`, which is the only range a gain may be set from. */
function clamp01(value: number): number {
  // Positive comparisons, so a NaN read out of storage falls to the default
  // rather than reaching `AudioParam.value`, which throws on one.
  if (!(value > 0)) return 0
  return value < 1 ? value : 1
}

/** One live voice, as the graph holds it. */
interface Voice {
  readonly source: AudioBufferSourceNode
  /** The last node before the master gain, so the whole chain can be released. */
  readonly tail: AudioNode
}

/**
 * Build the audio bus.
 *
 * RETURNS IMMEDIATELY AND LOADS NOTHING. Both the context and the 10.4 MB of
 * samples wait for the first gesture: decoding at boot would put ten megabytes of
 * `decodeAudioData` in front of the first frame for a player who may never make a
 * sound, and would build the context in exactly the suspended state that earns
 * the autoplay warning.
 */
export function createAudioBus(): AudioBus {
  let muted = readStored(MUTED_KEY) === 'true'
  /**
   * A MALFORMED VALUE FALLS BACK, IT DOES NOT MUTE.
   *
   * `clamp01(Number('garbage'))` is `clamp01(NaN)`, and a clamp written with the
   * positive comparison this codebase insists on answers 0 for NaN — so one bad
   * byte in `localStorage` silenced the game on every future visit, permanently,
   * with no control anywhere to turn it back up. `readStored`'s own comment
   * already promised that malformed input fell back to the default; it did not.
   *
   * Checked for FINITENESS before clamping, so the clamp keeps its NaN-safe
   * behaviour for every other caller and this one gets the answer it documents.
   *
   * AND THE ABSENT CASE IS SEPARATED OUT FIRST, because `Number(null)` is ZERO,
   * not NaN — a finiteness check alone would mute every FRESH install, which is
   * a worse version of the bug it was written to fix.
   */
  const storedVolume = readStored(VOLUME_KEY)
  // An EMPTY entry is malformed too, and `Number('')` is 0 — so it would have
  // muted just like the absent case did. `'0'` still means zero, because that is
  // a volume somebody chose.
  const parsedVolume =
    storedVolume === null || storedVolume.trim() === '' ? Number.NaN : Number(storedVolume)
  let volume = Number.isFinite(parsedVolume) ? clamp01(parsedVolume) : DEFAULT_VOLUME

  let ctx: AudioContext | undefined
  let master: GainNode | undefined
  let disposed = false

  /** Decoded samples per cue, in the variant order `CUE_SAMPLES` lists them. */
  const decoded = new Map<Cue, AudioBuffer[]>()

  /**
   * The policy, built with the shipped caps.
   *
   * THE LIMITER IS THE ONLY THING THAT DECIDES WHAT STOPS. It hands back the
   * SLOT it claimed, and the array below is indexed by that slot — so a steal is
   * "stop whatever is in slot 7" and there is no second copy of "which is the
   * oldest" for this file to get wrong.
   */
  const limiter = createVoiceLimiter({
    globalCap: GLOBAL_VOICE_CAP,
    perCueCap: PER_CUE_VOICE_CAP,
  })
  const live: (Voice | undefined)[] = new Array<Voice | undefined>(GLOBAL_VOICE_CAP).fill(undefined)

  /** Apply mute and volume to the master gain, if there is one yet. */
  function applyGain(): void {
    if (ctx === undefined || master === undefined) return
    const target = muted ? 0 : volume
    // `setTargetAtTime` rather than an assignment — see `GAIN_RAMP_SECONDS`.
    master.gain.setTargetAtTime(target, ctx.currentTime, GAIN_RAMP_SECONDS)
  }

  /**
   * Reduce a decoded buffer to one channel.
   *
   * THE ASSETS FORCE THIS, and it is acceptance criterion 6. Every file shipped
   * is stereo, and a `StereoPannerNode` cannot place a stereo source: it
   * attenuates the existing image rather than moving it, so a rifle fired at the
   * left edge of the screen still arrives from wherever the sample was recorded.
   * Positional cues are therefore collapsed to mono ONCE, at decode, rather than
   * per voice — the alternative is this loop running on every rifle shot.
   *
   * Non-positional cues are left alone: victory and defeat are not anywhere on
   * the map, nothing pans them, and throwing away the stereo image they were
   * authored with would be a downgrade for nothing.
   */
  function toMono(context: AudioContext, buffer: AudioBuffer): AudioBuffer {
    if (buffer.numberOfChannels < 2) return buffer
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c))
    const mono = context.createBuffer(1, buffer.length, buffer.sampleRate)
    const out = mono.getChannelData(0)
    for (let i = 0; i < out.length; i += 1) {
      let sum = 0
      // `?? 0` because `noUncheckedIndexedAccess` covers typed arrays too. The
      // index cannot be out of range — every channel of a buffer has the same
      // length — but the compiler is right that an index is not a proof.
      for (const channel of channels) sum += channel[i] ?? 0
      // AVERAGED, NOT SUMMED. Summing two correlated channels is +6 dB and
      // clips the loudest samples in the file, which is heard as distortion on
      // exactly the explosions that most need to sound clean.
      out[i] = sum / channels.length
    }
    return mono
  }

  /**
   * Fetch and decode every sample, into the map `play` reads.
   *
   * ONE CUE AT A TIME IS NOT WORTH SERIALISING, so all of them go at once; but a
   * failure on any one file must not take the rest with it, hence the per-file
   * catch. A sample that could not be fetched or decoded simply leaves its cue
   * shorter — or absent, which `play` already treats as "no asset" and skips.
   * The console line is the only trace, because a missing sound is not worth the
   * fatal-error overlay that a missing level or atlas earns.
   */
  async function load(context: AudioContext): Promise<void> {
    const cues = Object.entries(CUE_SAMPLES) as [Cue, readonly string[]][]
    await Promise.all(
      cues.map(async ([cue, urls]) => {
        const positional = CUE_IS_POSITIONAL[cue]
        const buffers = await Promise.all(
          urls.map(async (url) => {
            try {
              const response = await fetch(url)
              const bytes = await response.arrayBuffer()
              const buffer = await context.decodeAudioData(bytes)
              return positional ? toMono(context, buffer) : buffer
            } catch (error: unknown) {
              console.warn(`game-week: the ${cue} sound could not be loaded (${url})`, error)
              return undefined
            }
          }),
        )
        // PUBLISHED PER CUE, ONCE ITS OWN SAMPLES ARE IN. `rocket-launch` is 4.1
        // MB and the rifle is 279 KB; one shared gate would keep the rifle silent
        // for the whole of the first firefight while the rocket decoded.
        //
        // COMPACTED, so `variant % length` cannot land on a hole a failed decode
        // left behind. A cue whose every sample failed is an empty array, which
        // `play` skips exactly as it skips a cue with no asset at all.
        decoded.set(
          cue,
          buffers.filter((buffer): buffer is AudioBuffer => buffer !== undefined),
        )
      }),
    )
  }

  /** Stop and release whatever occupies `slot`. Safe on an empty slot. */
  function release(slot: number): void {
    const voice = live[slot]
    if (voice === undefined) return
    live[slot] = undefined
    // `onended` is cleared first: it would otherwise fire for the stop below and
    // release a slot that a new voice has already been written into.
    voice.source.onended = null
    try {
      voice.source.stop()
    } catch {
      // A source that never started, or has already ended, throws here. Either
      // way there is nothing left to stop.
    }
    voice.source.disconnect()
    voice.tail.disconnect()
  }

  /**
   * Build the context and start loading, on the first gesture and once.
   *
   * INSIDE THE GESTURE HANDLER. See the file header: a context constructed here
   * starts running rather than suspended, so there is no autoplay warning to
   * suppress and no first sound swallowed while a `resume()` is in flight. The
   * `resume()` is still called, because a context can be created suspended on
   * platforms that require an even stricter gesture.
   */
  function begin(): void {
    detach()
    if (disposed || ctx !== undefined) return
    try {
      ctx = new AudioContext()
    } catch (error: unknown) {
      // No Web Audio at all. The game is entirely playable without sound, so
      // this is a console line and not the fatal overlay.
      console.warn('game-week: audio is unavailable in this browser', error)
      return
    }
    master = ctx.createGain()
    // Set outright rather than ramped: there is nothing playing yet to click.
    master.gain.value = muted ? 0 : volume
    master.connect(ctx.destination)
    void ctx.resume()
    void load(ctx)
  }

  /**
   * The gestures that count.
   *
   * THREE OF THEM, because the first thing a player does differs by device: a
   * click on the Menu, a key on the keyboard, a tap on a touchscreen. All three
   * are removed by whichever fires first — `{ once: true }` on each would leave
   * the other two attached for the life of the page.
   */
  const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const

  function detach(): void {
    for (const gesture of GESTURES) window.removeEventListener(gesture, begin)
  }

  for (const gesture of GESTURES) window.addEventListener(gesture, begin)

  function play(request: CueRequest, listener: AudioListener): void {
    // No gesture yet, or no Web Audio at all. Nothing to hear either way.
    if (ctx === undefined || master === undefined) return
    const samples = decoded.get(request.cue)
    // NO ASSET, NO SOUND, NO THROW — acceptance criterion 2. `chest` reaches here
    // on every pickup and leaves through this line.
    if (samples === undefined || samples.length === 0) return
    const buffer = samples[request.variant % samples.length]
    if (buffer === undefined) return

    // A cue is positional when the CUE says so AND the request carries a place.
    // `UnitDied` asks for a positional cue with no position of its own — the
    // event does not carry one — so it plays centred rather than at the origin
    // of the map, which is a real place and the wrong one.
    const positional =
      CUE_IS_POSITIONAL[request.cue] && request.x !== undefined && request.z !== undefined
    let pan = 0
    let gain = 1
    if (positional && request.x !== undefined && request.z !== undefined) {
      pan = panFor(request.x, listener.x, listener.halfWidth)
      gain = gainFor(Math.hypot(request.x - listener.x, request.z - listener.z))
    }
    // OUT OF EARSHOT, AND SO NOT WORTH A VOICE. Claiming one for a silent sound
    // would let a firefight the player cannot hear steal the voice of one he can
    // — which is the per-cue cap's argument all over again, one level up.
    if (!(gain > 0)) return

    const now = ctx.currentTime
    // THE POLICY DECIDES, AND NAMES THE SLOT. Anything already in that slot is
    // stopped, whether it was stolen or had simply finished without its `onended`
    // having run yet.
    const claim = limiter.start(request.cue, now, buffer.duration)
    release(claim.slot)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const voiceGain = ctx.createGain()
    voiceGain.gain.value = gain
    source.connect(voiceGain)
    let tail: AudioNode = voiceGain
    if (positional) {
      // Created per voice rather than per cue: two rifles fired at opposite ends
      // of the screen in the same tenth of a second are two places, and one
      // shared panner would drag the first to wherever the second was.
      const panner = ctx.createStereoPanner()
      // `panFor` is bounded to [-1, 1] and never returns NaN, which matters
      // because this setter THROWS on either.
      panner.pan.value = pan
      voiceGain.connect(panner)
      tail = panner
    }
    tail.connect(master)
    const voice: Voice = { source, tail }
    live[claim.slot] = voice
    source.onended = () => {
      // Only if the slot still holds THIS voice: a steal has already released it
      // and written a new one in, and clearing the slot then would leak the new
      // voice's nodes and let the limiter double-book it.
      if (live[claim.slot] === voice) release(claim.slot)
    }
    source.start(now)
  }

  /**
   * The one sustained voice, or `undefined` while nothing is sounding.
   *
   * OUTSIDE `live[]` AND OUTSIDE THE LIMITER, deliberately. The limiter is a
   * policy for one-shots — oldest-first stealing among voices that each end by
   * themselves — and this voice ends only when told to. Putting it in the pool
   * would let a volley of deaths steal the gunfire mid-loop and leave the
   * trigger held with nothing sounding, and its slot would never be released by
   * an `onended` that is never going to run.
   */
  let sustained:
    | { readonly source: AudioBufferSourceNode; readonly gain: GainNode; readonly panner: StereoPannerNode }
    | undefined

  /** Stop the sustained voice, fading rather than cutting. See `GAIN_RAMP_SECONDS`. */
  function stopSustained(now: number): void {
    const voice = sustained
    if (voice === undefined) return
    sustained = undefined
    // RAMPED, NOT CUT. A looping burst killed outright is a step in a running
    // waveform, which is a click — on every trigger release, which is far more
    // often than the mute button this constant was written for.
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
    voice.gain.gain.linearRampToValueAtTime(0, now + GAIN_RAMP_SECONDS)
    try {
      // Stopped AFTER the ramp has run, or the fade never gets to happen.
      voice.source.stop(now + GAIN_RAMP_SECONDS)
    } catch {
      // Already stopped, or never started. Nothing left to stop either way.
    }
    voice.source.onended = () => {
      voice.source.disconnect()
      voice.gain.disconnect()
      voice.panner.disconnect()
    }
  }

  function sustain(request: CueRequest | null, listener: AudioListener): void {
    if (ctx === undefined || master === undefined) return
    const now = ctx.currentTime
    if (request === null) {
      stopSustained(now)
      return
    }
    const samples = decoded.get(request.cue)
    // Not decoded yet — the first firefight can begin before 10 MB of audio has
    // finished arriving — or no asset at all. Silence, and no throw.
    if (samples === undefined || samples.length === 0) return
    const buffer = samples[request.variant % samples.length]
    if (buffer === undefined) return

    const positional =
      CUE_IS_POSITIONAL[request.cue] && request.x !== undefined && request.z !== undefined
    let pan = 0
    let gain = 1
    if (positional && request.x !== undefined && request.z !== undefined) {
      pan = panFor(request.x, listener.x, listener.halfWidth)
      gain = gainFor(Math.hypot(request.x - listener.x, request.z - listener.z))
    }

    if (sustained !== undefined) {
      // ALREADY RUNNING: move it, do not start another. This is what makes a held
      // trigger one continuous loop instead of sixty voices a second.
      //
      // Ramped for the same reason the stop is: the nearest firing man can change
      // from one frame to the next — he dies, or somebody closer opens up — and
      // stepping the pan and gain across that gap is an audible click on a signal
      // that is already at full amplitude.
      const voice = sustained
      voice.gain.gain.setTargetAtTime(gain, now, GAIN_RAMP_SECONDS)
      voice.panner.pan.setTargetAtTime(pan, now, GAIN_RAMP_SECONDS)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    // THE WHOLE POINT OF THIS PATH. `gunfire.wav` was measured as a continuous
    // automatic burst with no decay — full amplitude at 1.45 s of a 1.492 s file
    // — so it loops seamlessly enough to hold a trigger down on. A one-shot of
    // the same buffer is the bug this ticket exists to fix.
    source.loop = true
    const voiceGain = ctx.createGain()
    // FROM SILENCE, NOT FROM FULL. The attack of the sample is itself a gunshot,
    // so a ramp this short is inaudible as a fade and still avoids the click of
    // starting a loop at full gain mid-block.
    voiceGain.gain.value = 0
    voiceGain.gain.setTargetAtTime(gain, now, GAIN_RAMP_SECONDS)
    const panner = ctx.createStereoPanner()
    // `panFor` is bounded to [-1, 1] and never NaN — this setter throws on either
    // — and `firingCue` has already dropped any source without a finite position.
    panner.pan.value = pan
    source.connect(voiceGain)
    voiceGain.connect(panner)
    panner.connect(master)
    sustained = { source, gain: voiceGain, panner }
    source.start(now)
  }

  return {
    play,
    sustain,
    setMuted(next: boolean): void {
      muted = next
      writeStored(MUTED_KEY, next ? 'true' : 'false')
      applyGain()
    },
    setVolume(next: number): void {
      volume = clamp01(next)
      writeStored(VOLUME_KEY, String(volume))
      applyGain()
    },
    get muted(): boolean {
      return muted
    },
    get volume(): number {
      return volume
    },
    dispose(): void {
      disposed = true
      detach()
      for (let slot = 0; slot < live.length; slot += 1) release(slot)
      // THE SUSTAINED VOICE IS NOT IN `live`, so the loop above does not touch
      // it — and it is the one voice in the graph that would otherwise play
      // FOREVER, because nothing but a caller ever ends it. Cut rather than
      // ramped: the context is closing on the next line and there is no
      // remaining moment for a fade to be heard in.
      if (sustained !== undefined) {
        const voice = sustained
        sustained = undefined
        voice.source.onended = null
        try {
          voice.source.stop()
        } catch {
          // Already stopped, or never started.
        }
        voice.source.disconnect()
        voice.gain.disconnect()
        voice.panner.disconnect()
      }
      master?.disconnect()
      master = undefined
      // `close()` releases the audio hardware. It rejects on a context that is
      // already closed, which a second `dispose` would produce.
      void ctx?.close().catch(() => undefined)
      ctx = undefined
      decoded.clear()
    },
  }
}
