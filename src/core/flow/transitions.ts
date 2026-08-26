/**
 * THE CAMPAIGN'S SCREEN FLOW, AS DATA (ticket 020).
 *
 * `TRANSITIONS` is a table rather than a `switch`, and that is the whole design.
 * A `switch` would be a second place the state chart in `ARCHITECTURE_DIAGRAM.md`
 * is written down, and the two would diverge on the first screen anybody adds —
 * the hotkey works, the picture lies, and the reader who trusted the picture is
 * the one who pays. One array, read by the machine and compared against the
 * document by `__tests__/diagram.test.ts`, cannot drift from either.
 *
 * THE MACHINE HOLDS NOTHING. `advance` is a function of a screen name and an
 * event: no roster, no session, no `div`. Fusing it with the campaign would make
 * every transition case need a squad; fusing it with the DOM would make none of
 * them runnable at all, because Vitest runs `environment: 'node'` and `src/ui`
 * is untestable for exactly that reason.
 */

/**
 * Every screen the campaign can be on.
 *
 * A CLOSED union. These names are the table's keys and the diagram's node ids;
 * a screen added as a loose string would compile into a machine with no rows
 * that can reach or leave it, which is a softlock that type-checks.
 */
export type Screen = 'Menu' | 'Recruitment' | 'Briefing' | 'Mission' | 'Debrief' | 'BootHill'

/** Everything the player (or `main.ts`) can do to move between screens. */
export type FlowEvent =
  | 'startCampaign'
  | 'squadAssigned'
  | 'deploy'
  | 'missionComplete'
  | 'missionFailed'
  | 'casualtiesRecorded'
  | 'nextLevel'
  | 'campaignComplete'
  | 'demoShortcut'

/** One row of the chart: pressing `event` on `from` lands on `to`. */
export interface Transition {
  readonly from: Screen
  readonly event: FlowEvent
  readonly to: Screen
}

/**
 * The result of asking the machine to move.
 *
 * A DISCRIMINATED RESULT, NEVER A THROW AND NEVER SILENCE. Returning the state
 * unchanged on an event the screen has no row for produces a dead button: the
 * player presses Deploy on the Debrief screen, nothing happens, and there is
 * nothing to log. Throwing is the opposite failure — a double-clicked button is
 * ordinary traffic, not a programming error, and it would take the game down.
 */
export type AdvanceResult = { readonly ok: true; readonly state: Screen } | { readonly ok: false; readonly reason: string }

/** Where a launch with no valid entry state begins. */
export const INITIAL_SCREEN: Screen = 'Menu'

export const SCREENS: readonly Screen[] = ['Menu', 'Recruitment', 'Briefing', 'Mission', 'Debrief', 'BootHill']

export const EVENTS: readonly FlowEvent[] = [
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

/**
 * The chart, transcribed from `ARCHITECTURE_DIAGRAM.md` and asserted against it.
 *
 * Plain data, JSON round-trippable, the same bargain `combat/weapons.ts` and
 * `ordnance/table.ts` make: a row carries no behaviour, so a later ticket can
 * read these out of a document without a line of code changing.
 *
 * `Menu -> Mission` is the demo shortcut (`?demo=1&level=N`). It bypasses
 * Recruitment and Briefing and looks like a mistake in the picture, which is
 * precisely why it is written down in both places.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'Menu', event: 'startCampaign', to: 'Recruitment' },
  { from: 'Recruitment', event: 'squadAssigned', to: 'Briefing' },
  { from: 'Briefing', event: 'deploy', to: 'Mission' },
  { from: 'Mission', event: 'missionComplete', to: 'Debrief' },
  { from: 'Mission', event: 'missionFailed', to: 'Debrief' },
  { from: 'Debrief', event: 'casualtiesRecorded', to: 'BootHill' },
  { from: 'BootHill', event: 'nextLevel', to: 'Recruitment' },
  { from: 'BootHill', event: 'campaignComplete', to: 'Menu' },
  { from: 'Menu', event: 'demoShortcut', to: 'Mission' },
]

const isScreen = (value: unknown): value is Screen =>
  typeof value === 'string' && SCREENS.some((screen) => screen === value)

const isEvent = (value: unknown): value is FlowEvent =>
  typeof value === 'string' && EVENTS.some((event) => event === value)

/**
 * Move, or say why not.
 *
 * The arguments are typed but NOT trusted: the screens are DOM and a handler can
 * be wired to a typo'd string, so an unknown screen or event is refused like any
 * other unnamed pairing rather than crashing the machine that owns the game.
 */
export function advance(from: Screen, event: FlowEvent): AdvanceResult {
  if (!isScreen(from)) return { ok: false, reason: `unknown screen "${String(from)}" — not one of ${SCREENS.join(', ')}` }
  if (!isEvent(event)) return { ok: false, reason: `unknown event "${String(event)}" on ${from} — not one of ${EVENTS.join(', ')}` }
  const row = TRANSITIONS.find((t) => t.from === from && t.event === event)
  if (row === undefined) return { ok: false, reason: `no transition from ${from} on "${event}" — the chart does not allow it` }
  return { ok: true, state: row.to }
}

/**
 * Validate an injected entry state, falling back to the menu.
 *
 * A DEEP LINK IS A URL A STRANGER CAN TYPE. Ticket 029's `?demo=1&level=N` feeds
 * this, so the value arrives from outside the program entirely and may not even
 * be a string. The argument is `unknown` and the reading is done in `src/app`:
 * reaching for the address bar from here would move the decision into the one
 * place no test under Node can see it.
 *
 * Unknown values become `INITIAL_SCREEN` rather than being honoured, because a
 * machine started in a state with no outgoing rows is a game that opens on a
 * screen where no button does anything.
 */
export function resolveEntry(entry: unknown): Screen {
  return isScreen(entry) ? entry : INITIAL_SCREEN
}

/**
 * Does this transition LEAVE a mission, and therefore have to release its GPU
 * resources?
 *
 * The pure half of "mission teardown fully disposes Three.js resources" — there
 * is no GPU under Node to count handles on, but WHICH transitions must release
 * them is a decision, and a decision belongs where it can be tested. `main.ts`
 * calls `teardown()` on this.
 *
 * Entering a mission is deliberately false: tearing down on the way IN would
 * dispose the level that was just built.
 */
export function isMissionExit(from: Screen, to: Screen): boolean {
  return from === 'Mission' && to !== 'Mission'
}

/**
 * Has the player beaten the last level?
 *
 * THE COMPARISON LIVES HERE, NOT IN THE ROSTER. `CampaignState.unlockedLevels`
 * counts and has no idea how many levels exist — beat level 5 of 5 and it reads
 * 6, which is right for a counter and meaningless as a progression. So the
 * caller supplies the level count and `BootHill -> Menu` versus
 * `BootHill -> Recruitment` is decided against it.
 *
 * A nonsense `totalLevels` (0, negative, NaN — a caller whose level list failed
 * to load) reports "not over". Declaring victory on a missing manifest would end
 * a campaign the player is still halfway through.
 */
export function campaignComplete(unlockedLevels: number, totalLevels: number): boolean {
  if (!Number.isFinite(totalLevels) || totalLevels <= 0) return false
  if (!Number.isFinite(unlockedLevels)) return false
  return unlockedLevels > totalLevels
}
