# Architecture — Game Week: Cannon Fodder Remake

## Summary

This is a browser-native, top-down squad shooter built in TypeScript on Three.js, aimed at
being a faithful Cannon Fodder recreation with modern rendering. It must be finished,
polished, and demoable in under five minutes after roughly four days of AI-assisted work.
Every structural decision below is made in service of that constraint.

The system splits hard along one seam: a **deterministic, engine-free simulation core**
(`core/`) and a **presentation layer** (`render/`, `ui/`, `audio/`) that only ever reads
simulation state. The core imports nothing from Three.js. This is what makes logic-only
Vitest testing viable — squad movement, pathfinding, combat resolution, ordnance ballistics,
objective evaluation and campaign progression are all pure functions over plain data,
testable in milliseconds with no WebGL. It also means the renderer is swappable, which is the
escape hatch if the visual technique has to change mid-build.

The second decision is that **all expensive transformation happens offline, at build time,
never at runtime**. Two Node-side pipelines feed the game: `tools/mapgen` turns each annotated
map image into a validated, versioned `level.json` (terrain grid plus typed entity spawns for
avatars, enemy soldiers and loot chests), and `tools/voxelize` turns each 2D sprite sheet into
stacked-layer voxel meshes with genuine 3D volume. The game itself loads only JSON and GLB —
it never parses an image or builds geometry from source art. This keeps load times demo-safe,
makes both pipelines independently testable, and means re-importing all five levels after a
schema change is one command, not five afternoons.

Rendering targets the "strongest graphics" criterion directly. The camera is a locked
**square (yaw 0), high-elevation orthographic rig** with smooth scroll-follow, matching the
source art's own viewpoint while the world underneath is genuinely 3D and genuinely lit.
(Ticket 009a changed this from the brief's 45-degree isometric — see *The camera is square,
not isometric* under Key tradeoffs.) Voxel-extruded soldiers are drawn through
per-frame `InstancedMesh` batches so a full squad plus dozens of enemies stays in a handful of
draw calls. A post-processing chain (bloom, SSAO, tilt-shift depth-of-field) plus GPU particle
explosions and screen shake sits behind a single `PostFX` component with a quality flag, so it
can be dialled down or off without touching gameplay code.

Enemy movement uses **flow-field pathfinding** rather than per-unit A*: one field per target
per level grid, shared by every unit heading there. It is cheaper, trivially unit-testable, and
degrades gracefully with unit count.

Around the mission loop sits a thin campaign layer — persistent named recruits, promotion by
survival, and a Boot Hill screen that gravestones the dead — persisted to `localStorage` and
carried across the five levels. It costs little and supplies the emotional beat the demo needs.

Deployment is a static Vite build on a public URL, stood up in Milestone 1 so the game is live
from day one and the demo never depends on a laptop.

Extension points for vehicles, buildings, additional ordnance, a level editor and multiplayer
are named explicitly below; none are built, but none are designed out of reach.

## Goals & non-goals

**Goals** (traced to the brief and clarifying answers)

- A playable, finishable game demoable end-to-end in under 5 minutes.
- Faithful Cannon Fodder core loop: point-and-click squad movement, click-to-shoot, a
  scrolling battlefield seen square-on from above, mission objectives, permadeath.
- Grenades and rockets as selectable ordnance (brief-confirmed fidelity level).
- Boot Hill screen with progression across levels, and a squad assigned by the game rather than picked (ticket 040).
- Five levels imported from the supplied annotated map images.
- Modern graphics: real 3D lighting, voxel-extruded units, post-processing, particles.
- Audio: weapon SFX, explosions, ambience, music.
- Deployed to a public static URL.
- Logic covered by Vitest unit tests.

**Non-goals** (explicitly deferred — see Extension points / Backlog)

- Vehicles (jeeps, tanks, boats, helicopters).
- Enterable buildings, destructible bridges, terrain deformation.
- Multiplayer of any kind.
- An in-game level editor or asset authoring UI.
- Rigged skeletal animation or imported humanoid rigs.
- Mobile / touch input, save-slot management, localisation, accessibility beyond defaults.
- Rendering-layer automated tests (visual regression, WebGL integration).

