/**
 * `src/core/flow` — the screen flow that turns missions into a campaign
 * (ticket 020).
 *
 * The public face of two things that are decisions rather than pictures: which
 * screen an event leads to, and what the Briefing and Debrief screens say. The
 * screens themselves are DOM and live in `src/ui`; nothing in here knows what
 * any of them look like.
 *
 * IT HOLDS NO STATE OF ITS OWN. `advance` is `(screen, event) -> result`; the
 * campaign lives in `core/campaign` and the mission in `core/session`. Fusing
 * them would make every transition test need a roster, and the whole reason
 * these decisions were pulled out of the screens is that they can be tested
 * without one.
 */

export {
  SCREENS,
  EVENTS,
  TRANSITIONS,
  INITIAL_SCREEN,
  advance,
  resolveEntry,
  isMissionExit,
  campaignComplete,
} from './transitions'
export type { Screen, FlowEvent, Transition, AdvanceResult } from './transitions'
export { briefingModel, debriefModel } from './screens'
export type { BriefingModel, DebriefModel, FlowSoldier } from './screens'
// Ticket 022a. The one thing in here that DOES hold state, and it is the reason
// the four tickets before it are reachable at all: the screen, the campaign, the
// squad and the pre-mission state have to be owned somewhere, and every module
// above kept them at arm's length precisely so that owner could be one place
// with one set of rules. It still decides nothing itself — it asks `advance`,
// `selectSquad`, `missionReport` and the rest, and the browser's half of a
// mission and of a store reach it as ports.
export { createCampaignRunner } from './runner'
export type { CampaignRunner, MissionHost, RunnerOptions } from './runner'
