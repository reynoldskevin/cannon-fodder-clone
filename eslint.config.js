import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Architectural boundary (ARCHITECTURE.md):
 *
 *   src/core/**  — the deterministic, engine-free simulation layer.
 *   tools/**     — offline Node tooling.
 *
 * Neither may import `three` (or any `three/...` subpath) nor reach into ANY
 * other source layer (`src/render`, `src/app`, `src/ui`, `src/input`,
 * `src/audio`) — each of those is free to import three, so allowing them would
 * let core reach the engine transitively and defeat the whole boundary.
 *
 * This is what keeps the simulation testable in plain Vitest with no WebGL, and
 * it is enforced here rather than by convention.
 *
 * The boundary is enforced twice over:
 *   - `no-restricted-imports`  — static `import` / `export ... from`.
 *   - `no-restricted-syntax`   — dynamic `import()` and `require()`, which
 *                                `no-restricted-imports` never visits.
 */

const THREE_MESSAGE =
  'src/core/** and tools/** must stay engine-free: do not import three here. Put rendering code in src/render/.'

const LAYER_MESSAGE =
  'src/core/** and tools/** must not depend on any other source layer (render/app/ui/input/audio): those layers may import three, so depending on them breaks the engine-free boundary.'

/** Sibling layers that src/core and tools may never reach into. */
const SIBLING_LAYERS = ['render', 'app', 'ui', 'input', 'audio']

/**
 * Every plausible spelling of "reach into `src/<layer>`" — bare, aliased,
 * root-relative and relative at any realistic depth.
 */
const layerPatterns = (layer) => [
  layer,
  `${layer}/*`,
  `${layer}/**`,
  `*/${layer}`,
  `*/${layer}/*`,
  `*/${layer}/**`,
  `**/${layer}`,
  `**/${layer}/*`,
  `**/${layer}/**`,
  `../${layer}`,
  `../${layer}/*`,
  `../${layer}/**`,
  `../../${layer}`,
  `../../${layer}/*`,
  `../../${layer}/**`,
  `../../../${layer}`,
  `../../../${layer}/*`,
  `../../../${layer}/**`,
  `@/${layer}`,
  `@/${layer}/*`,
  `@/${layer}/**`,
  `src/${layer}`,
  `src/${layer}/*`,
  `src/${layer}/**`,
]

const forbiddenInCore = {
  patterns: [
    {
      group: ['three', 'three/*', 'three/**'],
      message: THREE_MESSAGE,
    },
    {
      group: SIBLING_LAYERS.flatMap(layerPatterns),
      message: LAYER_MESSAGE,
    },
  ],
}

const LAYER_ALTERNATION = SIBLING_LAYERS.join('|')

/**
 * `no-restricted-imports` only visits static import/export declarations, so a
 * dynamic `await import('three')` — exactly what a later lazy-loaded renderer
 * would use — sails straight through it. These selectors close that hole.
 */
const forbiddenSyntaxInCore = [
  {
    selector: 'ImportExpression[source.value=/^three(\\/|$)/]',
    message: THREE_MESSAGE,
  },
  {
    // `require('three')` / `require('three/...')` under tools/**, reported as an
    // architecture violation rather than incidentally as a CommonJS style nit.
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^three(\\/|$)/]",
    message: THREE_MESSAGE,
  },
  {
    // Relative reach-out: `../render/PostFX`, `../../app/main`, ...
    selector: `ImportExpression[source.value=/^\\.\\.\\/(\\.\\.\\/)*(${LAYER_ALTERNATION})(\\/|$)/]`,
    message: LAYER_MESSAGE,
  },
  {
    // Aliased / root-relative reach-out: `@/render/X`, `src/app/main`.
    selector: `ImportExpression[source.value=/^(@\\/|src\\/)(${LAYER_ALTERNATION})(\\/|$)/]`,
    message: LAYER_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/^\\.\\.\\/(\\.\\.\\/)*(${LAYER_ALTERNATION})(\\/|$)/]`,
    message: LAYER_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/^(@\\/|src\\/)(${LAYER_ALTERNATION})(\\/|$)/]`,
    message: LAYER_MESSAGE,
  },
]

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },
  {
    // Node-side files: the offline tooling and the build config.
    files: ['tools/**/*.{js,mjs,cjs,ts}', '*.config.{js,mjs,cjs,ts}', 'eslint.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        require: 'readonly',
      },
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx,js,mjs,cjs}', 'tools/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', forbiddenInCore],
      'no-restricted-syntax': ['error', ...forbiddenSyntaxInCore],
    },
  },
)
