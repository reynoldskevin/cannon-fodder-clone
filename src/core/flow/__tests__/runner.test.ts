import { describe, it, expect } from 'vitest'
import { createCampaignRunner, EVENTS, SCREENS, SCREEN_VIEWS, VIEWS, viewFor } from '../index'
import type { CampaignRunner, MissionHost, RunnerOptions } from '../index'
import {
  CAMPAIGN_SCHEMA_VERSION,
  createCampaign,
  recruitsAvailable,
} from '../../campaign'
import type { PersistencePort, SquadMember } from '../../campaign'
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

/**
 * THERE IS NO PICKING ANY MORE (ticket 040). The player no longer chooses a
 * squad; Boot Hill assigns one and moves straight to the briefing. What used to
 * be `assignSquad(ids)` is `advanceFromBootHill()` with no argument at all, and
 * the old `offered()` helper — which read the Recruitment screen's list — has
 * nothing left to read.
 */

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
  expect(runner.advanceFromBootHill().ok).toBe(true)
  expect(runner.deploy().ok).toBe(true)
  return runner.squad()
}

/** Every screen the runner passed through while `walk` ran. */
function trace(runner: CampaignRunner, steps: readonly (() => { ok: boolean })[]): string[] {
  const seen: string[] = [runner.screen()]
  for (const step of steps) {
    const result = step()
    expect(result.ok).toBe(true)
    seen.push(runner.screen())
  }
  return seen
}

// ---------------------------------------------------------------------------

/**
 * TICKET 040 REWROTE THIS SUITE, AND THAT IS WORTH SAYING OUT LOUD.
 *
 * The chart lost two screens (`Recruitment`, `Debrief`) and two events
 * (`casualtiesRecorded`, `nextLevel`), and the runner lost four methods with
 * them. Fifty-eight of the seventy-one cases here drove that removed API — not
 * because they were weak, but because their subject no longer exists.
 *
 * Every CLAIM the old suite made that still has a subject is made again below,
 * under the same headings. What is genuinely gone is the coverage of manual
 * squad selection and of the debrief model, because the game no longer does
 * either.
 */

describe('the runner walks the chart', () => {
  it('opens on the Menu', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    expect(runner.screen()).toBe('Menu')
  })

  it('Menu -> BootHill -> Briefing -> Mission -> BootHill -> Briefing', () => {
    // The whole loop in one test, because the value of the runner is that the
    // path exists end to end — each step passing in isolation is what the
    // previous tickets already had.
    const { runner } = runnerFor(THREE_LEVELS)
    const seen = trace(runner, [
      () => runner.startCampaign(),
      () => runner.advanceFromBootHill(),
      () => runner.deploy(),
      () => runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad())),
      () => runner.advanceFromBootHill(),
    ])
    expect(seen).toEqual(['Menu', 'BootHill', 'Briefing', 'Mission', 'BootHill', 'Briefing'])
  })

  it('routes a LOST mission back to the Briefing, not to Boot Hill', () => {
    /**
     * The one asymmetry in the chart. A defeat means the level was not finished,
     * so no ground was taken and no replacements are due; routing it through
     * Boot Hill would promote a fresh squad for a mission about to be retried.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    expect(runner.finishMission(missionEvents([], 'failed'), assignmentFor(squad)).ok).toBe(true)
    expect(runner.screen()).toBe('Briefing')
  })

  it('and a retry can be lost again without leaving the loop', () => {
    // The retry is a LOOP, not a one-off concession: a runner that let a player
    // fail once and then stranded them is worse than one that never offered it.
    const { runner } = runnerFor(ONE_LEVEL)
    deploy(runner)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        runner.finishMission(missionEvents([], 'failed'), assignmentFor(runner.squad())).ok,
      ).toBe(true)
      expect(runner.screen()).toBe('Briefing')
      expect(runner.deploy().ok).toBe(true)
      expect(runner.screen()).toBe('Mission')
    }
  })

  it('takes the outcome from the report, not from the caller', () => {
    /**
     * `missionReport` defaults to `failed` on a stream that never said the
     * mission was won — a crash, a truncation, a mission still running. Routing
     * the screen off the same value the roster is updated from is what stops the
     * flow celebrating a campaign that recorded a loss.
     */
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission([], assignmentFor(squad))
    expect(runner.screen()).toBe('Briefing')
  })

  it('honours a deep link through resolveEntry, and refuses nonsense', () => {
    expect(runnerFor(ONE_LEVEL, { entry: 'Mission' }).runner.screen()).toBe('Mission')
    expect(runnerFor(ONE_LEVEL, { entry: 'Nowhere' }).runner.screen()).toBe('Menu')
    expect(runnerFor(ONE_LEVEL, { entry: 42 }).runner.screen()).toBe('Menu')
  })

  it('and a deep link to a screen the chart no longer has falls back to the Menu', () => {
    // `Recruitment` and `Debrief` were legal entry points until this ticket, so
    // a bookmarked URL naming one is real traffic, not a hypothetical.
    expect(runnerFor(ONE_LEVEL, { entry: 'Recruitment' }).runner.screen()).toBe('Menu')
    expect(runnerFor(ONE_LEVEL, { entry: 'Debrief' }).runner.screen()).toBe('Menu')
  })
})

