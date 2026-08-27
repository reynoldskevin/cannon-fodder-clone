/**
 * THE CAMPAIGN RUNNER (ticket 022a): one owner for the screen, the campaign,
 * the squad and the mission.
 *
 * Tickets 019-022 built a campaign nothing imported. Each piece was pure and
 * tested and none of them held anything: `advance` is `(screen, event) ->
 * result`, `applyMissionReport` is `(state, report) -> state`, `selectSquad`
 * returns a squad AND a campaign and trusts somebody to keep both. This is that
 * somebody. It ORCHESTRATES those functions and reimplements none of them — every
 * rule below this line already has a home, and a rule restated here would be a
 * second answer nothing compares.
 *
 * IT STAYS ENGINE-FREE, DOM-FREE AND STORE-FREE like the rest of `src/core`, and
 * `__tests__/purity.test.ts` holds it to that. The two things it cannot compute —
 * building a mission out of Three.js and remembering a campaign in a browser
 * store — arrive as ports (`MissionHost`, `PersistencePort`). That is not
 * ceremony: a single `THREE` or `localStorage` reference in here would make the
 * whole thing untestable under Node and delete the seam in the same edit, and a
 * fake host that records its calls is the only reason "deploying twice must not
 * leak a scene" is an assertion rather than a claim.
 *
 * THE INVARIANT EVERYTHING BELOW IS BUILT ON: every command asks `advance`
 * FIRST, and a refusal changes NOTHING — not the screen, not the campaign, not
 * the squad, not the store, and above all not the host. `advance` returns a
 * reason rather than throwing precisely because a double-clicked button is
 * ordinary traffic; a runner that called `host.start` before asking would leak
 * an entire scene on the second click, and the teardown that eventually ran
 * would release only the second mission's handles.
 */

import {
  applyMissionReport,
  bootHillModel,
  campaignSummary,
  campaignUnderway,
  createCampaign,
  FRESH_CAMPAIGN_SEED,
  loadCampaign,
  maxSquadFor,
  missionReport,
  promotionsBetween,
  recruitsAvailable,
  saveCampaign,
  selectSquad,
} from '../campaign'
import { advance, campaignComplete, INITIAL_SCREEN, isMissionExit, resolveEntry } from './transitions'
import { briefingModel } from './screens'
import type {
  BootHillModel,
  CampaignState,
  CampaignSummary,
  PersistencePort,
  Recruit,
  SquadMember,
} from '../campaign'
import type { LevelData } from '../level/types'
import type { SimEvent } from '../world/events'
import type { AdvanceResult, FlowEvent, Screen } from './transitions'
import type { BriefingModel } from './screens'

/**
 * The browser's half of a mission: build one, or release one.
 *
 * TWO METHODS AND NO STATE ASKED OF THE CALLER. The runner never inspects a
 * mission — it cannot, there being no world under Node — so the host is free to
 * rebuild a session, a scene and a pointer controller behind `start` and to free
 * whatever it allocated behind `teardown`. What the runner guarantees in return
 * is the pairing: one `start` per mission, one `teardown` per mission exit, and
 * neither on a command the chart refused.
 */
export interface MissionHost {
  /** Build and run a mission on `level` with `squad`, in assignment order. */
  start(level: LevelData, squad: readonly SquadMember[]): void
  /** Release the mission that is running. Called once, on the way out. */
  teardown(): void
}

/** Everything the runner needs from the shell that builds it. */
export interface RunnerOptions {
  /**
   * The campaign's levels, in order; index 0 is level 1.
   *
   * AN ARRAY, NOT A FETCHER. Levels arrive over `fetch`, and an async runner
   * would put a promise in front of every transition and an `await` in every
   * test. The shell loads the documents and hands them over — and `maxSquadFor`
   * needs the real `LevelData` anyway (`spawns.avatars.length` IS the squad
   * cap), so a manifest of urls could not tell the runner how many men to
   * assign.
   */
  readonly levels: readonly LevelData[]
  readonly port: PersistencePort
  readonly host: MissionHost
  /**
   * A deep link, read through `resolveEntry`. `unknown` because it comes from
   * the address bar: a stranger can type it and it may not even be a string.
   */
  readonly entry?: unknown
}

