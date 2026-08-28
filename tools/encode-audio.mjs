#!/usr/bin/env node
/**
 * Encode the sound masters into the samples the game ships (ticket 082).
 *
 * WHY THIS SCRIPT EXISTS AT ALL. The masters in `assets/source/audio/*.wav` are
 * gitignored — five of the nine are 96 kHz 24-bit stereo and the nine together
 * are 10.19 MB, which is not what a repository is for. The 0.31 MB of `.m4a` it
 * writes ARE committed, because the build imports them and a clean clone has to
 * be able to run. That split only works if the step between the two is written
 * down somewhere runnable; a commit message would not survive the first person
 * who needs to re-export a sample.
 *
 * WHAT THE SETTINGS ARE FOR:
 *
 * - `-ar 48000` because `AudioContext` runs at 48 kHz. `decodeAudioData` resamples
 *   whatever it is given, so a 96 kHz master spends double the bytes to deliver
 *   audio the browser immediately throws half of away. This is where most of the
 *   97% comes from — the container change alone would not have done it.
 *
 * - `-c:a aac -b:a 128k` rather than Opus, which measured 100 kB smaller across
 *   the whole bank. Safari only learned to decode Ogg in 17.5, and `load` in
 *   `src/audio/index.ts` deliberately swallows a failed decode so one bad sample
 *   cannot break a mission. An unsupported container would therefore go silent
 *   rather than throw: no error, no failing test, just a mute game on Safari.
 *   128 kbps is also above where AAC artefacts are audible on percussive
 *   material, which is all of this.
 *
 * - `-movflags +faststart` puts the MP4 index at the front. `load` fetches the
 *   whole buffer before decoding so it changes nothing today, but it costs
 *   nothing and it is the difference between a file that can stream and one that
 *   cannot.
 *
 * Channel count is left alone on purpose. `gunfire` is downmixed to mono at play
 * time by the positional path, and doing it here as well would bake a decision
 * that `CUE_IS_POSITIONAL` is supposed to own.
 *
 * Usage: npm run encode:audio    (requires ffmpeg on PATH)
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = new URL('../assets/source/audio/', import.meta.url)

const SAMPLE_RATE = '48000'
const BITRATE = '128k'

function main() {
  if (!existsSync(SOURCE)) {
    console.error(`No master directory at ${fileURLToPath(SOURCE)}.`)
    console.error('The masters are gitignored — they live outside the repository.')
    process.exit(1)
  }

  const masters = readdirSync(SOURCE)
    .filter((name) => name.endsWith('.wav'))
    .sort()

  if (masters.length === 0) {
    console.error(`No .wav masters in ${fileURLToPath(SOURCE)}.`)
    process.exit(1)
  }

  let before = 0
  let after = 0

  for (const master of masters) {
    const input = new URL(master, SOURCE)
    const output = new URL(master.replace(/\.wav$/, '.m4a'), SOURCE)

    execFileSync(
      'ffmpeg',
      [
        '-v', 'error',
        '-y',
        '-i', fileURLToPath(input),
        '-ar', SAMPLE_RATE,
        '-c:a', 'aac',
        '-b:a', BITRATE,
        '-movflags', '+faststart',
        fileURLToPath(output),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )

    const from = statSync(input).size
    const to = statSync(output).size
    before += from
    after += to
    console.log(
      `${master.padEnd(20)} ${String(from).padStart(9)} -> ${String(to).padStart(7)} B` +
        `  (${String(Math.round((1 - to / from) * 100))}% smaller)`,
    )
  }

  console.log(
    `\n${String(masters.length)} samples: ` +
      `${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB ` +
      `(${String(Math.round((1 - after / before) * 100))}% smaller)`,
  )
  console.log('The .m4a files are committed; the .wav masters are not.')
}

main()