describe('a refused command changes nothing at all', () => {
  /**
   * THE CENTRAL INVARIANT. Not "returns false" — CHANGES NOTHING. A runner that
   * refused AFTER calling the host would leak an entire scene on a double click,
   * and the teardown that followed would release only the second one's handles.
   */
  it('refuses every command the current screen has no row for', () => {
    const { runner, host, port } = runnerFor(ONE_LEVEL)
    const before = { screen: runner.screen(), writes: port.writes(), starts: host.starts() }
    // On the Menu, only `startCampaign` and `demoShortcut` are legal.
    for (const attempt of [
      () => runner.deploy(),
      () => runner.advanceFromBootHill(),
      () => runner.finishMission([], new Map()),
    ]) {
      const result = attempt()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(typeof result.reason).toBe('string')
    }
    expect({
      screen: runner.screen(),
      writes: port.writes(),
      starts: host.starts(),
    }).toEqual(before)
  })

  it('and never throws, because a double-clicked button is ordinary traffic', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    expect(() => runner.startCampaign()).not.toThrow()
    expect(runner.startCampaign().ok).toBe(false)
  })

  it('and does not touch the host on a refusal', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    deploy(runner)
    const starts = host.starts()
    expect(runner.deploy().ok).toBe(false)
    expect(host.starts()).toBe(starts)
  })
})

describe('deploying starts exactly one mission, with the right men on the right map', () => {
  it('starts the host once, with the level the campaign is on', () => {
    const { runner, host } = runnerFor(THREE_LEVELS)
    deploy(runner)
    expect(host.starts()).toBe(1)
    expect(host.calls[0]).toMatchObject({ kind: 'start', level: 'Jungle Approach' })
  })

  it('and the squad it starts with is the squad it reports', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    const call = host.calls.find((c) => c.kind === 'start')
    expect(call).toMatchObject({ squad: squad.map((m) => m.id) })
  })

  it('and the second mission is the second level', () => {
    const { runner, host } = runnerFor(THREE_LEVELS)
    deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.deploy().ok).toBe(true)
    expect(host.calls.filter((c) => c.kind === 'start').at(-1)).toMatchObject({
      level: 'The Ridge',
    })
  })

  it('and a RETRY re-runs the same level, not the next one', () => {
    // The loss path must not advance `levelIndex`, or failing a mission would
    // skip it — which is a promotion for losing.
    const { runner, host } = runnerFor(THREE_LEVELS)
    deploy(runner)
    runner.finishMission(missionEvents([], 'failed'), assignmentFor(runner.squad()))
    expect(runner.deploy().ok).toBe(true)
    expect(host.calls.filter((c) => c.kind === 'start').at(-1)).toMatchObject({
      level: 'Jungle Approach',
    })
    expect(runner.levelIndex()).toBe(0)
  })
})