## Requirements coverage

| Requirement (from brief / answers) | Type | How the architecture satisfies it |
|---|---|---|
| Playable game, finished not broken | MVP | Milestone 1 is a vertical slice: one level, move, shoot, win/lose. Everything after is additive. |
| Demoable in under 5 minutes | Submission | `app/StateMachine` supports a `?demo=1` deep-link that jumps straight to a chosen level with a pre-built squad; deploy is live from M1. |
| 2D scrolling point-and-click battlefield | MVP | `CameraRig` — orthographic, fixed square (yaw 0) high-elevation angle, edge/follow scroll. `PointerController` raycasts pointer to the ground plane for move/fire orders. |
| Faithful recreation | MVP | Sim rules modelled on the original: squad-follow formation, one-shot-kills, line-of-sight fire, objective-count mission completion. |
| Original maps with avatar / enemy / loot-chest start locations | MVP | `tools/mapgen` converts annotated images to `level.json`; `LevelSchema` types exactly these three spawn categories plus terrain. |
| Five levels | Platform | Same pipeline, five inputs. Level count is data, not code. |
| Modern graphics and animations | Criterion (graphics) | Voxel-extruded meshes, PBR-lit scene, `InstancedMesh` batching, `PostFX` chain, particle FX, procedural recoil/bob animation. |
| Grenades and rockets | MVP fidelity | `OrdnanceSystem` — a data-driven table of projectile definitions (arc, blast radius, damage falloff, cooldown); adding a type is a table row. |
| Squad assignment | MVP fidelity | Ticket 040 removed the recruitment screen: the runner fills the squad off the `core/campaign` roster, deterministically, and the player reads who is going on the mission card. |
| Boot Hill / casualty progression | Extra (confirmed) | `core/campaign` holds persistent recruits, ranks and the dead list; `localStorage` adapter behind a `PersistencePort` interface. |
| Audio (SFX + music) | Extra (confirmed) | `audio/AudioBus` subscribes to sim events; no gameplay code touches Web Audio directly. |
| Post-processing polish pass | Extra (confirmed) | `render/PostFX` — `EffectComposer` chain behind a quality setting. |
| Three.js + TypeScript | Platform | Vite + TS strict; Three.js confined to `render/`. |
| Annotated images → offline importer → JSON | Platform | `tools/mapgen`, run via `npm run import:levels`. Game never reads an image as data. |
| Camera-aligned sprite quads from 2D art | Platform | `tools/spritegen`, run via `npm run build:models`. Outputs a packed atlas + manifest. Supersedes the planned `tools/voxelize`: the art is drawn at the camera's own 55° angle and the camera never rotates, so a quad is pixel-exact from the only viewpoint that exists. |
| Deployed static URL | Submission | Static Vite build; deploy wired in M1 ticket 006. |
| Vitest logic-only testing | Engineering | The `core/` ↔ `render/` seam is what makes this enforceable; a lint rule bans Three.js imports under `core/`. |

## Hard problems — how this design addresses each

The brief names no explicit "hard problems" section, so these are the four the design treats as
load-bearing: they are where the project most plausibly fails.

### 1. Turning 2D sprite art into convincing 3D units — in four days

Rigged 3D character work is the classic schedule killer, and there is no reliable automated
path from a sprite sheet to an animated mesh. The design sidesteps the problem rather than
fighting it: `tools/voxelize` reads each sprite frame, quantises it to a voxel grid, extrudes
it along the view axis into layered geometry, greedy-meshes the result into a compact mesh, and
emits one GLB per animation frame plus a manifest. Animation is frame-swapping between
pre-built meshes — the same technique the original used, but with real geometry that lights,
casts shadows and rotates.

The reasoning: this is *fully automatable*, so it costs engineering hours once and asset hours
never. It uses the user's actual art, so the game looks like Cannon Fodder rather than like
generic low-poly. And it produces a distinctive chunky-voxel aesthetic that reads as a
deliberate style rather than a compromise. The risk — voxelisation quality on unknown source
art — is contained by making it an offline tool with a preview harness (ticket 004): if a
sprite converts badly, we tune the tool, not the game.

