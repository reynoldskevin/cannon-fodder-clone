import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    /**
     * NO SOURCEMAPS IN THE DEPLOY (ticket 081).
     *
     * `true` emitted a 4.25 MB `index.js.map` beside a 667 kB bundle — six times
     * the size of the code it described, and 15% of everything in `dist`. Not one
     * byte of it reached a player: a browser fetches a `.map` only when devtools
     * is open. The cost was the upload and the per-deployment storage, paid on
     * every deploy, for a file whose only reader already has the repository.
     *
     * `false` RATHER THAN `'hidden'`, which still writes the map and merely drops
     * the `//# sourceMappingURL` comment — losing the browser's ability to use it
     * while keeping the whole upload. Nothing here consumes maps in production:
     * no error reporter, no symbol upload.
     */
    sourcemap: false,
  },
})
