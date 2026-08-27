import { describe, it, expect } from 'vitest'
import { createCampaignRunner, EVENTS, SCREENS, SCREEN_VIEWS, viewFor } from '../index'
import type { CampaignRunner, MissionHost, RunnerOptions } from '../index'
import {
  CAMPAIGN_SCHEMA_VERSION,
  createCampaign,
  recruitsAvailable,
  saveCampaign,
} from '../../campaign'
import type { CampaignState, PersistencePort, SquadMember } from '../../campaign'
import type { LevelData } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 022a — the piece that makes the campaign reachable.
 *
 * FOUR TICKETS BUILT A CAMPAIGN NOTHING IMPORTS. `core/campaign`, `core/flow`,
 * `ui/boot-hill.ts` and `app/local-storage-port.ts` are complete, tested and
 * unreachable — the bundle has been byte-identical for four tickets precisely
 * because Rollup can prove no line of them runs. The runner is the owner they
 * were all missing: one screen, one campaign, one squad, one mission.
 *
 * WHY THE HARD PART IS TESTABLE AT ALL. Wiring is `main.ts`, a `WebGLRenderer`
 * and four `div`s, none of which Vitest can see. So the two things that cannot
 * be tested are pushed behind ports — `MissionHost` for the browser's mission,
 * `PersistencePort` for the browser's store — and a fake that records its calls
 * turns "deploying twice must not leak a scene" from a claim into an assertion.
 * This is the same move ticket 019 made for storage and 020 made for screens,
 * applied to the last untested seam in the milestone.
 *
 * THE INVARIANT EVERY TEST BELOW CIRCLES: a command the chart refuses must
 * change NOTHING. Not the screen, not the campaign, not the squad, not the
 * store, and above all not the host. `advance` returns a reason rather than
 * throwing because a double-clicked button is ordinary traffic; a runner that
 * called `host.start` before asking would leak an entire Three.js scene on the
 * second click, and the teardown that followed would release only the second
 * one's handles.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A level with `avatars` landing positions, which IS the squad cap —
 * `maxSquadFor` reads `spawns.avatars.length` and ticket 021 refuses both over-
 * and under-selection against it.
 */
function makeLevel(name: string, avatars: number): LevelData {
  const w = 20
  const h = 12
  const terrain = Array.from({ length: h }, () => Array.from({ length: w }, () => 1))
  const walkable = Array.from({ length: h }, () => Array.from({ length: w }, () => true))
  return {
    schemaVersion: 2,
    name,
    size: { w, h },
    terrain,
    walkable,
    walkableSource: 'mask',
    spawns: {
      avatars: Array.from({ length: avatars }, (_, i) => ({ x: 2 + i, y: 6, type: 'rifleman' })),
      enemies: [{ x: 16, y: 6, type: 'rifleman' }],
      props: [],
      chests: [],
    },
    objectives: [{ type: 'kill_all' }],
  }
}

/** One call the shell made into the browser's half of a mission. */
type HostCall =
  | { readonly kind: 'start'; readonly level: string; readonly squad: readonly string[] }
  | { readonly kind: 'teardown' }

interface FakeHost extends MissionHost {
  readonly calls: readonly HostCall[]
  starts(): number
  teardowns(): number
}

function fakeHost(): FakeHost {
  const calls: HostCall[] = []
  return {
    calls,
    start(level: LevelData, squad: readonly SquadMember[]): void {
      calls.push({ kind: 'start', level: level.name, squad: squad.map((m) => m.id) })
    },
    teardown(): void {
      calls.push({ kind: 'teardown' })
    },
    starts: () => calls.filter((c) => c.kind === 'start').length,
    teardowns: () => calls.filter((c) => c.kind === 'teardown').length,
  }
}

interface FakePort extends PersistencePort {
  writes(): number
  last(): unknown
  fail(on: boolean): void
}

/** A store that starts empty and records what it was handed. */
function fakePort(initial: unknown = null): FakePort {
  let held: unknown = initial
  let writes = 0
  let failing = false
  return {
    load: () => held,
    save(state: unknown): void {
      if (failing) throw new Error('quota exceeded')
      writes += 1
      held = state
    },
    writes: () => writes,
    last: () => held,
    fail(on: boolean): void {
      failing = on
    },
  }
}

function runnerFor(
  levels: readonly LevelData[],
  overrides: Partial<RunnerOptions> = {},
): { runner: CampaignRunner; host: FakeHost; port: FakePort } {
  const host = (overrides.host as FakeHost | undefined) ?? fakeHost()
  const port = (overrides.port as FakePort | undefined) ?? fakePort()
  const runner = createCampaignRunner({ ...overrides, levels, host, port })
  return { runner, host, port }
}

const ONE_LEVEL = [makeLevel('Jungle Approach', 3)]
const THREE_LEVELS = [
  makeLevel('Jungle Approach', 3),
  makeLevel('The Ridge', 3),
  makeLevel('Command Post', 3),
]

/** The ids the Recruitment screen would offer, in the order it lists them. */
const offered = (runner: CampaignRunner, n: number): readonly string[] =>
  runner.recruitment().available.slice(0, n).map((m) => m.id)

/**
 * A mission's event stream: `who` are the entity ids that died, and the mission
 * ends the way `outcome` says.
 *
 * `missionReport` reads the WHOLE stream, which is why 022a has `main.ts`
 * accumulate it: the render loop drains `session.events()` every frame for
 * tracers and throws the batch away, so without a log the campaign never learns
 * who died.
 */
function missionEvents(who: readonly number[], outcome: 'complete' | 'failed'): readonly SimEvent[] {
  const events: SimEvent[] = who.map((id, i) => ({
    type: 'UnitDied',
    id,
    team: 'player',
    killerId: null,
    friendlyFire: false,
    tick: i + 1,
    seq: i + 1,
  }))
  if (outcome === 'complete') {
    // `objective` names the condition that finished it. Supplied because
    // `ObjectiveSystem` always supplies it and this fixture stands in for its
    // output — a fixture that omitted it would be arguing for a weaker
    // production type than the one the only real producer satisfies.
    events.push({ type: 'MissionComplete', objective: 'kill_all', tick: 100, seq: 100 })
  } else {
    events.push({ type: 'MissionFailed', reason: 'squad eliminated', tick: 100, seq: 100 })
  }
  return events
}