Fallback, pre-designed: `EntityRenderer` consumes an abstract `UnitVisual` handle. If
voxelisation fails on the real assets, a billboarded-sprite `UnitVisual` implementation is a
contained swap, not a rewrite.

### 2. Keeping the game testable when 90% of it is rendering

Games resist TDD because behaviour is entangled with the render loop. The mitigation is the
`core/` boundary, enforced structurally rather than by discipline: `core/` is a plain
TypeScript library with zero Three.js dependency, advancing a `World` by a fixed timestep
against a plain-data `LevelData` input. Every rule that matters — does this shot hit, does this
grenade kill, does this unit reach that tile, is the mission complete, does this recruit get
promoted — is a pure function tested in Vitest with no browser.

`render/` is then a projection: it diffs `World` state into scene-graph updates each frame and
owns no rules of its own. Untested rendering code is acceptable precisely because it contains
no decisions.

### 3. Squad and enemy movement that feels right and stays cheap

Per-unit A* over five hand-imported maps with dozens of units is both a performance risk and a
testing burden. Instead, each level bakes a navigation grid at import time, and
`PathingSystem` computes a **flow field** (BFS/Dijkstra from the target outward) per active
destination. Every unit heading to that destination reads its direction from one shared field
in O(1). Squad members follow the player-controlled leader through a formation offset table
with local separation steering, which reproduces the original's loose-follow feel.

Flow fields are also far easier to test than pathfinders: given a grid and a target, assert the
field's gradient descends to the target and routes around obstacles. Deterministic, fast,
no fixtures beyond a small ASCII grid.

### 4. A demo that cannot fail in front of judges

Five minutes, one shot. Three structural protections: the build is deployed to a static URL
from Milestone 1, so it is proven live for days rather than minutes; `app/StateMachine`
accepts a URL-encoded entry state so any level can be entered directly with a preset squad,
removing "play through three levels to reach the good bit" from the demo; and `PostFX` carries
a quality flag so an unexpectedly weak demo machine degrades gracefully instead of stuttering.

## Components

All names below match `ARCHITECTURE_DIAGRAM.md`.

### `core/` — engine-free simulation (no Three.js, no DOM)

| Component | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `World` | Owns all entity state (positions, health, team, ordnance, cooldowns) as typed arrays / plain objects; advances one fixed 60 Hz tick. | `LevelData`, `CommandQueue` | Mutated world state + emitted `SimEvent[]` |
| `LevelSchema` | Zod-style runtime schema + TS types for `level.json`: terrain grid, walkability, spawn lists for `avatar` / `enemy` / `loot_chest`, objectives, metadata. | JSON | Validated `LevelData` or a typed parse error |
| `PathingSystem` | Bakes the nav grid; computes and caches flow fields per destination; resolves per-unit desired velocity. | Nav grid, targets | Direction vectors |
| `SquadSystem` | Leader selection, formation offsets, follow/separation steering, squad splitting. | Commands, `World` | Unit move intents |
| `CombatSystem` | Line-of-sight checks, weapon cooldowns, hit resolution, damage, death. | `World` | Damage + `UnitDied` events |
| `OrdnanceSystem` | Data-driven projectile table (bullet / grenade / rocket): arc integration, blast radius, damage falloff, ammo counts. | Fire commands | Projectile entities, `Explosion` events |
| `AISystem` | Enemy behaviour: idle → alerted → engage → pursue, using `PathingSystem` fields. | `World` | Enemy commands |
| `ObjectiveSystem` | Evaluates mission win/fail: kill counts, chests collected, squad wiped. | `World` | `MissionComplete` / `MissionFailed` |
| `Campaign` | Persistent roster: named recruits, rank by kills/missions survived, the dead list for Boot Hill, level unlock state. | `SimEvent[]`, `PersistencePort` | Roster state |
| `PersistencePort` | Interface over storage; `localStorage` adapter in `app/`. Keeps `core/` storage-agnostic and testable with an in-memory fake. | — | — |
| `SimEvent` bus | Typed, ordered event stream emitted per tick (`ShotFired`, `UnitDied`, `Explosion`, `ChestCollected`, `MissionComplete`). The single channel from sim to presentation. | — | Events |

