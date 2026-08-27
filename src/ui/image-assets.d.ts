/**
 * Artwork imported for its URL, the same way the samples are (ticket 027's
 * `audio-assets.d.ts`, and see it for why `?url` rather than `public/`).
 *
 * THE START SCREEN'S ART GOES THROUGH THE BUNDLER because nothing writes it:
 * `assets/source/character-*.png` and `jungle-background.png` are hand-made
 * files that are simply there, so a rename can be a build failure with the
 * importing line named. The sprites and levels stay in `public/generated`
 * because `tools/import-levels.mjs` produces them and the app cannot import what
 * the tool has not yet written.
 */
declare module '*.png?url' {
  const src: string
  export default src
}