/** Entity ids paired to the squad the way `Session.assignment` pairs them. */
const assignmentFor = (squad: readonly SquadMember[]): ReadonlyMap<number, string> =>
  new Map(squad.map((m, i) => [i + 1, m.id]))

/** Walk Menu -> Mission the way a player does, and return what was deployed. */
function deploy(runner: CampaignRunner): readonly SquadMember[] {
  expect(runner.startCampaign().ok).toBe(true)
  expect(runner.assignSquad(offered(runner, runner.recruitment().maxSquad)).ok).toBe(true)
  expect(runner.deploy().ok).toBe(true)
  return runner.squad()
}

// ---------------------------------------------------------------------------

describe('the runner walks the chart', () => {
  it('opens on the Menu', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    expect(runner.screen()).toBe('Menu')
  })

  it('Menu -> Recruitment -> Briefing -> Mission -> Debrief -> BootHill -> Recruitment', () => {
    // The whole loop in one test, because the value of the runner is that the
    // path exists end to end — each step passing in isolation is what the four
    // previous tickets already had.
    const { runner } = runnerFor(THREE_LEVELS)
    const seen: string[] = [runner.screen()]

    expect(runner.startCampaign().ok).toBe(true)
    seen.push(runner.screen())
    expect(runner.assignSquad(offered(runner, 3)).ok).toBe(true)
    seen.push(runner.screen())
    expect(runner.deploy().ok).toBe(true)
    seen.push(runner.screen())

    const squad = runner.squad()
    expect(runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad)).ok).toBe(true)
    seen.push(runner.screen())
    expect(runner.recordCasualties().ok).toBe(true)
    seen.push(runner.screen())
    expect(runner.advanceFromBootHill().ok).toBe(true)
    seen.push(runner.screen())

    expect(seen).toEqual([
      'Menu',
      'Recruitment',
      'Briefing',
      'Mission',
      'Debrief',
      'BootHill',
      'Recruitment',
    ])
  })

  it('routes a lost mission to the Debrief too', () => {
    // `Mission -> Debrief` has two rows, and a runner that only handled the
    // winning one would strand the player on a mission he had already lost.
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    expect(runner.finishMission(missionEvents([], 'failed'), assignmentFor(squad)).ok).toBe(true)
    expect(runner.screen()).toBe('Debrief')
  })

  it('takes the outcome from the report, not from the caller', () => {
    /**
     * `missionReport` defaults to `failed` on a stream that never said the
     * mission was won — a crash, a truncation, a mission still running. Routing
     * the screen off the same value the roster is updated from is what stops a
     * Debrief reading "complete" over a campaign that recorded a loss.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission([], assignmentFor(squad))
    expect(runner.debrief()?.outcome).toBe('failed')
  })

  it('honours a deep link through resolveEntry, and refuses nonsense', () => {
    expect(runnerFor(ONE_LEVEL, { entry: 'Mission' }).runner.screen()).toBe('Mission')
    expect(runnerFor(ONE_LEVEL, { entry: 'Nowhere' }).runner.screen()).toBe('Menu')
    expect(runnerFor(ONE_LEVEL, { entry: 42 }).runner.screen()).toBe('Menu')
  })
})

describe('a refused command changes nothing at all', () => {
  /**
   * THE CENTRAL INVARIANT. Not "returns false" — CHANGES NOTHING. A runner that
   * refused after calling the host, or after recruiting the auto-fill, or after
   * writing the save, would pass a test that only read the return value.
   */

  it('every command illegal on the current screen is refused with a reason', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    // On the Menu, only `startCampaign` and `demoShortcut` have rows.
    const refusals = [
      runner.assignSquad([]),
      runner.deploy(),
      runner.finishMission([], new Map()),
      runner.recordCasualties(),
      runner.advanceFromBootHill(),
    ]
    for (const r of refusals) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
    }
    expect(runner.screen()).toBe('Menu')
  })

  it('and touches neither the host nor the store while refusing', () => {
    const { runner, host, port } = runnerFor(ONE_LEVEL)
    runner.deploy()
    runner.finishMission(missionEvents([1], 'complete'), new Map([[1, 'x']]))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect({ starts: host.starts(), teardowns: host.teardowns(), writes: port.writes() }).toEqual({
      starts: 0,
      teardowns: 0,
      writes: 0,
    })
  })

  it('and leaves the campaign byte-identical', () => {
    // A refused `finishMission` that had already applied its report would bury
    // men on a mission that never happened.
    const { runner } = runnerFor(ONE_LEVEL)
    const before = JSON.stringify(runner.campaign())
    runner.finishMission(missionEvents([1, 2], 'complete'), new Map([[1, 'a'], [2, 'b']]))
    runner.recordCasualties()
    expect(JSON.stringify(runner.campaign())).toBe(before)
  })

  it('a second deploy is refused and starts no second mission', () => {
    /**
     * THE ONE THAT COSTS A WHOLE SCENE. A double-clicked Deploy calling
     * `host.start` twice leaks every buffer, texture and geometry the first
     * mission allocated, and the teardown that eventually runs releases only the
     * second mission's handles. `Mission` has no `deploy` row precisely so the
     * chart can answer this without the shell needing a guard flag.
     */
    const { runner, host } = runnerFor(ONE_LEVEL)
    deploy(runner)
    const second = runner.deploy()
    expect(second.ok).toBe(false)
    expect(host.starts()).toBe(1)
    expect(host.teardowns()).toBe(0)
  })

  it('no command on any screen can reach a screen the chart does not name', () => {
    /**
     * The exhaustive sweep: every command on every screen, from a runner walked
     * into that screen, and the result is always one of the six. This is the
     * assertion that would catch a runner setting its screen from something
     * other than `advance`'s answer — a hand-written `this.screen = 'Debrief'`
     * on a branch the table disagrees with.
     */
    const reach = (target: string): CampaignRunner | null => {
      const { runner } = runnerFor(THREE_LEVELS)
      if (target === 'Menu') return runner
      runner.startCampaign()
      if (target === 'Recruitment') return runner
      runner.assignSquad(offered(runner, 3))
      if (target === 'Briefing') return runner
      runner.deploy()
      if (target === 'Mission') return runner
      runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
      if (target === 'Debrief') return runner
      runner.recordCasualties()
      if (target === 'BootHill') return runner
      return null
    }
    for (const screen of SCREENS) {
      const runner = reach(screen)
      expect({ screen, reached: runner?.screen() }).toEqual({ screen, reached: screen })
      if (runner === null) continue
      const commands = [
        () => runner.startCampaign(),
        () => runner.demoShortcut(0),
        () => runner.assignSquad([]),
        () => runner.deploy(),
        () => runner.finishMission([], new Map()),
        () => runner.recordCasualties(),
        () => runner.advanceFromBootHill(),
      ]
      for (const run of commands) {
        run()
        expect(SCREENS).toContain(runner.screen())
      }
    }
  })

  it('the runner has a command for every event in the chart', () => {
    /**
     * The other direction: an event with a row and no command is a transition
     * no player can ever take — a dead edge in the picture that reviews as
     * "already wired". Named explicitly rather than counted, so adding a row to
     * the chart without a command here fails HERE rather than in a playtest.
     */
    const covered: readonly string[] = [
      'startCampaign',
      'squadAssigned',
      'deploy',
      'missionComplete',
      'missionFailed',
      'casualtiesRecorded',
      'nextLevel',
      'campaignComplete',
      'demoShortcut',
    ]
    expect([...EVENTS].sort()).toEqual([...covered].sort())
  })
})

