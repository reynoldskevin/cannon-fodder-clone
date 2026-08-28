/**
 * Sound samples imported for their URL (ticket 027, re-encoded in ticket 082).
 *
 * `?url` IS VITE'S EXPLICIT ASSET IMPORT: the file is emitted into the build with
 * a content hash and the import evaluates to the path it landed on. That is the
 * half of the decision this file exists for — the assets are IMPORTED rather than
 * copied into `public/`, so a renamed or deleted sample is a BUILD failure with
 * the importing line named, instead of a 404 heard by nobody in a build that
 * otherwise looks fine.
 *
 * `.m4a`, AND `.wav` IS DELIBERATELY NOT DECLARED. The masters are 96 kHz 24-bit
 * and the browser resamples to 48 kHz on arrival, so shipping them spent 10.19 MB
 * to deliver 0.31 MB of audible difference. Leaving the old declaration behind
 * would let a `.wav` import compile again without anyone deciding to; removing it
 * makes that a type error at the import line, which is the earliest place it can
 * be caught. `tools/encode-audio.mjs` is what produces these, and why AAC rather
 * than the smaller Opus.
 *
 * SO THE AUDIO NOW HAS A BUILD STEP, which this comment used to say it did not.
 * It differs from the sprite and level pipelines in the way that matters here:
 * `tools/import-levels.mjs` writes into `public/generated/`, which is emitted and
 * not committed, so the app genuinely cannot import those until the tool has run.
 * The encoded samples ARE committed, so a clean clone builds without ffmpeg and
 * only someone re-exporting a master needs to run anything.
 *
 * DECLARED HERE RATHER THAN BY REFERENCING `vite/client`, so the project's
 * `types: ["node"]` stays the whole ambient surface and one narrow module shape
 * is added rather than the whole client runtime's globals.
 */
declare module '*.m4a?url' {
  const src: string
  export default src
}
