# Game Week — Cannon Fodder Remake

A browser-native, isometric squad shooter built in TypeScript on Three.js.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Deploy URL

**https://game-week-sensationmms-projects.vercel.app**

Deployed on Vercel (scope `sensationmms-projects`). This is the stable production
alias — it always points at the latest production deploy, so it is the URL to use
for the demo. Individual deploys also get their own immutable
`game-week-<hash>-sensationmms-projects.vercel.app` URL.

> ⚠️ **Deployment Protection must stay OFF for this project.** Vercel enables SSO
> authentication on new projects by default, which bounces anonymous visitors to a
> login page — that would kill the five-minute demo in front of judges. Verify with
> `curl -s -o /dev/null -w '%{http_code}' <url>`: **200** is good, **302** means
> protection is back on. Turn it off at *Project Settings → Deployment Protection →
> Vercel Authentication → Disabled*.

## Requirements

- Node 20+
- npm

## Getting started

```bash
npm install
npm run dev
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then produce the static bundle in `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode, for TDD |
| `npm run lint` | ESLint over the whole repo, including the architecture boundary rule |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run import:levels` | Offline level import pipeline (stub — see ticket 001) |
| `npm run build:models` | Offline sprite-sheet voxelisation pipeline (stub — see ticket 001) |

## Layout

```
src/core/     deterministic, engine-free simulation (NEVER imports three)
src/render/   Three.js scene, camera rig, post-processing
src/input/    pointer + keyboard controllers
src/ui/       HUD, menus, Boot Hill
src/audio/    SFX and music
src/app/      bootstrap, state machine, main loop
tools/        offline Node pipelines (level import, voxelisation) — also three-free
assets/source/     source art and annotated map images (inputs to tools/)
public/generated/  build-pipeline outputs (level.json, GLB) served as static files
```

## The core boundary

`src/core/**` is the simulation layer and `tools/**` is offline Node tooling.
Neither may import `three`, any `three/...` subpath, nor **any** other source
layer (`src/render`, `src/app`, `src/ui`, `src/input`, `src/audio`) — those
layers are free to import three, so depending on them would let core reach the
engine transitively.

This is enforced in [`eslint.config.js`](./eslint.config.js) by two rules:
`no-restricted-imports` for static `import` / `export ... from`, and
`no-restricted-syntax` for dynamic `import()` and `require()` (which
`no-restricted-imports` never visits). A violation fails `npm run lint` rather
than merely breaking a convention. It is what keeps every gameplay rule testable
in milliseconds under Vitest with no WebGL, and what keeps the renderer
swappable.

Everything else may import three freely, and intra-`core` relative imports
(`./thing`) are unrestricted.

## Deployment

`npm run build` emits a fully static bundle to `dist/` with relative asset paths
(`base: './'`), so it can be served from any static host or subpath.

This project deploys to **Vercel**, configured by [`vercel.json`](./vercel.json):

```sh
vercel deploy --prod --scope sensationmms-projects
```

Note that `buildCommand` is `npm run build`, which is `tsc --noEmit && vite build`
— so a type error fails the deploy rather than shipping a broken bundle. That is
deliberate: the deployed URL is the demo, and it should never be able to go
stale-but-green.

Because Vercel builds from source, `dist/` stays gitignored and is never
committed.