describe('deploying starts exactly one mission, with the right men on the right map', () => {
  it('hands the host the level the player is on and the squad he chose', () => {
    const { runner, host } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    expect(host.calls).toEqual([
      { kind: 'start', level: 'Jungle Approach', squad: squad.map((m) => m.id) },
    ])
  })

  it('the squad is the men that were chosen, in the order they were chosen', () => {
    // Ticket 021: the nth man stands on the nth avatar spawn, so an order the
    // runner reshuffled would put the veteran on a flank the player did not
    // pick — and nothing on screen would say so.
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const wanted = [...offered(runner, 3)].reverse()
    expect(runner.assignSquad(wanted).ok).toBe(true)
    expect(runner.squad().map((m) => m.id)).toEqual(wanted)
  })

  it('a later level is deployed once its predecessor is beaten', () => {
    const { runner, host } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.levelIndex()).toBe(1)
    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    const starts = host.calls.filter((c) => c.kind === 'start')
    expect(starts.map((c) => (c.kind === 'start' ? c.level : ''))).toEqual([
      'Jungle Approach',
      'The Ridge',
    ])
  })

  it('a lost mission does not advance the level', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'failed'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.levelIndex()).toBe(0)
  })

  it('never indexes past the last level it was given', () => {
    /**
     * `unlockedLevels` counts and has no idea how many levels exist: beat the
     * last one and it reads one past the end. Today that is level 1 of 1, which
     * is the exact case shipping now, and an unclamped index would hand the host
     * `undefined` and crash the boot.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.campaign().unlockedLevels).toBe(2)
    expect(runner.levelIndex()).toBe(0)
    expect(runner.level().name).toBe('Jungle Approach')
  })

  it('reports the mission against the level that was played, one-based', () => {
    // `unlockAfter` is 1-based — a fresh campaign has `unlockedLevels: 1` and
    // level 1 is index 0 — so an id off by one would unlock two levels for one
    // victory, or none.
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(runner.campaign().dead[0]?.diedOnLevel).toBe(1)
    expect(runner.campaign().unlockedLevels).toBe(2)
  })
})

describe('leaving a mission releases it, and entering one never does', () => {
  it('tears down exactly once when the mission ends', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    expect(host.teardowns()).toBe(0)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(host.teardowns()).toBe(1)
  })

  it('does not tear down again on the screens after it', () => {
    // `isMissionExit` is false for `Debrief -> BootHill`: a second teardown
    // would double-dispose GPU handles the first one already released.
    const { runner, host } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(host.teardowns()).toBe(1)
  })

  it('tears down on a lost mission as readily as a won one', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'failed'), assignmentFor(squad))
    expect(host.teardowns()).toBe(1)
  })

  it('never tears down on the way in', () => {
    /**
     * `isMissionExit` returns false for entering a mission deliberately: a
     * teardown there would dispose the level that was just built, and the
     * player would be looking at a black canvas one frame after Deploy.
     */
    const { runner, host } = runnerFor(ONE_LEVEL)
    deploy(runner)
    expect(host.teardowns()).toBe(0)
    const demo = runnerFor(ONE_LEVEL)
    demo.runner.demoShortcut(0)
    expect(demo.host.teardowns()).toBe(0)
    expect(demo.host.starts()).toBe(1)
  })

  it('a whole campaign tears down once per mission and no more', () => {
    // The counting version of the invariant: N missions, N teardowns. A leak
    // shows up as too few, a double-dispose as too many.
    const { runner, host } = runnerFor(THREE_LEVELS)
    for (let i = 0; i < 3; i += 1) {
      if (runner.screen() === 'Menu') runner.startCampaign()
      runner.assignSquad(offered(runner, 3))
      runner.deploy()
      runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
      runner.recordCasualties()
      runner.advanceFromBootHill()
    }
    expect({ starts: host.starts(), teardowns: host.teardowns() }).toEqual({
      starts: 3,
      teardowns: 3,
    })
  })
})

