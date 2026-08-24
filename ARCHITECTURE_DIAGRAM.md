# Architecture Diagram — Game Week: Cannon Fodder Remake

Component names match `ARCHITECTURE.md` exactly.

## Component / interaction diagram

```mermaid
flowchart TD
  subgraph offline["tools/ — offline, build time only (Node)"]
    SRC[/"assets/source/<br/>annotated map images<br/>+ 2D sprite sheets"/]
    MAPGEN["mapgen"]
    VOX["voxelize"]
    PREV["preview harness"]
    GEN[/"public/generated/<br/>level.json ×5<br/>GLB frames + models.manifest.json"/]
    SRC --> MAPGEN --> GEN
    SRC --> VOX --> GEN
    MAPGEN -.-> PREV
    VOX -.-> PREV
  end

  subgraph app["app/ — shell"]
    LOOP["GameLoop<br/>fixed 60Hz + interpolation"]
    SM["StateMachine<br/>Menu→Recruit→Brief→Mission→Debrief→BootHill"]
    LS["localStorage adapter"]
  end

  subgraph inputui["input/ + ui/ — DOM"]
    PC["PointerController"]
    HUD["HUD"]
    RS["RecruitmentScreen"]
    BH["BootHill"]
    BD["Briefing / Debrief"]
  end

  subgraph core["core/ — engine-free simulation (no three.js, no DOM)"]
    LSCH["LevelSchema"]
    CQ["CommandQueue"]
    W["World"]
    SQ["SquadSystem"]
    PATH["PathingSystem<br/>flow fields"]
    CS["CombatSystem"]
    OS["OrdnanceSystem"]
    AI["AISystem"]
    OBJ["ObjectiveSystem"]
    CAMP["Campaign"]
    PP["PersistencePort"]
    EV["SimEvent bus"]
    LSCH --> W
    CQ --> W
    W --> SQ & PATH & CS & OS & AI & OBJ
    SQ & PATH & CS & OS & AI & OBJ --> W
    W --> EV
    EV --> CAMP
    CAMP --> PP
  end

  subgraph render["render/ — three.js presentation (read-only on World)"]
    SB["SceneBuilder"]
    TR["TerrainRenderer"]
    ER["EntityRenderer"]
    UV["UnitVisual<br/>(voxel mesh | billboard fallback)"]
    CR["CameraRig<br/>ortho isometric"]
    FX["FXSystem"]
    PFX["PostFX<br/>bloom / SSAO / tilt-shift"]
    SB --> TR & CR
    ER --> UV
    SB --> PFX
  end

  AB["audio/ AudioBus"]

  GEN --> LSCH
  GEN --> UV
  PC --> CQ
  HUD --> CQ
  LOOP --> W
  LOOP --> ER
  SM --> LOOP
  SM --> RS & BD & BH
  W -. read-only state .-> ER
  W -. read-only state .-> HUD
  EV --> FX
  EV --> AB
  EV --> HUD
  EV --> SM
  CAMP --> RS & BH
  PP --> LS
  ER --> PFX
  TR --> PFX
  FX --> PFX
  CR --> PFX
  PFX --> CANVAS[["WebGL canvas"]]

  classDef pure fill:#e8f4ea,stroke:#3a7d44,color:#14321c
  classDef gpu fill:#e9eef8,stroke:#3c5a99,color:#16233f
  classDef tool fill:#fbf0e0,stroke:#a8762c,color:#3f2d10
  class LSCH,CQ,W,SQ,PATH,CS,OS,AI,OBJ,CAMP,PP,EV pure
  class SB,TR,ER,UV,CR,FX,PFX gpu
  class MAPGEN,VOX,PREV tool
```

Green = pure, unit-tested logic. Blue = rendering (untested by design). Amber = offline tooling.

## Data flow

```mermaid
flowchart LR
  A[/"annotated map image<br/>+ legend file"/] -->|npm run import:levels| B["mapgen"]
  B --> C[/"level.json<br/>terrain • walkable •<br/>avatars • enemies • chests •<br/>objectives"/]
  D[/"2D sprite sheet"/] -->|npm run build:models| E["voxelize<br/>quantise → extrude → greedy mesh"]
  E --> F[/"GLB per frame +<br/>models.manifest.json"/]

  C -->|validate| G["LevelData"]
  G --> H["World<br/>(battle state)"]
  F --> I["UnitVisual"]

  J["pointer / HUD"] -->|Command| K["CommandQueue"] --> H
  H -->|"continuous state<br/>(positions, health)"| L["EntityRenderer"] --> M[["canvas"]]
  H -->|"discrete SimEvents<br/>(ShotFired, UnitDied,<br/>Explosion, ChestCollected)"| N["FXSystem"] --> M
  H --> O["AudioBus"]
  H --> P["HUD"]
  H -->|"MissionComplete / UnitDied"| Q["Campaign"]
  Q -->|"at mission boundary"| R[("localStorage")]
  Q --> S["RecruitmentScreen / BootHill"]
```

## Mission tick — sequence

```mermaid
sequenceDiagram
  participant U as Player
  participant PC as PointerController
  participant CQ as CommandQueue
  participant W as World (60Hz tick)
  participant SYS as Systems
  participant EV as SimEvent bus
  participant R as EntityRenderer / FXSystem / AudioBus

  U->>PC: click ground / click enemy / select rocket
  PC->>CQ: Command{move | fire, ordnance, target}
  loop every fixed 16.67ms
    W->>CQ: drain commands
    W->>SYS: SquadSystem → PathingSystem → AISystem
    SYS-->>W: move intents, enemy commands
    W->>SYS: OrdnanceSystem → CombatSystem → ObjectiveSystem
    SYS-->>W: damage, deaths, projectile spawns
    W->>EV: emit ordered SimEvent[]
    EV->>R: ShotFired / Explosion / UnitDied / MissionComplete
  end
  loop every display frame
    R->>W: read interpolated positions & health
    R->>R: update InstancedMesh batches, particles, camera shake
  end
```

## Campaign / screen state machine

```mermaid
stateDiagram-v2
  [*] --> Menu
  Menu --> Recruitment: new / continue campaign
  Recruitment --> Briefing: squad assigned
  Briefing --> Mission: deploy
  Mission --> Debrief: MissionComplete
  Mission --> Debrief: MissionFailed
  Debrief --> BootHill: casualties recorded
  BootHill --> Recruitment: next level
  BootHill --> Menu: campaign complete
  Menu --> Mission: ?demo=1&level=N (demo shortcut)
```

## Build & deploy boundary

```mermaid
flowchart TD
  subgraph committed["committed to repo"]
    S1[/"assets/source/ — never shipped"/]
    S2[/"public/generated/ — level.json + GLB"/]
    S3["src/ (core, render, ui, input, audio, app)"]
    S4["tools/ (mapgen, voxelize, preview)"]
  end
  S1 -.->|"manual, on asset change:<br/>npm run import:levels / build:models"| S2
  S2 --> V["vite build"]
  S3 --> V
  V --> D[["static bundle → public URL"]]
  S4 -.->|"not bundled"| V
  T["vitest — core/ + tools/ only"] -.->|"gates every ticket"| S3
  T -.-> S4
```
