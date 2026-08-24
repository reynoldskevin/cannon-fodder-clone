/**
 * A `node:module` resolve hook that lets the offline tooling import TypeScript
 * sources the way every other tool in this repo does — without an extension.
 *
 * Node strips types but does NOT guess extensions, so `import './errors'` fails
 * under a plain `node tools/import-levels.mjs`. The previous fix for that was to
 * write `./errors.ts` inside `src/core/level/` and turn on
 * `allowImportingTsExtensions` project-wide: offline tooling reaching into game
 * source, and into the shared compiler config, for its own convenience.
 *
 * The need is entirely `tools/`', so the workaround lives entirely in `tools/`.
 * Vite, Vitest and `tsc` all resolve extensionless relative specifiers already;
 * this hook is the one runtime that does not.
 */

const RELATIVE = /^\.\.?\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
    // Try the TypeScript source first, then fall through to Node's own answer
    // so a genuinely missing module still reports Node's error, not ours.
    try {
      return await nextResolve(`${specifier}.ts`, context)
    } catch {
      /* not a .ts module — fall through */
    }
  }
  return nextResolve(specifier, context)
}