### `render/` — Three.js presentation (reads `World`, never mutates it)

| Component | Responsibility |
|---|---|
| `SceneBuilder` | Constructs the Three.js scene from `LevelData`: lights, sky, fog, shadow config. |
| `TerrainRenderer` | Builds the level mesh from the terrain grid; texture/material assignment per tile type. |
| `EntityRenderer` | Maps world entities to `UnitVisual` handles; per-frame `InstancedMesh` batches keyed by (model, animation frame); procedural bob/recoil/lean on top of frame-swapping. |
| `UnitVisual` | Abstraction over "how a unit is drawn". Voxel-mesh implementation is the mainline; the billboard-sprite implementation is the pre-designed fallback and the seam for future visual styles. |
| `CameraRig` | Orthographic, fixed square angle: yaw 0, elevation 55° by default and retunable at runtime with `?elev=` (25–89). Smooth follow of squad centroid, edge scroll, edge-tight clamp to level bounds, screen-shake channel. The angles and the ground extents they imply live in `core/view/orientation.ts`, engine-free and unit tested; the rig is only the Three.js plumbing. Zoom-out is capped by `core/view/cover.ts` at the widest **sky-free** view — the largest viewport whose ground footprint stays inside the level — so the background is never visible at any zoom or pan position, and the whole level is deliberately never framed at once. Both the cap and the pan clamp charge the level's extruded *silhouette*, not its flat footprint: `core/view/relief.ts` measures how far the level's own tiles rise above and fall below the ground plane, and that overhang is scaled by `cos(elevation)` to screen height. |
| `FXSystem` | Particle explosions, muzzle flashes, tracers, decals, damage flashes. Driven purely by `SimEvent`s. |
| `PostFX` | `EffectComposer` chain — bloom, SSAO, tilt-shift DoF, vignette — behind a `quality: high \| low \| off` flag. |

### `input/`, `ui/`, `audio/`, `app/`

| Component | Responsibility |
|---|---|
| `PointerController` | Raycasts pointer to the ground plane; left-click → move order, right-click / hold → fire order, scroll-wheel or hotkey → ordnance select. Emits `Command`s only — never touches `World` directly. |
| `HUD` | Squad roster strip, ammo counts, ordnance selector, objective tracker, mission timer. DOM overlay, not WebGL — faster to build and to polish. |
| `BootHill` | Post-mission memorial: gravestones for the fallen, promotions for survivors. |
| `Briefing` | The mission card, on black: `Mission <n>. With <N> soldiers you must: <objectives>`. The Debrief screen went with the Recruitment screen in ticket 040; the post-mission summary is owed to `BootHill`. |
| `AudioBus` | Subscribes to `SimEvent`s; pooled Web Audio playback for SFX, ducked music bed, spatial panning by screen position. |
| `GameLoop` | Fixed-timestep accumulator: steps `World` at 60 Hz, renders with interpolation at display rate. Decouples sim determinism from framerate. |
| `StateMachine` | `Menu → BootHill → Briefing → Mission`, a win returning to `BootHill` for the next mission and a loss to `Briefing` to try again. Accepts a URL-encoded entry state for the demo shortcut. |

### `tools/` — offline, Node-side, never shipped to the browser

| Component | Responsibility |
|---|---|
| `mapgen` | Annotated map image + annotation legend → validated `level.json`. Includes a colour/marker-key legend file per level so annotations are declarative and re-runnable. |
| `voxelize` | Sprite sheet → quantised voxel grid → extruded, greedy-meshed geometry → GLB per frame + `models.manifest.json`. |
| `preview` | A tiny local harness to eyeball voxelizer output and level imports without booting the game. |

## Interfaces & data flow