/** What the shell reads, draws and does. Every command returns `AdvanceResult`. */
export interface CampaignRunner {
  screen(): Screen
  campaign(): CampaignState
  /** 0-based index into `levels`. Derived from `unlockedLevels`, never stored. */
  levelIndex(): number
  level(): LevelData
  squad(): readonly SquadMember[]
  /** The last persistence notice; `null` when the store is behaving. */
  notice(): string | null

  briefing(): BriefingModel
  bootHill(): BootHillModel
  /**
   * What the campaign added up to, for the Menu to show when it is over.
   *
   * Answerable at any time, because it is a selector over the campaign and not a
   * screen: a campaign in progress has a perfectly good number of casualties.
   */
  summary(): CampaignSummary
  /**
   * Is the campaign over — every level the shell handed over beaten?
   *
   * ASKED OF `campaignComplete`, THE SAME FUNCTION `advanceFromBootHill` ROUTES
   * ON. The Menu has to know whether to draw the summary, and a second spelling
   * of "the campaign is finished" in a `div` would disagree with the chart the
   * first time the comparison was retuned — and `>` versus `>=` here is exactly
   * the thing ticket 020 measured.
   */
  isCampaignOver(): boolean
  /**
   * Has the campaign been played at all — is the player COMING BACK to one?
   *
   * BESIDE `isCampaignOver` AND FOR THE SAME REASON. The Menu's one button says
   * "Start campaign" to a new player and "Continue campaign" to a returning one,
   * and "the save has a history in it" spelled inside a `div` is a rule in the
   * one layer that has no tests. `campaignUnderway` owns it; this hands the
   * answer over.
   */
  isCampaignUnderway(): boolean

  startCampaign(): AdvanceResult
  /**
   * Throw the campaign away and begin a new one. NOT `startCampaign`.
   *
   * TWO VERBS, BECAUSE ONE OF THEM IS DESTRUCTIVE. A player who meant "play
   * again" must not be able to reach "delete twelve gravestones" by pressing the
   * same button — `startCampaign` is a replay that keeps every stone, and the
   * confirmation in front of THIS one is the screen's.
   *
   * `seed` is the caller's: `core` has no clock and no unseeded random, so a
   * restart without one produces the same roster a first run would.
   */
  restartCampaign(seed?: number): AdvanceResult
  demoShortcut(levelIndex: number): AdvanceResult
  deploy(): AdvanceResult
  finishMission(events: readonly SimEvent[], assignment: ReadonlyMap<number, string>): AdvanceResult
  /**
   * Leave Boot Hill: on to the next briefing with a squad already assigned, or
   * to the Menu if that was the last level.
   *
   * ONE COMMAND FOR BOTH ROWS, because Boot Hill has one button and the player
   * is not being asked which of them he wants — `campaignComplete` decides. A
   * screen that picked the event itself would be a second spelling of "the
   * campaign is finished" in the one layer nothing can test.
   */
  advanceFromBootHill(): AdvanceResult
  /**
   * Leave the Briefing without deploying, back to Boot Hill (ticket 059).
   *
   * A SCREEN MOVE AND NOTHING ELSE — the one command in this interface that
   * touches no campaign, no squad, no store and no host. The squad in particular
   * is KEPT: `advanceFromBootHill` re-assigns on the way back out, so clearing
   * it here would be a second answer to who is deploying, and the loser would be
   * whatever read `squad()` in between.
   */
  backToBase(): AdvanceResult
}

