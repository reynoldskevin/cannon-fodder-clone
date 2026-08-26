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
