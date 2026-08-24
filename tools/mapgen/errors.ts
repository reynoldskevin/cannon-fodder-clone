/**
 * The single failure type of the offline importer.
 *
 * `tools/mapgen` is a build-time tool, not a runtime library: every failure is
 * fatal and every failure must name the file and the problem loudly enough that
 * an artist can fix the source asset without reading the importer. One error
 * class, one message convention.
 */
export class MapgenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MapgenError'
  }
}
