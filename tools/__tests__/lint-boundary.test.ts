import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')

/**
 * Ticket 001, acceptance criterion 3.
 *
 * The `core/` <-> `render/` seam from ARCHITECTURE.md is what makes logic-only
 * testing enforceable. A convention is not enough — it must be a lint failure.
 * These tests lint *virtual* files (the path decides which config applies, the
 * file need not exist on disk) so the rule is verified by path, not by fixture.
 */

const BOUNDARY_RULE = 'no-restricted-imports'

let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: root })
})

async function boundaryErrorsFor(code: string, relPath: string): Promise<string[]> {
  const results = await eslint.lintText(code, {
    filePath: resolve(root, relPath),
    warnIgnored: false,
  })
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId?.includes(BOUNDARY_RULE))
    .map((m) => m.message)
}

describe('core/ must not import three', () => {
  it('rejects a bare `three` import from src/core', async () => {
    const errors = await boundaryErrorsFor(
      `import * as THREE from 'three'\nexport const v = THREE\n`,
      'src/core/violation.ts',
    )
    expect(errors.length, 'expected src/core importing three to be a lint error').toBeGreaterThan(0)
  })

  it('rejects a deep `three/...` subpath import from src/core', async () => {
    const errors = await boundaryErrorsFor(
      `import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'\nexport const v = OrbitControls\n`,
      'src/core/violation-deep.ts',
    )
    expect(errors.length, 'expected src/core importing a three subpath to be a lint error').toBeGreaterThan(0)
  })

  it('rejects importing from src/render inside src/core', async () => {
    const errors = await boundaryErrorsFor(
      `import { SceneBuilder } from '../render/SceneBuilder'\nexport const v = SceneBuilder\n`,
      'src/core/violation-render.ts',
    )
    expect(errors.length, 'expected src/core importing render/ to be a lint error').toBeGreaterThan(0)
  })

  it('rejects a bare `three` import from tools/', async () => {
    const errors = await boundaryErrorsFor(
      `import * as THREE from 'three'\nexport const v = THREE\n`,
      'tools/violation.ts',
    )
    expect(errors.length, 'expected tools/ importing three to be a lint error').toBeGreaterThan(0)
  })
})

describe('render/ may import three', () => {
  it('allows a bare `three` import from src/render', async () => {
    const errors = await boundaryErrorsFor(
      `import * as THREE from 'three'\nexport const v = THREE\n`,
      'src/render/allowed.ts',
    )
    expect(errors, 'src/render importing three must NOT be a boundary error').toEqual([])
  })

  it('allows a bare `three` import from src/app', async () => {
    const errors = await boundaryErrorsFor(
      `import * as THREE from 'three'\nexport const v = THREE\n`,
      'src/app/allowed.ts',
    )
    expect(errors, 'src/app importing three must NOT be a boundary error').toEqual([])
  })
})

describe('core/ may import its own modules', () => {
  it('allows a relative import within src/core', async () => {
    const errors = await boundaryErrorsFor(
      `import { thing } from './thing'\nexport const v = thing\n`,
      'src/core/ok.ts',
    )
    expect(errors, 'intra-core imports must not be restricted').toEqual([])
  })
})