The system is a one-way loop with exactly two crossings of the sim/presentation boundary:

1. **Input → sim.** `PointerController` and `HUD` emit typed `Command` objects
   (`{type: 'move', unitIds, target}`, `{type: 'fire', ordnance, target}`) onto a
   `CommandQueue`. Commands are data; they are drained at the top of each tick. Nothing
   outside `core/` ever writes to `World`.

2. **Sim → presentation.** Each tick, `World` emits an ordered `SimEvent[]`. `FXSystem`,
   `AudioBus`, `HUD` and `Campaign` all subscribe. Continuous state (positions, health) is read
   by `EntityRenderer` directly from `World` each frame and interpolated; discrete moments
   (a shot, a death, an explosion) travel as events. This split keeps the renderer stateless
   with respect to game rules while giving audio and FX precise, one-shot triggers.

**Contracts.**

- `level.json` — versioned. `{ schemaVersion, name, size, terrain: number[][], walkable: bool[][], spawns: { avatars[], enemies[], chests[] }, objectives[] }`. Validated on load; a schema mismatch is a loud, typed failure, not undefined behaviour.
- `models.manifest.json` — `{ [modelId]: { animations: { [name]: { frames: string[], fps } } } }`, mapping logical unit types to GLB frame files. Superseded in practice by `sprites.manifest.json` below; see the sprite-quad decision above.
- `sprites.manifest.json` — versioned. `{ version, origin, scale, atlas, units, props, floor }`, emitted by `tools/spritegen` alongside `atlas.png` and `floor.png`.
  - **Coordinate origin.** Every `rect`, `offset` and `anchor` is in atlas pixels, **top-left origin, y increasing downward** — the PNG convention. The manifest states this as data in `origin: "top-left"` rather than leaving it to be inferred. Three.js texture UVs are **bottom-left** origin, so a consumer must flip: `v = 1 - (y + height) / atlas.height`. Getting this wrong does not crash and does not look broken — every sprite simply renders vertically mirrored.
  - **Placing a sprite.** Four values are needed and all four are in the manifest: `rect` (size the quad), `offset` (where the trimmed pixels sat inside the source cell — never re-centre on content, or a dying soldier slides up the screen), `anchor` (the cell's bottom-centre, the point that meets the ground; constant across an animation), and `units.soldier.cell` (the post-downscale cell size the other three are measured against). The quad's pixel offset from the unit's world position is `(offset.x - anchor.x, offset.y - anchor.y)`, y-down; scale by `unitHeightInWorldUnits / cell.height` and negate y for y-up world space. `scale` is reported for the record — no consumer needs it to lay a sprite out, because `cell` is already post-downscale.
  - `floor.png` is deliberately **not** in the atlas: it is the one texture that must wrap, and wrapping is a property of a whole texture, not a sub-rect.
- `PersistencePort` — `{ load(): CampaignState | null; save(s: CampaignState): void }`.

**Where state lives.** Transient battle state lives only in `World`, rebuilt from `LevelData`
on each mission start. Durable state — roster, dead list, level progress — lives in `Campaign`
and is flushed through `PersistencePort` at mission boundaries only, never mid-frame.

## Cross-cutting concerns

**Testing.** Vitest, logic only. `core/` targets meaningful coverage of pathing, combat,
ordnance, objectives and campaign progression. `tools/` are tested against small fixture images
and sprite sheets checked into the repo. `render/`, `ui/` and `audio/` are not unit tested by
design. A lint rule (`no-restricted-imports` on `three` under `core/**`) makes the boundary a
build failure rather than a convention. Every ticket in `TICKETS.md` carries a real
`test_command` so `tdd-ticket-loop` has something to drive against.

**Performance.** Target 60 fps at 1080p on a mid laptop. Techniques: `InstancedMesh` batching
per (model, frame); frustum culling on the orthographic rig; a single baked terrain mesh per
level; pooled particles and audio nodes; zero per-frame allocation in the sim hot path
(pre-allocated typed arrays, reused vectors). `PostFX` quality is the pressure valve.

**Determinism.** Fixed 60 Hz timestep with an accumulator; no `Math.random()` in `core/` —
a seeded PRNG passed into `World`. This makes every sim test reproducible and would make
replays or netcode possible later.

**Observability.** A dev overlay (`?debug=1`) drawing the nav grid, flow-field arrows,
line-of-sight rays, entity ids and a frame-time graph. This is a build-speed tool, not a
feature — tuning combat feel without it is guesswork.

**Asset & build hygiene.** Source art and annotated maps live in `assets/source/` and are never
loaded by the game; generated `level.json` and GLBs land in `public/generated/` and are
committed so a fresh clone or CI deploy needs no toolchain run. Both pipelines are idempotent.

**Failure handling.** A level that fails schema validation, a missing model in the manifest, or
a WebGL context loss each surface as a visible, specific error screen rather than a black
canvas — because in a five-minute demo, a legible failure is recoverable and a blank screen is
not.

## Extension points (for optional / future deliverables)

Nothing below is built. Each names the exact seam it attaches to, so it can be added without
reworking mainline code.

| Future deliverable | Seam it attaches to |
|---|---|
| **Vehicles** (jeep, tank) | `World` entity records already carry a `kind` discriminant; add a `VehicleSystem` alongside `SquadSystem` and a `mount` command type. `PathingSystem` takes a per-unit traversal mask, so vehicle-only terrain rules need no grid change. |
| **Buildings / enterable structures** | `LevelSchema.terrain` tile types are an open enum; `ObjectiveSystem` objectives are already a typed list, so an `enter_building` objective is a new variant, not a refactor. |
| **Destructible terrain / bridges** | The nav grid is owned by `PathingSystem` and flow fields are cached with an invalidation key — mutating walkability and bumping the key is the whole integration. |
| **More ordnance types** | `OrdnanceSystem`'s projectile table is data. A new weapon is a table row plus an FX mapping. |
| **In-game level editor** | `tools/mapgen` emits the same `level.json` an editor would; the schema is the contract. An editor writes JSON and the game loads it unchanged. |
| **Alternative visual style** (billboards, hand-modelled units) | `UnitVisual` is an interface; `EntityRenderer` depends on it, not on voxel meshes. |
| **Multiplayer / co-op** | The sim is already deterministic, fixed-timestep and command-driven with a seeded PRNG — the three preconditions for lockstep netcode. A `NetworkPort` would sit in front of `CommandQueue`. |
| **Replays** | Same three preconditions: record the `Command` stream plus the seed. |
| **Cloud saves / leaderboards** | `PersistencePort` is an interface; a remote adapter replaces the `localStorage` one. |

## Key tradeoffs & alternatives considered

**The camera is square, not isometric** *(ticket 009a — a decision changed after the brief)*.
The brief asked for isometric and ticket 009 shipped a 45-degree yaw at 40 degrees elevation.
Rendered against the source art it was plainly wrong: `assets/source/levels/*/map.png` is drawn
axis-aligned — the tile grid faces the screen squarely — and from a very high angle, with
canopies reading as rounded blobs from above and short shadows. So yaw is now 0 and elevation
55 degrees (75 in 009a, dropped in 009b after seeing it live — at 75 a block of height *h*
shows only 0.26*h* of side face and raised terrain read as flat colour; at 55 it shows 0.57*h*),
tunable at runtime over 25–89 with `?elev=` because it is a by-eye judgement against the art.
Not 90: a true top-down flattens the raised canopy and loses the read of which tiles block
movement. Cost: the diagonal Cannon Fodder silhouette is gone. Bought: the view matches the art
it is built from, and — because an axis-aligned viewport rectangle over an axis-aligned level
IS its own bounding box — **edge-tight camera clamping**, which the 45-degree rig could not
afford. At yaw 45 the bound is ~√2 larger per axis than what the player can see, so "never show
void" left a band of zooms with zero pan range; ticket 009 had to clamp the look-at point and
show sky at the edges instead. That compromise is deleted, not layered over.

**Zoom-out stops inside the level, not around it — the whole map is never visible at once**
*(ticket 009b — a decision changed after 009a)*. 009a capped zoom-out at the *fit* height: the
viewport that frames the whole level. That framing is necessarily larger than the level on at
least one axis, so the whole-map view always showed background around the map. The owner's rule
after seeing it is absolute — the background must never be visible — so the cap is now
`core/view/cover.ts`'s `maxSkyFreeViewHeight`: the largest viewport whose ground footprint still
lies entirely *inside* the level. Relief is charged against it, because extruded terrain projects
`h·cos(elevation)` up the screen and the far edge can be as low as the water/skirt floor, so a cap
derived from the flat footprint alone would show sky above tall terrain — at 55 degrees that term
is 0.57*h*, more than twice its cost at 75. The pan clamp is fed the same allowance
(`skyFreePanBounds` insets the far edge only), which is what makes the guarantee hold at every pan
position rather than only at the centre.

The consequence is deliberate and was accepted explicitly: **the whole map can no longer be seen
at once.** On level 1 (57×45) at 1920×1080 and 55 degrees the cap is a 31.6-unit viewport — 56.1
of the 57 tiles across and 38.6 of the 45 tiles of depth. `F` / `Home` therefore no longer mean
"fit the level" but "zoom out as far as is allowed", and the on-screen hint says so. `fitViewHeight`
remains in `core/view/zoom.ts` as the honest measure of the level's silhouette and the thing the
cap is defined against, but it no longer drives the limit. Where the two rules genuinely conflict —
a window so letterboxed that the sky-free cap is under ten world units — the no-sky rule outranks
the minimum-zoom preference.

**Voxel extrusion over rigged 3D models.** Rejected: sourcing and retargeting rigged humanoids
(Mixamo/Quaternius) — realistically a full day of the four, with a result that would not look
like the user's art. Voxel extrusion is automatable, uses the actual assets, and produces a
coherent style. Cost: no true skeletal animation; motion is frame-swapping plus procedural
secondary motion. Accepted, because at this camera's distance and angle the difference is small and the
schedule difference is not.

**Flow fields over A*.** Rejected A* for cost and testability. Cost: flow fields assume a
shared destination per group, which is a poorer fit for units with individually distinct goals.
For a squad game with a handful of objectives per level, that is the right trade. Mitigated by
caching a small number of concurrent fields.

**DOM overlay HUD over in-canvas UI.** Rejected in-canvas UI (troika-text, sprite-based
panels): slower to build, harder to style, worse text rendering. Cost: two rendering worlds to
keep visually consistent. Accepted for build speed and polish-per-hour on the campaign screens
— the Menu, the mission card and Boot Hill — especially.

**Offline pipelines over runtime import.** Rejected runtime image parsing: slow load, untestable,
impossible to hand-tune. Cost: a build step and committed generated artifacts. Accepted —
committed artifacts also mean the deploy never depends on the toolchain.

**Three.js over Phaser.** Phaser would be the shortest path to *a* playable game, but the brief
explicitly rewards technical stretch and graphics, and the brief's lit, tilted battlefield is
natively 3D.
Cost: more lighting, camera and asset work. The `core/` boundary limits the blast radius, since
the majority of gameplay code is renderer-agnostic either way.

**Fixed timestep over variable delta.** Variable delta is fewer lines. Fixed timestep buys
deterministic, reproducible tests and keeps the multiplayer/replay extension points real.
Cost: interpolation logic in `EntityRenderer`. Worth it.

## Open questions

These do not block the architecture but widen the estimates on the tickets they touch:

1. **Source art form.** Sprite sheet layout, frame counts, directions per unit and background
   transparency are unknown until the assets land — this is the main uncertainty in the
   `voxelize` tickets (004, 005).
2. **Annotation convention.** Whether the map annotations are colour-coded pixels, an overlay
   layer, or written labels determines how much of `mapgen` can be automated versus assisted by
   a small manual legend file per level (ticket 002).
3. **Terrain from map images.** Whether walkability can be derived from the map image itself or
   needs a hand-painted mask per level (ticket 003).