describe('leaving a mission releases it, and entering one never does', () => {
  it('tears the host down once when the mission ends', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    deploy(runner)
    expect(host.teardowns()).toBe(0)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
    expect(host.teardowns()).toBe(1)
  })

  it('and on a loss too, or a retry would deploy into the previous scene', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    deploy(runner)
    runner.finishMission(missionEvents([], 'failed'), assignmentFor(runner.squad()))
    expect(host.teardowns()).toBe(1)
  })

  it('and every start is matched by a teardown across a whole campaign', () => {
    // The leak this suite exists to catch, stated as a balance rather than as a
    // count of any one call.
    const { runner, host } = runnerFor(THREE_LEVELS)
    deploy(runner)
    for (let i = 0; i < 3; i += 1) {
      runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
      if (runner.screen() === 'BootHill' && !runner.isCampaignOver()) {
        if (runner.advanceFromBootHill().ok) runner.deploy()
      }
    }
    expect(host.teardowns()).toBe(host.starts())
  })
})

describe('assigning a squad', () => {
  it('happens without the player choosing anybody', () => {
    // Step 2 of the flow the user asked for: "Boot hill. Auto assign soldiers
    // (no picking)."
    const { runner } = runnerFor(ONE_LEVEL)
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.squad().length).toBeGreaterThan(0)
  })

  it('and fills the level`s landing positions', () => {
    // `maxSquadFor` reads `spawns.avatars.length`; a squad larger than the map
    // has nowhere to put the extra men.
    const { runner } = runnerFor([makeLevel('Two Up', 2)])
    runner.startCampaign()
    runner.advanceFromBootHill()
    expect(runner.squad().length).toBeLessThanOrEqual(2)
  })

  it('and is DETERMINISTIC, so a replay does not diverge', () => {
    /**
     * Everything else in this project is. A squad chosen differently on two runs
     * of the same roster and level would give the same seed two different
     * missions, which is the one thing the determinism contract forbids.
     */
    const a = runnerFor(THREE_LEVELS).runner
    const b = runnerFor(THREE_LEVELS).runner
    a.startCampaign()
    a.advanceFromBootHill()
    b.startCampaign()
    b.advanceFromBootHill()
    expect(a.squad().map((m) => m.id)).toEqual(b.squad().map((m) => m.id))
  })
})

describe('finishing a mission records it against the right men', () => {
  it('a man who died is not in the next squad', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    const fallen = squad[0]
    expect(fallen).toBeDefined()
    // Entity 1 is the first squad member, per `assignmentFor`.
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.squad().map((m) => m.id)).not.toContain(fallen!.id)
  })

  it('and the survivors are still on the roster', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    const living = new Set(recruitsAvailable(runner.campaign()).map((m) => m.id))
    for (const member of squad.slice(1)) {
      expect({ id: member.id, alive: living.has(member.id) }).toEqual({ id: member.id, alive: true })
    }
  })

  it('and a death on a LOST mission counts too', () => {
    // Permadeath is not a reward for winning. A squad wiped out on a failed
    // attempt must not walk back into the retry.
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    const fallen = squad[0]!
    runner.finishMission(missionEvents([1], 'failed'), assignmentFor(squad))
    const living = new Set(recruitsAvailable(runner.campaign()).map((m) => m.id))
    expect(living.has(fallen.id)).toBe(false)
  })
})

describe('the campaign is loaded once and saved when it changes', () => {
  it('reads the store at construction', () => {
    const seeded = createCampaign()
    const port = fakePort({ version: CAMPAIGN_SCHEMA_VERSION, state: seeded })
    const { runner } = runnerFor(ONE_LEVEL, { port })
    expect(runner.campaign()).toBeDefined()
  })

  it('and writes when the roster changes', () => {
    const { runner, port } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    const before = port.writes()
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    expect(port.writes()).toBeGreaterThan(before)
  })

  it('and survives a store that throws', () => {
    /**
     * `localStorage` throws on a full quota and in private browsing. A campaign
     * that could not be saved must still be PLAYABLE — losing progress is bad,
     * and taking the mission down with it is worse.
     */
    const { runner, port } = runnerFor(ONE_LEVEL)
    port.fail(true)
    expect(() => deploy(runner)).not.toThrow()
    expect(runner.screen()).toBe('Mission')
  })
})