/**
 * Build the runner, loading the campaign as it goes.
 *
 * LOADING HAPPENS ONCE, HERE, AND THERE IS NO SEED OPTION. `loadCampaign` owns
 * the whole decision — a first run gets a fresh campaign, a damaged save gets a
 * notice and the flow continues — and it deliberately cannot tell a caller which
 * of those happened (both report `notice: null` on a clean first run). A seed
 * option could therefore only be honoured by re-reading the port and duplicating
 * its try/catch. Deliberately starting a NEW campaign over an existing one is
 * ticket 024's, gated on an explicit confirmation there.
 *
 * AN EMPTY `levels` THROWS, and it is the one throw in this file. Every command
 * and every model needs a level to be about, so the alternatives are answering
 * with a fabricated one — a level with no landing positions, which reads as a
 * campaign the player simply cannot deploy in — or refusing every command with a
 * reason no player can act on. This is a caller's mistake at construction, not a
 * player's at a click: the shell fetches its levels and reports a failed fetch
 * on screen before it ever gets here.
 */
export function createCampaignRunner(options: RunnerOptions): CampaignRunner {
  const { levels, port, host } = options
  if (levels.length === 0) {
    throw new Error('createCampaignRunner needs at least one level; it was given none.')
  }

  const loaded = loadCampaign(port)
  let state: CampaignState = loaded.state
  let notice: string | null = loaded.notice
  let screen: Screen = resolveEntry(options.entry)
  let squad: readonly SquadMember[] = []

  /**
   * The campaign as it stood BEFORE the mission that just ended, and `null`
   * until one has.
   *
   * THE STATE THE BOOT HILL MODEL CANNOT RECONSTRUCT.
   * `promotionsBetween(before, after)` needs the PRE-application state: after
   * `applyMissionReport` the dead are off the roster and the survivors already
   * carry the mission they just survived, so a Boot Hill built from the
   * after-state promotes everybody and carves no fresh stones. That failure
   * raises nothing anywhere.
   */
  let before: CampaignState | null = null

  /**
   * Which level the RUNNING mission is on, and `null` when none is.
   *
   * Not a second answer to "where is the player up to" — that stays derived from
   * `unlockedLevels` — but to "which level was the report that is about to be
   * written a report ABOUT". The two differ exactly when `demoShortcut` jumps
   * past the campaign's progress, and a demo run that buried its dead under the
   * level number the player happened to be up to would carve the wrong place on
   * the gravestone.
   */
  let missionLevel: number | null = null

  /**
   * Where the player is up to, DERIVED.
   *
   * `unlockedLevels` counts and has no idea how many levels exist: beat the last
   * one and it reads one past the end, so the upper clamp is what stops the host
   * being handed `undefined` on the level shipping today. Storing the position
   * instead would be a second answer that could disagree with the save the moment
   * one of them was written and the other was not.
   *
   * IT IS FLOORED BECAUSE THE SAVE IS ONLY CHECKED FOR A LOWER BOUND. `parseState`
   * rejects `unlockedLevels < 1` and deliberately accepts any finite value at or
   * above it, so `{"unlockedLevels": 1.5}` loads clean with no notice — and an
   * unfloored `0.5` indexes `levels` to `undefined` and takes `currentLevel` down
   * on the first Recruitment draw, on the line whose comment calls it unreachable.
   * `Math.max(0, ...)` below cannot fire against today's persistence for the same
   * reason — the lower bound is already guaranteed — and is kept only as
   * defence-in-depth for a future writer of `unlockedLevels`.
   */
  const levelIndex = (): number =>
    Math.max(0, Math.min(Math.floor(state.unlockedLevels) - 1, levels.length - 1))

  const levelAt = (index: number): LevelData | undefined => levels[index]

  const currentLevel = (): LevelData => {
    const level = levelAt(levelIndex())
    // Unreachable: the index is clamped into a list the constructor refused to
    // let be empty. Written out rather than asserted away because
    // `noUncheckedIndexedAccess` is right that an index is not a proof.
    if (level === undefined) throw new Error('the campaign has no levels to be on')
    return level
  }

  /**
   * Take the move the chart returned, releasing the mission if it is being left.
   *
   * TEARDOWN IS DECIDED BY `isMissionExit` AND NEVER BY A LIST OF SCREENS. Ticket
   * 020 built that predicate for exactly this. Hand-listing "Boot Hill and the
   * Briefing tear down" would be a second copy of the chart, and the first screen
   * anybody adds that can leave a mission would leak the whole level.
   */
  const settle = (moved: AdvanceResult): AdvanceResult => {
    if (!moved.ok) return moved
    if (isMissionExit(screen, moved.state)) {
      host.teardown()
      missionLevel = null
    }
    screen = moved.state
    return moved
  }

  /**
   * The men the shell would be showing, looked up fresh off the roster.
   *
   * `SquadMember` is deliberately narrower than `Recruit` (ticket 021: no record
   * on it, because a record goes stale the moment the first round lands), and
   * `briefingModel` wants the roster records so the rank it prints is the one
   * `recruitsAvailable` derives. Matching by id keeps the assignment order,
   * which is the order the men take the avatar spawns.
   */
  const squadRecords = (): readonly Recruit[] => {
    const roster = new Map(recruitsAvailable(state).map((man) => [man.id, man]))
    const records: Recruit[] = []
    for (const member of squad) {
      const record = roster.get(member.id)
      if (record !== undefined) records.push(record)
    }
    return records
  }

  const refuse = (reason: string): AdvanceResult => ({ ok: false, reason })

  /**
   * Fill the squad for `level` off the roster, with nobody asked anything
   * (ticket 040).
   *
   * NOBODY PICKS, SO SOMETHING HAS TO, AND IT MUST PICK THE SAME MEN TWICE.
   * Ticket 040 dropped the Recruitment screen: the flow goes Boot Hill straight
   * to the Briefing, and the men are already assigned by the time the player
   * reads who they are. The rule is the plainest one available — the first
   * `maxSquadFor(level)` men of the living roster, in roster order — because
   * every other rule (fittest, freshest, most decorated) is a preference nobody
   * asked for that a player cannot see or override.
   *
   * DETERMINISTIC, WHICH IS NOT DECORATION HERE. `recruitsAvailable` reads a
   * campaign that was itself built from a seed, so the same roster and the same
   * level name the same men every time; a squad drawn at random would make two
   * runs of an identical save diverge, and every determinism test in this
   * project would be testing the wrong thing.
   *
   * IT GOES THROUGH `selectSquad` RATHER THAN BUILDING THE LIST ITSELF, so the
   * one place that knows what a legal squad is stays the one place — including
   * the auto-fill that enlists replacements when the roster is smaller than the
   * level's landing positions, which is the only thing keeping a wiped campaign
   * playable.
   *
   * It answers a REASON OR `null` rather than an `AdvanceResult`, because it is
   * not a transition: the caller has its own move to make or refuse, and this
   * only tells it whether a squad could be found.
   */
  const assignSquadFor = (level: LevelData): string | null => {
    const wanted = recruitsAvailable(state)
      .slice(0, maxSquadFor(level))
      .map((man) => man.id)
    const selection = selectSquad(state, level, wanted)
    if (!selection.ok) return selection.reason
    // THE CAMPAIGN IT RETURNS IS KEPT, and that is the quiet one. Ticket 019's
    // name-uniqueness guarantee runs entirely through `recruitsIssued`, so a
    // caller that kept the squad and dropped the state would reissue the same
    // names next mission and two gravestones on Boot Hill would read the same
    // thing.
    state = selection.state
    // REPLACED, NOT APPENDED: this runs once per briefing, and the last one is
    // the squad that deploys.
    squad = selection.squad
    return null
  }

  const runner: CampaignRunner = {
    screen: () => screen,
    campaign: () => state,
    levelIndex,
    level: currentLevel,
    // A COPY. The shell holds this while the player clicks, and a live array
    // would change under it the next time a squad was assigned.
    squad: () => [...squad],
    notice: () => notice,

    // THE INDEX IS THE RUNNER'S, AND `briefingModel` MAKES IT ONE-BASED. The
    // card reads "Mission 3"; `levelIndex()` is the 0-based position in the
    // level array, and converting it in two places is how one of them ends up
    // saying "Mission 2" over level 3.
    // THE LIVING ROSTER GOES IN TOO (ticket 053), because the card names a
    // reserve: `recruitsAvailable` is the same list Recruitment draws from, so
    // "13 recruits remaining" is the men the campaign actually has left rather
    // than a number this screen keeps for itself.
    briefing: () =>
      briefingModel(currentLevel(), squadRecords(), levelIndex(), recruitsAvailable(state)),

    bootHill: () =>
      // NO BEFORE-STATE MEANS NO PROMOTIONS AND NO FRESH STONES, which is the
      // right answer rather than a degraded one: the case it models is a reload,
      // where nobody fell this session. `bootHillModel` makes the same argument
      // about its optional third argument.
      //
      // THE SQUAD COLUMN IS NOT PASSED IN ANY MORE (ticket 056). It was
      // `squadRecords()` — the survivors of the mission just fought — and on
      // level 1, where two men deploy and both can die, that column was empty
      // while six recruits stood waiting. It is the living roster, which the
      // model reads off the state it already has.
      before === null
        ? bootHillModel(state, [])
        : bootHillModel(state, promotionsBetween(before, state), before),

    summary: () => campaignSummary(state),

    isCampaignOver: () => campaignComplete(state.unlockedLevels, levels.length),
    isCampaignUnderway: () => campaignUnderway(state),

    /**
     * `startCampaign` IS A REPLAY, NOT A WIPE. It moves a screen and touches no
     * campaign state at all — clearing the save is ticket 024's, gated on an
     * explicit confirmation there, and doing it here by accident would delete
     * Boot Hill, which is the one screen the campaign exists to fill.
     */
    startCampaign: () => settle(advance(screen, 'startCampaign')),

    /**
     * THE ONLY THING IN THIS FILE THAT EVER CLEARS THE SAVE (ticket 024).
     *
     * IT WRITES THE WIPE THERE AND THEN, NOT AT THE NEXT MISSION END. A wipe
     * that only reached the disk later would come back from the dead on a
     * reload — the worst possible moment to discover it, because the player has
     * already been told his campaign was cleared and has started making new men.
     *
     * IT IS NOT A ROW IN THE CHART, AND MUST NOT BECOME ONE. A restart is a
     * RE-CONSTRUCTION rather than a transition: it puts the runner back into the
     * state `createCampaignRunner` produces — a fresh campaign on
     * `INITIAL_SCREEN` — which is the one screen from which a campaign can be
     * begun. Spelling it as an edge (`Recruitment -> Menu` on some new event)
     * would add a row `ARCHITECTURE_DIAGRAM.md` does not have, for a command
     * that is not a player walking the flow but the flow being started over.
     *
     * IT STILL GOES THROUGH `settle`, so a restart from inside a mission
     * releases that mission's GPU resources. Skipping it would leak an entire
     * scene on the one command whose whole point is to throw things away.
     *
     * THE MISSION'S RECORD GOES WITH THE CAMPAIGN. `before` is the last
     * mission's, and a Boot Hill built from it after a wipe would promote and
     * bury the men of a campaign that no longer exists.
     */
    restartCampaign: (seed: number = FRESH_CAMPAIGN_SEED) => {
      state = createCampaign({ seed })
      squad = []
      before = null
      // BEFORE the screen moves, and its notice kept: a store that refused the
      // write is the one thing the Menu must say out loud, and the player is
      // about to be looking at that very screen.
      notice = saveCampaign(port, state).notice
      return settle({ ok: true, state: INITIAL_SCREEN })
    },

    /**
     * Straight from the Menu into a mission, bypassing Boot Hill and the
     * Briefing.
     *
     * IT ASSIGNS ITS OWN SQUAD, off the same `assignSquadFor` the Briefing route
     * uses. Nobody was ever going to choose one — that is what bypassing the
     * Briefing means — and a mission with no men cannot be played. Sharing the
     * helper is the point: a demo run that filled its squad by some other rule
     * would deploy a different four men than the campaign does on the same
     * level, and the shortcut would stop being a shortcut to the real game.
     *
     * IT VALIDATES ITS INDEX. `?demo=1&level=99` is one keystroke from
     * `&level=9`; honouring it would hand the host `undefined` and take the game
     * down on boot. That is the argument `resolveEntry` makes about an unknown
     * screen, arriving through the other half of the same URL.
     */
    demoShortcut: (index: number) => {
      const moved = advance(screen, 'demoShortcut')
      if (!moved.ok) return moved
      if (!Number.isInteger(index) || index < 0 || index >= levels.length) {
        return refuse(
          `There is no level ${String(index)}; this campaign has ${String(levels.length)}.`,
        )
      }
      const level = levelAt(index)
      if (level === undefined) return refuse(`There is no level ${String(index)}.`)

      // Committed only now: everything above could refuse, and a refusal that
      // had already recruited the auto-fill would issue names against a campaign
      // that never deployed.
      const denied = assignSquadFor(level)
      if (denied !== null) return refuse(denied)
      host.start(level, squad)
      missionLevel = index
      return settle(moved)
    },

    /**
     * Start exactly one mission, on the level the player is on, with the men
     * assigned to him.
     *
     * THE SECOND CLICK COSTS A WHOLE SCENE, and `Mission` having no `deploy` row
     * is what answers it — so the chart is asked BEFORE the host is touched and
     * the shell needs no guard flag of its own.
     */
    deploy: () => {
      const moved = advance(screen, 'deploy')
      if (!moved.ok) return moved
      const index = levelIndex()
      const level = currentLevel()
      host.start(level, squad)
      missionLevel = index
      return settle(moved)
    },

    /**
     * The join: the mission's events become a report, the report becomes the
     * campaign, and the campaign decides which screen follows.
     *
     * THE ORDER IS LOAD-BEARING. The pre-application state is kept BEFORE
     * `applyMissionReport` runs, because Boot Hill is a difference between two
     * states and only the caller that applied the report still holds the first
     * one.
     *
     * THE OUTCOME COMES FROM THE REPORT, NOT FROM A FLAG THE SHELL PASSES.
     * `missionReport` already defaults to `failed` on a stream that never said
     * the mission was won — a crash, a truncation, a mission still running — and
     * the roster is updated from that same value. SINCE TICKET 040 THE ROUTING
     * READS THE SAME ANSWER: a win goes to Boot Hill and a loss back to the
     * Briefing, so the screen the player lands on is decided by the report
     * rather than by anything the shell believes about how the mission went.
     *
     * THE REPORT IS APPLIED ON BOTH OUTCOMES. A retry that resurrected the men
     * who died in the failed attempt would make death optional, which is the one
     * thing permadeath cannot survive.
     *
     * WHICH IS WHY A LOSS RE-ASSIGNS THE SQUAD BEFORE THE BRIEFING COMES BACK UP
     * (ticket 040). The men who fell in the failed attempt are off the roster the
     * line above, and re-deploying the squad that went in would hand the host
     * dead recruit ids and stand nobody on their landing positions. Re-assigning
     * is not "replacements for a mission that was not finished" — it is the same
     * rule the Briefing is always reached by, applied to the roster as it now
     * stands.
     *
     * A SQUAD THAT CANNOT BE FILLED DOES NOT BLOCK THE TRANSITION, for the same
     * reason a failed save does not: the mission is over either way, and leaving
     * the player inside a finished mission with no screen is worse than a
     * Briefing whose squad is the one that just came back. `assignSquadFor` only
     * refuses at `MAX_ROSTER`, and `deploy` is the command that would then have
     * to answer for it.
     *
     * A FAILED SAVE IS NOTICED AND DOES NOT BLOCK THE TRANSITION. Losing the save
     * is bad; losing the mission the player just spent ten minutes on is worse,
     * which is the bargain `SaveResult` was shaped for.
     */
    finishMission: (events: readonly SimEvent[], assignment: ReadonlyMap<number, string>) => {
      // `levelId` is 1-based: `unlockAfter` counts levels, a fresh campaign has
      // `unlockedLevels: 1`, and level 1 is index 0. An id off by one would
      // unlock two levels for one victory, or none.
      const played = (missionLevel ?? levelIndex()) + 1
      const fresh = missionReport(events, assignment, played)
      const event: FlowEvent = fresh.outcome === 'complete' ? 'missionComplete' : 'missionFailed'
      const moved = advance(screen, event)
      // Nothing above this line has touched anything: the report is a value, and
      // a refused `finishMission` that had already applied its own would bury men
      // on a mission the chart says never happened.
      if (!moved.ok) return moved

      before = state
      state = applyMissionReport(before, fresh)
      // THE LAST WORD, NOT AN ACCUMULATING LOG: a successful write clears it. A
      // notice that never cleared would sit over the rest of the campaign
      // claiming progress was being lost after that had stopped being true.
      notice = saveCampaign(port, state).notice
      // The retry's squad, off the roster the loss just left behind. Best
      // effort, deliberately — see the header.
      if (moved.state === 'Briefing') assignSquadFor(currentLevel())
      return settle(moved)
    },

    /**
     * Off the hill: into the next mission's Briefing with a squad already
     * assigned, or to the Menu if that was the last level.
     *
     * `campaignComplete` OWNS THE COMPARISON, uses `>` rather than `>=`, and
     * ticket 020 measured why: beating level 4 of 5 leaves `unlockedLevels` at 5,
     * and `>=` would end the campaign before the final mission with every test
     * still green.
     *
     * THE SQUAD IS ASSIGNED BEFORE THE MOVE IS TAKEN, AND A SQUAD THAT CANNOT BE
     * FOUND REFUSES THE WHOLE COMMAND (ticket 040). The Briefing's entire copy is
     * "with N soldiers you must…", so arriving there with no squad would put a
     * card up reading "with 0 soldiers" and a Deploy button that stands nobody on
     * the beach. Refusing keeps the player on Boot Hill with a reason, which is
     * the invariant this whole file is built on: a refusal changes nothing.
     */
    advanceFromBootHill: () => {
      const over = campaignComplete(state.unlockedLevels, levels.length)
      const event: FlowEvent = over ? 'campaignComplete' : 'squadAssigned'
      const moved = advance(screen, event)
      if (!moved.ok) return moved
      if (!over) {
        const denied = assignSquadFor(currentLevel())
        if (denied !== null) return refuse(denied)
      }
      return settle(moved)
    },

    /**
     * Back to the hill (ticket 059).
     *
     * THE WHOLE COMMAND IS `settle(advance(...))`, AND THAT IS THE POINT. It is
     * the only one here with nothing else to do: the chart refuses it from
     * anywhere but the Briefing, `settle` runs no teardown because the Briefing
     * is not a mission, and everything the player would come back to — the
     * campaign, the squad, the save — is already exactly right.
     *
     * IT DELIBERATELY DOES NOT CLEAR THE SQUAD. The temptation is to say "he has
     * gone back to choose again", but nobody chooses any more (ticket 040) and
     * `advanceFromBootHill` re-assigns off the roster on the way back out
     * anyway. Clearing here would leave a window where `squad()` and
     * `briefing()` disagree about who is deploying, for no gain.
     *
     * AND IT WRITES NOTHING. A save on a screen move would put a store failure
     * in front of a player who did nothing but press Back — and there would be
     * nothing new in it to write.
     */
    backToBase: () => settle(advance(screen, 'backToBase')),
  }

  return runner
}
