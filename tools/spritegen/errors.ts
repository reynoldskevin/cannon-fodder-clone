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

/**
 * Raised when the requested rects cannot be placed inside `maxSize`.
 *
 * It extends `SpritegenError` on purpose: a packing failure is a spritegen
 * failure like any other, and callers (notably `tools/build-models.mjs`) catch
 * the base type to print one clean message instead of a raw stack. A sibling
 * class that escaped that catch would be a worse error report for the same bug.
 */
export class PackError extends SpritegenError {
  constructor(message: string) {
    super(message)
    this.name = 'PackError'
  }
}
