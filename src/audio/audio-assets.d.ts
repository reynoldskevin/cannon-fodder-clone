/**
 * Wave files imported for their URL (ticket 027).
 *
 * `?url` IS VITE'S EXPLICIT ASSET IMPORT: the file is emitted into the build with
 * a content hash and the import evaluates to the path it landed on. That is the
 * half of the decision this file exists for — the assets are IMPORTED rather than
 * copied into `public/`, so a renamed or deleted sample is a BUILD failure with
 * the importing line named, instead of a 404 heard by nobody in a build that
 * otherwise looks fine. The sprites and levels go the other way because a TOOL
 * writes them (`tools/import-levels.mjs`) and the app cannot import files that do
 * not exist until the tool has run; the audio has no such step.
 *
 * DECLARED HERE RATHER THAN BY REFERENCING `vite/client`, so the project's
 * `types: ["node"]` stays the whole ambient surface and one narrow module shape
 * is added rather than the whole client runtime's globals.
 */
declare module '*.wav?url' {
  const src: string
  export default src
}
