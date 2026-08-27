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

const PRESENTATION_MESSAGE =
  'src/core/render-state/** and src/core/view/** decide what is DRAWN and must not reach the game rules (core/combat, core/ordnance, core/world). That separation is what lets the FX layer be added after the simulation without any visual change altering a mission.'

const DOM_MESSAGE =
  'src/core/** and tools/** must stay engine-free: the DOM is not available there. A headless replay, the determinism checks and every unit test run this code under Node with no window at all. Put anything that needs a browser in src/render, src/app, src/ui, src/input or src/audio.'

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
      /**
       * THE ENGINE-FREE BOUNDARY HAS A HOLE THE IMPORT RULES CANNOT SEE
       * (ticket 027).
       *
       * `window`, `document` and `AudioContext` are AMBIENT — they need no
       * import, so `no-restricted-imports` never visits them, and `tsconfig`'s
       * `lib` includes `DOM` for the sake of `src/render` and `src/app`, so the
       * compiler is happy too. Adversarial review demonstrated it: appending
       * `new AudioContext()`, `window.innerWidth` and `document.body` to a file
       * in `src/core` passed both `eslint` and `tsc` completely clean.
       *
       * That is the same shape of false confidence ticket 025 found one rule
       * along — a boundary that was correct in every file and enforced in none.
       * `core` must run under Node with no DOM at all: it is the layer a
       * headless replay, a determinism check and every unit test in the project
       * execute in.
       */
      'no-restricted-globals': [
        'error',
        { name: 'window', message: DOM_MESSAGE },
        { name: 'document', message: DOM_MESSAGE },
        { name: 'navigator', message: DOM_MESSAGE },
        { name: 'localStorage', message: DOM_MESSAGE },
        { name: 'AudioContext', message: DOM_MESSAGE },
        { name: 'requestAnimationFrame', message: DOM_MESSAGE },
        // NOT `performance`: it is a real Node global and a pathing test times
        // itself with it. Banning it would be banning the standard library.
      ],
    },
  },
  {
    /**
     * THE PRESENTATION MODULES INSIDE `core` MAY NOT REACH THE GAME'S RULES
     * (ticket 025).
     *
     * `core/render-state` and `core/view` decide what is DRAWN — which streaks
     * are on screen, which effects are alive, how hard a blast shakes the
     * camera. That is what lets the whole FX layer be added in milestone 4,
     * after the simulation and after every balance decision: a purely visual
     * system cannot change a mission. The moment one of them imports a weapon
     * table or an ordnance spec, an FX tuning change becomes a balance change
     * and that property is gone.
     *
     * ADDED BECAUSE A COMMENT CLAIMED IT WAS ALREADY TRUE AND IT WAS NOT. Ticket
     * 025's own determinism test asserted in prose that this was "a compile-time
     * fact"; adversarial review checked, added `import { ORDNANCE }` to
     * `core/render-state/fx.ts`, and got a clean lint and a green suite. The
     * rule above only ever restricted the SIBLING layers. Nothing in the tree
     * violated the boundary — but nothing enforced it either, which is precisely
     * the false-confidence this project keeps finding.
     */
    files: ['src/core/render-state/**/*.{ts,tsx}', 'src/core/view/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenInCore.patterns,
            {
              group: [
                '**/core/combat',
                '**/core/combat/**',
                '**/core/ordnance',
                '**/core/ordnance/**',
                '**/core/world',
                '**/core/world/**',
                '../combat',
                '../combat/**',
                '../ordnance',
                '../ordnance/**',
                '../world',
                '../world/**',
              ],
              message: PRESENTATION_MESSAGE,
            },
          ],
        },
      ],
    },
  },
)