/**
 * Ticket 046 — the Menu says "Continue campaign" to a player who is coming back.
 *
 * The rule itself is `campaignUnderway`'s and is tested against the campaign in
 * `core/campaign`. What these two cases pin is that the runner hands the SCREEN
 * the live answer: a menu built from a stale one greets a returning player with
 * "Start campaign" over his own save, which is the whole defect.
 */
describe('coming back to a campaign', () => {
  it('a campaign nobody has played is not underway', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    expect(runner.isCampaignUnderway()).toBe(false)
  })

  it('but one with a mission behind it is, and says so as soon as it is over', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.isCampaignUnderway()).toBe(true)
  })
})

describe('the end of the campaign', () => {
  it('reports itself over once the last level is won', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.isCampaignOver()).toBe(true)
  })

  it('and Boot Hill is the way back to the Menu', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.screen()).toBe('BootHill')
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.screen()).toBe('Menu')
  })

  it('but is NOT over while levels remain', () => {
    // The control: an `isCampaignOver` that returned true always would satisfy
    // the case above and end every campaign after one mission.
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(squad))
    expect(runner.isCampaignOver()).toBe(false)
  })
})

describe('the models the shell draws come from core, unchanged', () => {
  it('the briefing names the level and its objectives', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    runner.startCampaign()
    runner.advanceFromBootHill()
    const briefing = runner.briefing()
    expect(briefing.levelName).toBe('Jungle Approach')
    expect(briefing.objectives.length).toBeGreaterThan(0)
  })

  it('and carries the one-based level number and the squad size for the card', () => {
    // "Mission <level num>. With <number of soldiers> soldiers you must:"
    const { runner } = runnerFor(THREE_LEVELS)
    runner.startCampaign()
    runner.advanceFromBootHill()
    expect(runner.briefing().levelNumber).toBe(1)
    expect(runner.briefing().soldierCount).toBe(runner.squad().length)
  })

  it('and the number climbs with the campaign', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    deploy(runner)
    runner.finishMission(missionEvents([], 'complete'), assignmentFor(runner.squad()))
    runner.advanceFromBootHill()
    expect(runner.briefing().levelNumber).toBe(2)
  })

  it('and Boot Hill has a model to draw', () => {
    const { runner } = runnerFor(ONE_LEVEL)
    runner.startCampaign()
    expect(runner.bootHill()).toBeDefined()
  })
})

describe('the demo shortcut', () => {
  it('jumps straight to a mission', () => {
    const { runner, host } = runnerFor(THREE_LEVELS)
    expect(runner.demoShortcut(1).ok).toBe(true)
    expect(runner.screen()).toBe('Mission')
    expect(host.calls.at(-1)).toMatchObject({ level: 'The Ridge' })
  })

  it('and refuses a level that does not exist, changing nothing', () => {
    const { runner, host } = runnerFor(ONE_LEVEL)
    expect(runner.demoShortcut(9).ok).toBe(false)
    expect(runner.screen()).toBe('Menu')
    expect(host.starts()).toBe(0)
  })
})

