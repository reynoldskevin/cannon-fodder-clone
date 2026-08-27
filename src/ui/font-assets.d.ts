/**
 * Web fonts imported for their URL, as the samples and the start-screen art are
 * (`audio-assets.d.ts`, `image-assets.d.ts`, and see the first of those for why
 * `?url` rather than `public/`).
 *
 * A RENAMED FONT SHOULD BE A BUILD FAILURE, not a screen that quietly falls back
 * to a system face and looks nearly right — which is exactly the kind of
 * regression nobody files.
 */
declare module '*.woff2?url' {
  const src: string
  export default src
}