describe('assigning a squad', () => {
  it('refuses a short selection without advancing', () => {
    // Ticket 021 refuses under-selection when the roster is bigger than the
    // squad: a short squad leaves an authored spawn point empty.
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const result = runner.assignSquad(offered(runner, 1))
    expect(result.ok).toBe(false)
    expect(runner.screen()).toBe('Recruitment')
    expect(runner.squad()).toEqual([])
  })

  it('passes selectSquad`s own reason through rather than inventing one', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const dup = offered(runner, 1)[0] ?? ''
    const result = runner.assignSquad([dup, dup, dup])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(dup)
  })

  it('keeps the campaign that issued the auto-filled men', () => {
    /**
     * THE QUIET ONE. When the roster is no bigger than the squad, `selectSquad`
     * tops it up and returns a NEW campaign — and ticket 019's whole
     * name-uniqueness guarantee runs through `recruitsIssued`. A runner that
     * kept the squad and dropped the state would reissue the same names next
     * mission, and two gravestones on Boot Hill would read the same thing.
     */
    const wiped: CampaignState = { ...createCampaign({ seed: 3, recruits: 1 }) }
    const port = fakePort({ version: CAMPAIGN_SCHEMA_VERSION, ...wiped })
    const { runner } = runnerFor(ONE_LEVEL, { port })
    expect(runner.campaign().recruits).toHaveLength(1)
    runner.startCampaign()
    const survivor = offered(runner, 1)
    expect(runner.assignSquad(survivor).ok).toBe(true)
    expect(runner.campaign().recruits).toHaveLength(3)
    expect(runner.campaign().recruitsIssued).toBe(3)
    const names = new Set(runner.campaign().recruits.map((r) => r.name))
    expect(names.size).toBe(3)
  })

  it('the next mission`s squad REPLACES the last one rather than joining it', () => {
    /**
     * The second time round the loop is where this bites, and it is the only
     * place it can: assigning moves the player straight to Briefing, which has
     * no `squadAssigned` row, so two assigns in a row on one Recruitment screen
     * are impossible. A second campaign cycle is not — and by then `squad` is
     * still holding the men who fought the last mission.
     *
     * `squad = [...squad, ...selection.squad]` would hand the host six men for a
     * three-slot level, including one who is already dead. Stated on the LENGTH
     * as well as the contents, because a contents check alone passes on a squad
     * that merely starts with the right men.
     *
     * The first draft of this test asserted against a 1-of-3 first selection,
     * which `selectSquad` refuses outright — so `squad` was `[]` and there was
     * nothing to append to. It passed against the very mutant it names.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    const first = deploy(runner)
    expect(first).toHaveLength(3)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(first))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.screen()).toBe('Recruitment')

    const wanted = [...offered(runner, 3)].reverse()
    expect(runner.assignSquad(wanted).ok).toBe(true)
    expect(runner.squad()).toHaveLength(3)
    expect(runner.squad().map((m) => m.id)).toEqual(wanted)
    // And the man who fell on the first mission is not among them, which he
    // would be if the two selections had been concatenated.
    expect(runner.squad().some((m) => m.id === first[0]?.id)).toBe(false)
  })

  it('is refused from a screen with no row for it, with a selection that is otherwise valid', () => {
    /**
     * THE REFUSAL TEST THAT ACTUALLY TESTS THE REFUSAL. Handing `assignSquad` an
     * empty list from the wrong screen proves nothing: `selectSquad` refuses an
     * under-selection on its own merits, so a runner that never consulted the
     * chart at all would refuse it too and the assertion would be satisfied for
     * the wrong reason. The payload here is one the chart is the ONLY thing
     * standing in the way of.
     *
     * What it costs to get wrong: assigning mid-mission would burn
     * `recruitsIssued` on a campaign the chart says never assigned, and swap the
     * squad out from under a running host.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const valid = offered(runner, 3)
    runner.assignSquad(valid)
    runner.deploy()
    expect(runner.screen()).toBe('Mission')

    const issued = runner.campaign().recruitsIssued
    const held = runner.squad()
    const result = runner.assignSquad([...valid].reverse())
    expect(result.ok).toBe(false)
    expect(runner.screen()).toBe('Mission')
    expect(runner.squad()).toEqual(held)
    expect(runner.campaign().recruitsIssued).toBe(issued)
  })
})

describe('finishing a mission records it against the right men', () => {
  it('buries the man who died and nobody else', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    const assignment = assignmentFor(squad)
    // Entity 2 is the second man; `assignmentFor` pairs them the way
    // `Session.assignment` does.
    runner.finishMission(missionEvents([2], 'failed'), assignment)
    const dead = runner.campaign().dead
    expect(dead.map((d) => d.name)).toEqual([squad[1]?.name])
    expect(runner.campaign().recruits.some((r) => r.id === squad[1]?.id)).toBe(false)
  })

  it('applies the report on a LOST mission too', () => {
    /**
     * Permadeath cannot survive a retry that resurrects the men who died in the
     * failed attempt. `applyMissionReport` already handles both outcomes; the
     * failure mode here is a runner that only calls it on a victory.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'failed'), assignmentFor(squad))
    expect(runner.campaign().dead).toHaveLength(1)
  })

  it('preserves the campaign as it stood BEFORE the mission', () => {
    /**
     * THE ORDERING BUG THAT IS IMPOSSIBLE TO SEE. `debriefModel(before, report)`
     * and `promotionsBetween(before, after)` both need the PRE-application
     * state. A runner that overwrote it before building them would show a
     * Debrief in which nobody died — because the dead are off the roster by
     * then — and a Boot Hill in which nobody was promoted, with no error
     * anywhere and every other test still green.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    const debrief = runner.debrief()
    expect(debrief?.casualties.map((c) => c.name)).toEqual([squad[0]?.name])
    expect(debrief?.survivors.map((s) => s.name).sort()).toEqual(
      [squad[1]?.name, squad[2]?.name].sort(),
    )
  })

  it('and that same before-state makes the promotions right', () => {
    /**
     * TWO victories, not one, because the ladder's second rung is at 2 survived
     * missions — after a single win every man is still a Private and a
     * promotion list that was always empty would satisfy any assertion about
     * its contents. This is the shape of two tests earlier in this milestone
     * that turned out to be structurally incapable of failing.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    const first = deploy(runner)
    expect(first.every((m) => m.rank === 'Private')).toBe(true)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(first))
    runner.recordCasualties()
    expect(runner.bootHill().promotions).toEqual([])
    runner.advanceFromBootHill()

    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    const second = runner.squad()
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(second))
    runner.recordCasualties()

    const hill = runner.bootHill()
    expect(hill.promotions).toHaveLength(3)
    const ranks = new Map(recruitsAvailable(runner.campaign()).map((m) => [m.name, m.rank]))
    for (const p of hill.promotions) {
      expect(p).toMatchObject({ from: 'Private', to: 'Corporal' })
      expect(ranks.get(p.name)).toBe('Corporal')
    }
  })

  it('a man who fell on the mission that would have promoted him is not promoted', () => {
    /**
     * A posthumous promotion on the same screen as the gravestone reads as a
     * bug, and `applyMissionReport` does not credit a dead man the mission he
     * did not survive. Checked through the runner because the runner is what
     * chooses the two states `promotionsBetween` compares — get those wrong and
     * this is the assertion that notices.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    const first = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(first))
    runner.recordCasualties()
    runner.advanceFromBootHill()

    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    const second = runner.squad()
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(second))
    runner.recordCasualties()

    const hill = runner.bootHill()
    const promoted = new Set(hill.promotions.map((p) => p.name))
    expect(promoted.has(second[0]?.name ?? '')).toBe(false)
    expect(hill.fallenThisMission.map((g) => g.name)).toEqual([second[0]?.name])
    // The two survivors still earn theirs, so this is not passing merely
    // because nobody was promoted at all.
    expect(hill.promotions).toHaveLength(2)
  })

  it('marks only this mission`s casualties as fresh on the hill', () => {
    /**
     * `bootHillModel(state, promotions, previous)` takes the same before-state
     * as its third argument, and that is what makes `fallenThisMission` exact
     * rather than inferred from the level number — which would be wrong the
     * moment a player replayed a level.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    const first = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(first))
    runner.recordCasualties()
    expect(runner.bootHill().fallenThisMission.map((g) => g.name)).toEqual([first[0]?.name])
    runner.advanceFromBootHill()

    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    const second = runner.squad()
    runner.finishMission(missionEvents([2], 'complete'), assignmentFor(second))
    runner.recordCasualties()
    const hill = runner.bootHill()
    expect(hill.graves).toHaveLength(2)
    expect(hill.fallenThisMission.map((g) => g.name)).toEqual([second[1]?.name])
  })

  it('the hill grows across the campaign and keeps its oldest stone', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const names: string[] = []
    for (let i = 0; i < 3; i += 1) {
      if (runner.screen() === 'Menu') runner.startCampaign()
      runner.assignSquad(offered(runner, 3))
      runner.deploy()
      const squad = runner.squad()
      names.push(squad[0]?.name ?? '')
      runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
      runner.recordCasualties()
      runner.advanceFromBootHill()
    }
    expect(runner.bootHill().graves.map((g) => g.name)).toEqual(names)
  })

  it('the debrief is null until a mission has been played', () => {
    // A screen that has nothing to say must say so, rather than being handed a
    // model built from an empty report that reads as a lost mission.
    const { runner } = runnerFor(ONE_LEVEL)
    expect(runner.debrief()).toBeNull()
  })
})

describe('the campaign is loaded once and saved when it changes', () => {
  it('loads at construction', () => {
    const saved = createCampaign({ seed: 42, recruits: 5 })
    const port = fakePort({ version: CAMPAIGN_SCHEMA_VERSION, ...saved })
    const { runner } = runnerFor(ONE_LEVEL, { port })
    expect(runner.campaign().seed).toBe(42)
    expect(runner.campaign().recruits).toHaveLength(5)
  })

  it('starts a fresh campaign on an empty store, with no notice', () => {
    // An empty store is a first run, not a failure, and does not deserve a
    // warning on the Menu.
    const { runner } = runnerFor(ONE_LEVEL)
    expect(runner.notice()).toBeNull()
    expect(runner.campaign().recruits.length).toBeGreaterThan(0)
  })

  it('reports a damaged save and starts anyway', () => {
    /**
     * Silently starting fresh over somebody's twelve dead soldiers is the worst
     * outcome available here — worse than refusing to start, because they will
     * not find out until they go looking for men who no longer exist.
     */
    const { runner } = runnerFor(ONE_LEVEL, { port: fakePort('{not json') })
    expect(runner.notice()).not.toBeNull()
    expect(runner.screen()).toBe('Menu')
  })

  it('reports a store that will not even open', () => {
    // Private browsing throws on the ACCESS itself. A game that will not start
    // in a private window is a bug report nobody can reproduce.
    const port: PersistencePort = {
      load(): unknown {
        throw new Error('access denied')
      },
      save(): void {},
    }
    const { runner } = runnerFor(ONE_LEVEL, { port })
    expect(runner.notice()).not.toBeNull()
    expect(runner.campaign().recruits.length).toBeGreaterThan(0)
  })

  it('survives a save whose progress is a fraction', () => {
    /**
     * `parseState` rejects `unlockedLevels < 1` and DELIBERATELY accepts any
     * finite value at or above it — so `1.5` loads clean, with no notice. An
     * index derived from it without flooring is `0.5`, `levels[0.5]` is
     * `undefined`, and the game dies on boot inside the first Recruitment draw,
     * on a line whose own comment calls itself unreachable.
     *
     * A save file is a string on somebody's disk. It does not have to be a
     * plausible one to have to not crash.
     */
    const base = createCampaign({ seed: 8, recruits: 6 })
    const port = fakePort({ version: CAMPAIGN_SCHEMA_VERSION, ...base, unlockedLevels: 1.5 })
    const { runner } = runnerFor(THREE_LEVELS, { port })
    expect(runner.levelIndex()).toBe(0)
    expect(() => runner.level()).not.toThrow()
    expect(() => runner.recruitment()).not.toThrow()
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.assignSquad(offered(runner, 3)).ok).toBe(true)
  })

  it('writes the campaign when a mission ends', () => {
    const { runner, port } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(port.writes()).toBeGreaterThan(0)
    const written = port.last()
    expect(written).toMatchObject({ version: CAMPAIGN_SCHEMA_VERSION })
  })

  it('and what it wrote loads back as the campaign it holds', () => {
    /**
     * The round trip, which is the only thing that proves the save is USEFUL
     * rather than merely written. A field that failed JSON would not fail on
     * the way out; it would come back missing, which is a campaign that quietly
     * lost a man.
     */
    const { runner, port } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    const reloaded = runnerFor(ONE_LEVEL, { port: fakePort(port.last()) })
    expect(reloaded.runner.notice()).toBeNull()
    expect(reloaded.runner.campaign()).toEqual(runner.campaign())
    expect(reloaded.runner.campaign().dead.map((d) => d.name)).toEqual([squad[0]?.name])
  })

  it('a failed write is noticed but never blocks the flow', () => {
    /**
     * Losing the save is bad; losing the mission the player just spent ten
     * minutes on is worse. `SaveResult` was shaped for exactly this bargain —
     * report, do not throw, do not stop.
     */
    const { runner, port } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    port.fail(true)
    const result = runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(result.ok).toBe(true)
    expect(runner.screen()).toBe('Debrief')
    expect(runner.notice()).not.toBeNull()
    // And the campaign in memory still records the man who died, so the Debrief
    // and Boot Hill in front of the player are correct even though the disk is
    // not.
    expect(runner.campaign().dead).toHaveLength(1)
  })

  it('a save that starts working again clears the notice', () => {
    // A notice that never cleared would sit over the rest of the campaign
    // claiming progress is being lost after it has stopped being true.
    const { runner, port } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    port.fail(true)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.notice()).not.toBeNull()
    port.fail(false)
    runner.recordCasualties()
    runner.advanceFromBootHill()
    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
    expect(runner.notice()).toBeNull()
  })
})