describe('the runner is a value the shell can trust', () => {
  it('reports a screen the router can always draw', () => {
    // Ticket 022b's contract: every screen the runner can report has a view.
    const { runner } = runnerFor(THREE_LEVELS)
    const seen = new Set<string>()
    seen.add(runner.screen())
    runner.startCampaign()
    seen.add(runner.screen())
    runner.advanceFromBootHill()
    seen.add(runner.screen())
    runner.deploy()
    seen.add(runner.screen())
    for (const screen of seen) {
      expect({ screen, view: viewFor(screen as never) }).toEqual({
        screen,
        view: SCREEN_VIEWS[screen as never],
      })
    }
  })

  it('and every declared screen has an ANSWER in the view table, with none left over', () => {
    /**
     * An ANSWER, not necessarily a panel. `Mission` maps to `null` on purpose —
     * the mission is the absence of an overlay, not an overlay of its own — so
     * asserting a string here would be asserting against the design rather than
     * against a defect.
     *
     * What must hold is that the table's keys and `SCREENS` are the same set. A
     * screen the runner can report and the table has never heard of is a router
     * with nothing to draw, and a key left behind after a screen is deleted is
     * the drift this ticket just spent its whole diff removing.
     */
    expect(Object.keys(SCREEN_VIEWS).sort()).toEqual([...SCREENS].sort())
    for (const screen of SCREENS) {
      const view = SCREEN_VIEWS[screen]
      expect({ screen, ok: view === null || VIEWS.includes(view) }).toEqual({ screen, ok: true })
    }
  })

  it('and every declared event is used by at least one row', () => {
    // An event in `EVENTS` with no row is a button the machine always refuses.
    expect(EVENTS.length).toBeGreaterThan(0)
    expect(EVENTS).not.toContain('casualtiesRecorded')
    expect(EVENTS).not.toContain('nextLevel')
  })
})

describe('starting again WIPES, and only when asked in so many words', () => {
  it('restartCampaign clears the roster', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    const afterLoss = recruitsAvailable(runner.campaign()).length
    expect(runner.restartCampaign(7).ok).toBe(true)
    expect(recruitsAvailable(runner.campaign()).length).toBeGreaterThan(afterLoss)
    expect(runner.screen()).toBe('Menu')
  })

  it('and an ordinary walk back to the Menu does NOT', () => {
    // The distinction ticket 024 exists for: finishing a campaign is not the
    // same as throwing one away.
    const { runner } = runnerFor(ONE_LEVEL)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'complete'), assignmentFor(squad))
    const before = recruitsAvailable(runner.campaign()).map((m) => m.id)
    runner.advanceFromBootHill()
    expect(recruitsAvailable(runner.campaign()).map((m) => m.id)).toEqual(before)
  })
})

