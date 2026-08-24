import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const readJson = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'))

describe('ticket 001 — directory skeleton', () => {
  const required = [
    'src/core',
    'src/render',
    'src/input',
    'src/ui',
    'src/audio',
    'src/app',
    'tools',
    'assets/source',
    'public/generated',
  ]

  it.each(required)('%s exists', (dir) => {
    expect(existsSync(resolve(root, dir)), `missing directory: ${dir}`).toBe(true)
  })
})

describe('ticket 001 — npm scripts', () => {
  const required = ['dev', 'build', 'test', 'lint', 'import:levels', 'build:models']

  it.each(required)('package.json defines the "%s" script', (script) => {
    const pkg = readJson('package.json')
    expect(pkg.scripts, 'package.json has no scripts block').toBeDefined()
    expect(
      typeof pkg.scripts[script],
      `missing npm script: ${script}`,
    ).toBe('string')
    expect(pkg.scripts[script].trim().length).toBeGreaterThan(0)
  })

  it('declares three and vite as real dependencies', () => {
    const pkg = readJson('package.json')
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(all.three).toBeDefined()
    expect(all.vite).toBeDefined()
  })
})

describe('ticket 001 — typescript strictness', () => {
  // tsconfig may carry comments; strip them before parsing.
  const loadTsconfig = (): Record<string, unknown> => {
    const raw = readFileSync(resolve(root, 'tsconfig.json'), 'utf8')
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(stripped)
  }

  it('tsconfig.json exists', () => {
    expect(existsSync(resolve(root, 'tsconfig.json'))).toBe(true)
  })

  it('enables strict', () => {
    const cfg = loadTsconfig() as { compilerOptions?: Record<string, unknown> }
    expect(cfg.compilerOptions?.strict).toBe(true)
  })

  it('enables noUncheckedIndexedAccess', () => {
    const cfg = loadTsconfig() as { compilerOptions?: Record<string, unknown> }
    expect(cfg.compilerOptions?.noUncheckedIndexedAccess).toBe(true)
  })
})

describe('ticket 001 — README records the deploy URL', () => {
  it('README.md exists and contains an http(s) URL', () => {
    const path = resolve(root, 'README.md')
    expect(existsSync(path), 'README.md is missing').toBe(true)
    const readme = readFileSync(path, 'utf8')
    expect(
      /https?:\/\/[^\s)]+/.test(readme),
      'README.md records no deploy URL',
    ).toBe(true)
  })
})
