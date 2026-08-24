/**
 * Engine-free simulation layer.
 *
 * Nothing in `src/core/**` may import `three` or anything from `src/render/**`
 * — that boundary is enforced by ESLint (`no-restricted-imports`) so the whole
 * simulation stays testable in plain Vitest with no WebGL.
 */
export const CORE_VERSION = '0.0.0'
