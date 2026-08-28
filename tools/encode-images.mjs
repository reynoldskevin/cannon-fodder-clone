#!/usr/bin/env node
/**
 * Encode the screen art into the WebP the game ships (ticket 083).
 *
 * WHY THIS IS A TABLE AND NOT A GLOB. Every entry below is a measurement, not a
 * preference, and two of them go against the obvious default — which is exactly
 * what a glob over `*.png` would erase. The masters stay `.png` and stay tracked:
 * `grenade` and `rocket` are `tools/spritegen` inputs as well as icons, so
 * replacing them in place would feed already-lossy art into the atlas packer.
 * This writes the shipped file BESIDE the master, the way `encode-audio.mjs`
 * does.
 *
 * `q92` RATHER THAN THE AGGRESSIVE END. q85 would save another 60 kB across the
 * whole set — not worth arguing about when `menu.ts` draws the cast at
 * `min(138vh, 162vw)`, upscaled past its 1024px source, where artefacts are
 * magnified rather than hidden. `-alpha_q 100` keeps the alpha channel lossless
 * so cut-out edges are byte-exact; only colour is approximated.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 * - `jungle-background.png` IS A JPEG. Its magic bytes are `ffd8ffe0`; it works
 *   only because browsers sniff content rather than trusting extensions. It is
 *   therefore already lossy at 191 kB, and q92 makes it BIGGER (224 kB) while
 *   adding a second generation of loss to the largest continuous area of the
 *   menu. Converting it would cost bytes and quality at once. (The name is wrong
 *   and worth fixing — just not in this ticket.)
 *
 * - `hill-path-background.webp` is already WebP, from before this pipeline
 *   existed.
 *
 * Usage: npm run encode:images    (requires cwebp from libwebp on PATH)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ASSETS = new URL('../assets/source/', import.meta.url)

/**
 * `lossless` where it was measured smaller, `q92` everywhere else.
 *
 * `instructions` is the one lossless entry and it earns it twice over: it is a
 * card of instruction TEXT, where lossy ringing shows first and worst, and it is
 * also the only image here where lossless is simply the smaller file — 45.8 kB
 * against 48.2 kB at q92. Both arguments point the same way, which is the only
 * reason it is not a judgement call.
 */
const IMAGES = [
  { file: 'sprites/grenade.png', mode: 'q92' },
  { file: 'sprites/rifle.png', mode: 'q92' },
  { file: 'sprites/rocket.png', mode: 'q92' },
  { file: 'sprites/instructions.png', mode: 'lossless' },
  { file: 'sprites/cross.png', mode: 'q92' },
  { file: 'sprites/rank-insignia-sheet.png', mode: 'q92' },
  { file: 'sprites/poppy.png', mode: 'q92' },
  { file: 'logo.png', mode: 'q92' },
  { file: 'character-sarge.png', mode: 'q92' },
  { file: 'character-shades.png', mode: 'q92' },
  { file: 'character-lucky.png', mode: 'q92' },
]

const ARGS = {
  q92: ['-q', '92', '-alpha_q', '100'],
  lossless: ['-lossless'],
}

function main() {
  let before = 0
  let after = 0

  for (const { file, mode } of IMAGES) {
    const input = new URL(file, ASSETS)
    if (!existsSync(input)) {
      console.error(`Missing master: ${fileURLToPath(input)}`)
      process.exit(1)
    }
    const output = new URL(file.replace(/\.png$/, '.webp'), ASSETS)

    execFileSync(
      'cwebp',
      ['-quiet', ...ARGS[mode], fileURLToPath(input), '-o', fileURLToPath(output)],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )

    const from = statSync(input).size
    const to = statSync(output).size
    before += from
    after += to
    console.log(
      `${file.padEnd(32)} ${mode.padEnd(8)} ${String(from).padStart(8)} -> ` +
        `${String(to).padStart(7)} B  (${String(Math.round((1 - to / from) * 100))}% smaller)`,
    )
  }

  console.log(
    `\n${String(IMAGES.length)} images: ${(before / 1048576).toFixed(2)} MB -> ` +
      `${(after / 1048576).toFixed(2)} MB ` +
      `(${String(Math.round((1 - after / before) * 100))}% smaller)`,
  )
  console.log('Masters stay .png and stay tracked — spritegen still packs them.')
}

main()