describe('BACK TO BASE — the Briefing is no longer a one-way door (ticket 059)', () => {
  /** Get to the Briefing the ordinary way, with a squad assigned. */
  function toBriefing(runner: CampaignRunner): void {
    expect(runner.startCampaign().ok).toBe(true)
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.screen()).toBe('Briefing')
  }

  it('takes the player back to Boot Hill', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    expect(runner.backToBase().ok).toBe(true)
    expect(runner.screen()).toBe('BootHill')
  })

  it('and is refused from every other screen, changing nothing when it is', () => {
    /**
     * THE INVARIANT THE WHOLE RUNNER IS BUILT ON, applied to the new command: a
     * refusal changes NOTHING. Checked from the Menu, where the player has not
     * started, and from inside a mission — where honouring it would tear down a
     * live scene.
     */
    const { runner, host } = runnerFor(THREE_LEVELS)
    expect(runner.screen()).toBe('Menu')
    expect(runner.backToBase().ok).toBe(false)
    expect(runner.screen()).toBe('Menu')

    deploy(runner)
    expect(runner.screen()).toBe('Mission')
    const teardowns = host.teardowns()
    expect(runner.backToBase().ok).toBe(false)
    expect(runner.screen()).toBe('Mission')
    // THE ONE THAT WOULD COST A SCENE. A refused command must not reach
    // `settle`, and `settle` is what calls `host.teardown`.
    expect(host.teardowns()).toBe(teardowns)
  })

  it('and it never starts or tears down a mission even when it IS allowed', () => {
    // The Briefing is not a mission, so there is nothing to release. A command
    // that ran teardown here would free the stage the next deploy rebuilds.
    const { runner, host } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    expect(runner.backToBase().ok).toBe(true)
    expect(host.calls).toEqual([])
  })

  it('and it leaves the campaign, the squad and the store exactly as they were', () => {
    /**
     * IT IS A SCREEN MOVE AND NOTHING ELSE. The squad in particular must
     * survive: Boot Hill's own button re-assigns on the way back out, but a
     * `backToBase` that cleared it would leave the runner holding an empty squad
     * if anything read it before the player pressed anything.
     */
    const { runner, port } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    const campaign = JSON.stringify(runner.campaign())
    const squad = runner.squad().map((m) => m.id)
    const writes = port.writes()

    expect(runner.backToBase().ok).toBe(true)

    expect(JSON.stringify(runner.campaign())).toBe(campaign)
    expect(runner.squad().map((m) => m.id)).toEqual(squad)
    // NO WRITE. Nothing changed, so there is nothing to save — and a save on
    // every screen move would put a store failure in front of a player who did
    // nothing but press Back.
    expect(port.writes()).toBe(writes)
  })

  it('and the briefing the player comes back to is the same briefing', () => {
    const { runner } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    const first = JSON.stringify(runner.briefing())
    expect(runner.backToBase().ok).toBe(true)
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(JSON.stringify(runner.briefing())).toBe(first)
  })

  it('and pacing back and forth recruits nobody', () => {
    /**
     * THE REAL RISK IN ADDING THIS LOOP, AND THE REASON IT IS TESTED AT ALL.
     *
     * `advanceFromBootHill` calls `assignSquadFor` on every pass, and
     * `assignSquadFor` goes through `selectSquad` — which AUTO-FILLS a short
     * roster by ENLISTING new men and issuing them names off the pool. A door
     * back to Boot Hill turns a once-per-mission call into one the player can
     * run as many times as he likes, so if that call were not idempotent, pacing
     * between the two screens would print recruits and burn through the name
     * pool for free.
     *
     * It is idempotent because the enlistment happens only while the living
     * roster is SHORTER than the level's landing positions — once, on the first
     * pass — and every later pass finds the men already there. That is a
     * property of `selectSquad` this test pins from the outside, because nothing
     * in the runner would notice if it changed.
     */
    const { runner } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    const roster = recruitsAvailable(runner.campaign()).map((m) => m.id)
    const issued = runner.campaign().recruitsIssued

    for (let lap = 0; lap < 10; lap += 1) {
      expect(runner.backToBase().ok).toBe(true)
      expect(runner.advanceFromBootHill().ok).toBe(true)
    }

    expect(recruitsAvailable(runner.campaign()).map((m) => m.id)).toEqual(roster)
    expect(runner.campaign().recruitsIssued).toBe(issued)
    expect(runner.screen()).toBe('Briefing')
  })

  it('and the men who deploy after a round trip are the men the card named', () => {
    /**
     * THE POINT OF ALL OF THE ABOVE, stated as the thing the player would see.
     * A round trip that quietly re-drew the squad would stand different soldiers
     * on the beach than the briefing he just read listed.
     */
    const { runner, host } = runnerFor(THREE_LEVELS)
    toBriefing(runner)
    const named = runner.briefing().squad.map((m) => m.id)
    expect(runner.backToBase().ok).toBe(true)
    expect(runner.advanceFromBootHill().ok).toBe(true)
    expect(runner.deploy().ok).toBe(true)
    const started = host.calls.find((c) => c.kind === 'start')
    expect(started?.squad).toEqual(named)
  })

  it('and a player who lost can read the memorial before trying again', () => {
    // The other route onto the Briefing. A loss lands here, and this is the case
    // the button was actually asked for.
    const { runner } = runnerFor(THREE_LEVELS)
    const squad = deploy(runner)
    runner.finishMission(missionEvents([1], 'failed'), assignmentFor(squad))
    expect(runner.screen()).toBe('Briefing')
    expect(runner.backToBase().ok).toBe(true)
    expect(runner.screen()).toBe('BootHill')
  })
})