describe('the end of the campaign', () => {
  it('returns to the Menu after the last level, not to Recruitment', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.screen()).toBe('Menu')
  })

  it('does not end early on a level that is merely the last one unlocked', () => {
    /**
     * `campaignComplete` uses `>` and not `>=` for a reason ticket 020 measured:
     * beating level 4 of 5 leaves `unlockedLevels` at 5, and `>=` would end the
     * campaign before the final mission with every test still green.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    for (let i = 0; i < 2; i += 1) {
      if (runner.screen() === 'Menu') runner.startCampaign()
      runner.assignSquad(offered(runner, 3))
      runner.deploy()
      runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
      runner.recordCasualties()
      runner.advanceFromBootHill()
      expect(runner.screen()).toBe('Recruitment')
    }
    expect(runner.campaign().unlockedLevels).toBe(3)
    expect(runner.levelIndex()).toBe(2)
  })

  it('a lost last mission sends the player back to try again', () => {
    // `Recruitment`, not `Menu`: losing must not end the campaign.
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'failed'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.screen()).toBe('Recruitment')
  })

  it('and a campaign restarted from the Menu keeps its dead', () => {
    /**
     * `startCampaign` on a finished campaign is a REPLAY, not a wipe. Clearing
     * the save is ticket 024's, gated on an explicit confirmation — and doing it
     * here by accident would delete Boot Hill, which is the one screen the
     * campaign exists to fill.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.screen()).toBe('Menu')
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.campaign().dead).toHaveLength(1)
  })
})

describe('the models the shell draws come from core, unchanged', () => {
  it('the briefing names the level and the men going to it', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const wanted = offered(runner, 3)
    runner.assignSquad(wanted)
    const briefing = runner.briefing()
    expect(briefing.levelName).toBe('Jungle Approach')
    expect(briefing.squad.map((s) => s.id)).toEqual(wanted)
    expect(briefing.objectives).toEqual(['kill_all'])
  })

  it('and lists the men in the order the player picked them, not the roster`s', () => {
    /**
     * The Briefing is where the player confirms the placement he chose, and
     * ticket 021's contract is that the nth man takes the nth avatar spawn. A
     * briefing that showed roster order would disagree with the ground he is
     * about to land on — and every existing order assertion reads
     * `runner.squad()` rather than the model, so nothing would say so.
     *
     * REVERSED, because a selection taken in roster order cannot tell the two
     * apart. This is the same class of fixture-on-a-convenient-value that has
     * hidden three defects in this milestone.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    const wanted = [...offered(runner, 3)].reverse()
    runner.assignSquad(wanted)
    expect(runner.briefing().squad.map((s) => s.id)).toEqual(wanted)
  })

  it('the recruitment model caps the squad at the level`s landing positions', () => {
    const { runner } = runnerFor([makeLevel('Two Slots', 2)])
    runner.startCampaign()
    expect(runner.recruitment().maxSquad).toBe(2)
  })

  it('and reports how many men auto-fill would assign for a given selection', () => {
    // Ticket 022's `autoFilled` exists so the Deploy button can say so. The
    // runner has to pass the current selection through or the number is always
    // the one for an empty list.
    const wiped = createCampaign({ seed: 3, recruits: 2 })
    const port = fakePort({ version: CAMPAIGN_SCHEMA_VERSION, ...wiped })
    const { runner } = runnerFor([makeLevel('Two Slots', 2)], { port })
    runner.startCampaign()
    const one = offered(runner, 1)
    expect(runner.recruitment(one).autoFilled).toBe(1)
    expect(runner.recruitment(offered(runner, 2)).autoFilled).toBe(0)
  })

  it('dead men never appear on the recruitment list again', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    const ids = new Set(runner.recruitment().available.map((m) => m.id))
    expect(ids.has(squad[0]?.id ?? '')).toBe(false)
  })

  it('every model is a fresh value, not a window into the campaign', () => {
    /**
     * The screens are DOM and there is no way to test what they do with what
     * they are handed, so the guarantee has to be structural: a model the
     * screen could mutate into the campaign is a permadeath bug one careless
     * `push` away.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    const a = runner.bootHill()
    const b = runner.bootHill()
    expect(a).not.toBe(b)
    expect(a.graves).not.toBe(b.graves)
    expect(a).toEqual(b)
    expect(runner.squad()).not.toBe(runner.squad())
  })
})

describe('the demo shortcut', () => {
  it('goes straight from the Menu to a mission on the level it names', () => {
    // The row in the chart that looks like a mistake in the picture, which is
    // exactly why it is written down in both places. Ticket 029's deep link
    // feeds it, and ticket 022a's shell uses it as its temporary entry.
    const { runner, host } = runnerFor(THREE_LEVELS)
    expect(runner.demoShortcut(1).ok).toBe(true)
    expect(runner.screen()).toBe('Mission')
    expect(host.calls).toEqual([{ kind: 'start', level: 'The Ridge', squad: expect.any(Array) }])
  })

  it('fields a full squad even though nobody picked one', () => {
    // A mission started with no men is a mission that cannot be played, and a
    // deep link is a URL a stranger can type.
    const { runner } = runnerFor(THREE_LEVELS)
    runner.demoShortcut(0)
    expect(runner.squad()).toHaveLength(3)
  })

  it('refuses a level index that is not there, and starts nothing', () => {
    /**
     * `?demo=1&level=99` is one keystroke away from `&level=9`. Honouring it
     * would hand the host `undefined` and take the game down on boot — the same
     * argument `resolveEntry` makes about an unknown screen, arriving through
     * the other half of the same URL.
     */
    const { runner, host } = runnerFor(THREE_LEVELS)
    for (const bad of [-1, 3, 99, 1.5, NaN, Infinity]) {
      const result = runner.demoShortcut(bad)
      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
    }
    expect(host.starts()).toBe(0)
    expect(runner.screen()).toBe('Menu')
  })

  it('is refused off the Menu, and starts nothing, on an index that is perfectly valid', () => {
    /**
     * The same argument as `assignSquad`'s: a bad index is refused by the bounds
     * check whether or not the chart was ever asked, so only a GOOD index from a
     * screen with no `demoShortcut` row can prove the chart is consulted first.
     *
     * With that check skipped, a deep link fired mid-mission returns a refusal
     * AND builds a second Three.js scene — the leak this whole ticket is
     * arranged to prevent, arriving through the one command that does the most
     * work before it settles.
     */
    const { runner, host } = runnerFor(THREE_LEVELS)
    deploy(runner)
    expect(runner.screen()).toBe('Mission')
    const issued = runner.campaign().recruitsIssued
    const held = runner.squad()

    const result = runner.demoShortcut(2)
    expect(result.ok).toBe(false)
    expect(host.starts()).toBe(1)
    expect(runner.screen()).toBe('Mission')
    expect(runner.squad()).toEqual(held)
    expect(runner.campaign().recruitsIssued).toBe(issued)
  })

  it('buries a demo mission`s dead under the level it was played on', () => {
    /**
     * `demoShortcut(1)` on a fresh campaign is the one case where the level the
     * MISSION is on and the level the PLAYER is up to disagree: `levelIndex()`
     * is 0 and the mission is level 2. A report that took the campaign's
     * progress instead would carve the wrong place on the gravestone and unlock
     * the level the player just finished.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    expect(runner.levelIndex()).toBe(0)
    runner.demoShortcut(1)
    const squad = runner.squad()
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(runner.campaign().dead[0]?.diedOnLevel).toBe(2)
    expect(runner.campaign().unlockedLevels).toBe(3)
  })

  it('a demo mission still finishes into the campaign', () => {
    // It bypasses Recruitment and Briefing, not the roster. A demo run that
    // recorded nothing would be a way to lose men with no gravestone.
    const { runner } = runnerFor(THREE_LEVELS)
    runner.demoShortcut(0)
    const squad = runner.squad()
    expect(runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad)).ok).toBe(true)
    expect(runner.campaign().dead.map((d) => d.name)).toEqual([squad[0]?.name])
  })
})

describe('the runner is a value the shell can trust', () => {
  it('two runners over the same saved campaign agree on everything', () => {
    // Determinism across a reload: the campaign is seeded and the models are
    // pure, so a reloaded game must be the same game.
    const base = createCampaign({ seed: 11, recruits: 6 })
    const doc = { version: CAMPAIGN_SCHEMA_VERSION, ...base }
    const a = runnerFor(THREE_LEVELS, { port: fakePort(doc) }).runner
    const b = runnerFor(THREE_LEVELS, { port: fakePort(doc) }).runner
    a.startCampaign()
    b.startCampaign()
    expect(a.recruitment()).toEqual(b.recruitment())
    const ids = offered(a, 3)
    a.assignSquad(ids)
    b.assignSquad(ids)
    expect(a.squad()).toEqual(b.squad())
    expect(a.briefing()).toEqual(b.briefing())
  })

  it('saveCampaign`s own document is what the runner accepts', () => {
    /**
     * The contract test for the one wire this ticket crosses: the runner writes
     * through `saveCampaign` and reads through `loadCampaign`, and a runner that
     * hand-rolled either shape would round-trip perfectly against its own
     * assumption while disagreeing with the module that owns the format.
     * Written by the REAL producer, read by the REAL runner.
     */
    const state = createCampaign({ seed: 77, recruits: 4 })
    const port = fakePort()
    expect(saveCampaign(port, state).saved).toBe(true)
    const { runner } = runnerFor(ONE_LEVEL, { port: fakePort(port.last()) })
    expect(runner.notice()).toBeNull()
    expect(runner.campaign()).toEqual(state)
  })
})

