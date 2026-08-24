/**
 * Deterministic JSON serialisation.
 *
 * Generated `level.json` files are checked in and diffed, so the output must be
 * byte-identical across runs and across machines: no timestamps, no hash-order
 * key iteration, and grid rows kept on a single line so a one-tile change shows
 * up as a one-line diff instead of a thousand-line one.
 *
 * Key order is the insertion order of the objects the importer builds — which is
 * fixed in code — so no sorting is applied here; sorting would only hide an
 * accidental order change rather than prevent it.
 */

type JsonValue = unknown

function isPrimitiveRow(value: readonly unknown[]): boolean {
  return value.every((v) => typeof v === 'number' || typeof v === 'boolean' || v === null)
}

function serialise(value: JsonValue, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    // Grids and other rows of scalars stay on one line.
    if (isPrimitiveRow(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`
    const inner = indent + '  '
    const items = value.map((v) => inner + serialise(v, inner))
    return `[\n${items.join(',\n')}\n${indent}]`
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    if (entries.length === 0) return '{}'
    const inner = indent + '  '
    const items = entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${serialise(v, inner)}`)
    return `{\n${items.join(',\n')}\n${indent}}`
  }

  return JSON.stringify(value) ?? 'null'
}

/** Stable, human-diffable JSON text, newline-terminated. */
export function stableStringify(value: JsonValue): string {
  return `${serialise(value, '')}\n`
}
