/**
 * The failure types of the offline sprite pipeline.
 *
 * `tools/spritegen` is a build-time tool: every failure is fatal, and every
 * failure must name the file and the problem loudly enough that an artist can
 * fix the source asset without reading the pipeline. A silently short atlas —
 * a sheet that sliced to 30 frames instead of 32 — is the failure mode that
 * costs the most time downstream, so nothing here degrades gracefully.
 */
export class SpritegenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SpritegenError'
  }
}

/** Raised when the requested rects cannot be placed inside `maxSize`. */
export class PackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackError'
  }
}