describe('the router can always draw what the runner reports (ticket 022b)', () => {
  /**
   * THE CONTRACT BETWEEN THE TWO HALVES, from the side that can be tested. The
   * router itself is `main.ts` and four `div`s and no test will ever see it; what
   * IS checkable is that the runner never reports a state the router has no
   * answer for. A screen with no view is a black page over a running mission with
   * no button to press, and the only way out is a reload.
   */

  it('every screen a full campaign passes through has a view', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const seen = new Set<string>()
    const note = (): void => {
      seen.add(runner.screen())
      // `undefined` would pass a truthiness check as "no overlay" and strip the
      // panel off a screen the game is not on. `null` is the only legal absence.
      const view = viewFor(runner.screen())
      expect({ screen: runner.screen(), ok: view === null || typeof view === 'string' }).toEqual({
        screen: runner.screen(),
        ok: true,
      })
    }
    note()
    for (let i = 0; i < 3; i += 1) {
      if (runner.screen() === 'Menu') runner.startCampaign()
      note()
      runner.assignSquad(offered(runner, 3))
      note()
      runner.deploy()
      note()
      runner.finishMission(missionEvents([1], 'complete'), assignmentFor(runner.squad()))
      note()
      runner.recordCasualties()
      note()
      runner.advanceFromBootHill()
      note()
    }
    // Not merely "nothing broke": the walk must actually have covered the chart,
    // or every assertion above was made about three screens.
    expect([...seen].sort()).toEqual([...SCREENS].sort())
  })

  it('a refused command leaves the reported screen, and so the mounted view, alone', () => {
    /**
     * The router reconciles from `runner.screen()` AFTER each command rather than
     * mounting what the handler expected. This is the property that makes that
     * safe: a refusal is a no-op to the router, so a double-clicked button
     * redraws nothing instead of tearing down the screen it is on.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    runner.startCampaign()
    const before = runner.screen()
    const view = viewFor(before)
    runner.deploy()
    runner.finishMission([], new Map())
    runner.recordCasualties()
    runner.advanceFromBootHill()
    expect(runner.screen()).toBe(before)
    expect(viewFor(runner.screen())).toBe(view)
  })

  it('the mission is the only state that shows the game', () => {
    // The runner's side of "exactly one screen mounts no overlay": the only way
    // to reach a state with no panel is to be in a mission.
    const { runner } = runnerFor(THREE_LEVELS)
    deploy(runner)
    expect(viewFor(runner.screen())).toBeNull()
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
    expect(viewFor(runner.screen())).toBe(SCREEN_VIEWS.Debrief)
    expect(viewFor(runner.screen())).not.toBeNull()
  })
})

describe('starting again WIPES, and only when asked in so many words (ticket 024)', () => {
  /**
   * `runner.ts` says twice that this belongs to ticket 024, and says why:
   * `startCampaign` is a REPLAY, not a wipe, because doing it by accident would
   * delete Boot Hill — the one screen the campaign exists to fill.
   *
   * So there are TWO VERBS, and that is the whole design. A player who meant
   * "play again" must not be able to reach "delete twelve gravestones" by
   * pressing the same button. The confirmation itself is the Menu's and is DOM,
   * so it is untested by construction; what IS testable, and is asserted here,
   * is that nothing else in the runner ever clears the save.
   */

  /**
   * A campaign that has been PLAYED TO THE END: its one level beaten, one man
   * buried, and the runner back on the Menu with a finished campaign behind it.
   *
   * `ONE_LEVEL`, NOT `THREE_LEVELS`, and the first draft got this wrong in a way
   * worth recording. It used three levels, played ONE mission, and called the
   * result "two levels beaten" in its own docstring. So `campaignComplete(2, 3)`
   * was false, `advanceFromBootHill` fired `nextLevel`, and the runner ended on
   * RECRUITMENT — where the chart correctly refuses `startCampaign`, there being
   * exactly one `startCampaign` row and it starting at the Menu. A test about
   * "a finished campaign" was asserting against an unfinished one.
   */
  function played(): { runner: CampaignRunner; port: FakePort; deadName: string } {
    const { runner, port } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    runner.assignSquad(offered(runner, 3))
    runner.deploy()
    const squad = runner.squad()
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    runner.recordCasualties()
    runner.advanceFromBootHill()
    // The precondition every case in this block rests on: the campaign really is
    // over, and the runner really is where a player would be looking at it.
    expect(runner.screen()).toBe('Menu')
    const deadName = runner.campaign().dead[0]?.name ?? ''
    expect(deadName).not.toBe('')
    return { runner, port, deadName }
  }

  it('a restart clears the dead', () => {
    const { runner } = played()
    expect(runner.campaign().dead).toHaveLength(1)
    expect(runner.restartCampaign().ok).toBe(true)
    expect(runner.campaign().dead).toEqual([])
    expect(runner.campaign().unlockedLevels).toBe(1)
  })

  it('and writes the wipe to the store THERE AND THEN', () => {
    /**
     * NOT AT THE NEXT MISSION END. A wipe that only reached the disk later would
     * come back from the dead on a reload — which is the worst possible moment
     * to discover it, because the player has already been told his campaign was
     * cleared and has started making new men.
     */
    const { runner, port } = played()
    const before = port.writes()
    runner.restartCampaign()
    expect(port.writes()).toBeGreaterThan(before)
    const reloaded = runnerFor(THREE_LEVELS, { port: fakePort(port.last()) })
    expect(reloaded.runner.campaign().dead).toEqual([])
  })

  it('but `startCampaign` on a finished campaign keeps every gravestone', () => {
    /**
     * The distinction the two verbs exist for, stated as an assertion. This is
     * the case ticket 022a pinned and it must survive: a replay is not a wipe.
     */
    const { runner, deadName } = played()
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.campaign().dead.map((d) => d.name)).toEqual([deadName])
  })

  it('and NOTHING else in the runner ever clears the save', () => {
    /**
     * The sweep. Every other command, run in turn against a played campaign,
     * must leave the dead where they are — because "which button wipes my
     * campaign" is a question a player should never have to have an opinion
     * about.
     */
    const { runner, deadName } = played()
    const commands: (() => unknown)[] = [
      () => runner.startCampaign(),
      () => runner.demoShortcut(0),
      () => runner.assignSquad(offered(runner, 3)),
      () => runner.deploy(),
      () => runner.finishMission([], new Map()),
      () => runner.recordCasualties(),
      () => runner.advanceFromBootHill(),
    ]
    for (const run of commands) {
      run()
      expect(runner.campaign().dead.map((d) => d.name)).toEqual([deadName])
    }
  })

  it('a restarted campaign is playable from the first level again', () => {
    // A wipe that left the runner on a screen with no way forward, or pointing
    // at a level the fresh campaign has not unlocked, would be a dead end
    // dressed as a fresh start.
    const { runner } = played()
    runner.restartCampaign()
    expect(runner.levelIndex()).toBe(0)
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.assignSquad(offered(runner, 3)).ok).toBe(true)
    expect(runner.deploy().ok).toBe(true)
    expect(runner.screen()).toBe('Mission')
  })

  it('takes a seed, so the shell can decide whether the same men come back', () => {
    /**
     * `core` has no clock and no unseeded random, so a restart with no seed
     * produces the SAME roster as a first run — the same names, deterministic
     * and a little sad. `app/` may read a clock and pass one. The default stays
     * the fixed constant so nothing in `core` has to.
     */
    const a = runnerFor(THREE_LEVELS)
    a.runner.restartCampaign(101)
    const b = runnerFor(THREE_LEVELS)
    b.runner.restartCampaign(101)
    expect(a.runner.campaign().recruits.map((r) => r.name)).toEqual(
      b.runner.campaign().recruits.map((r) => r.name),
    )

    const c = runnerFor(THREE_LEVELS)
    c.runner.restartCampaign(202)
    expect(c.runner.campaign().recruits.map((r) => r.name)).not.toEqual(
      a.runner.campaign().recruits.map((r) => r.name),
    )
  })
})
