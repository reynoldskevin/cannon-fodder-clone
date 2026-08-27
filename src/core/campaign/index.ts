/**
 * `src/core/campaign` — the roster behind Boot Hill (ticket 019).
 *
 * The public face of the only state in the game that outlives a mission.
 * `app/` creates or loads a campaign at a screen boundary, hands the chosen men
 * to a session, and records what came back; the sim, the renderer and the HUD
 * import nothing from here.
 *
 * Engine-free, DOM-free, clock-free and unseeded-random-free like the rest of
 * `src/core` — with one rule this directory adds and `__tests__/purity.test.ts`
 * asserts: NO BROWSER STORE, EITHER. `PersistencePort` exists so that the only
 * code touching one lives in `src/app`; a single call in here would make the
 * campaign untestable under Node and delete the seam in the same edit.
 *
 * NOTE WHAT IS ABSENT: there is no `revive`, no `setStatus`, no way at all to
 * move a man off the dead list. Permadeath is a property of this surface rather
 * than a rule somebody remembers, and a test asserts the surface.
 */

export {
  createCampaign,
  recruit,
  recruitsAvailable,
  // Ticket 046. Whether the Menu's one button reads "Start" or "Continue" is a
  // question about the campaign, so it is answered here rather than by a screen
  // that nothing tests reading a summary and guessing.
  campaignUnderway,
  applyMissionReport,
  missionReport,
  // Shared with `core/flow` on purpose: the Debrief screen and the roster read
  // the same `MissionReport`, and a second copy of the folding rules is a second
  // answer to "who died" that nothing would ever compare.
  foldMissionEntries,
  DEFAULT_RECRUITS,
  MAX_ROSTER,
  MAX_UNLOCKED_LEVELS,
} from './roster'
export type { CreateCampaignOptions, MissionTally } from './roster'
// Ticket 021. Squad selection is `core`'s business for the same reason the flow
// models are: the Recruitment screen has no tests, so a rule that lives inside
// its click handler is a rule nothing checks.
export { maxSquadFor, selectSquad, recruitmentModel } from './selection'
export type {
  RecruitmentEntry,
  RecruitmentModel,
  SquadMember,
  SquadSelection,
} from './selection'
// Ticket 022. Two pure selectors and NO NEW STATE — Boot Hill is drawn entirely
// from what 019 already stores, which is the test of the three tickets before it.
export { bootHillModel } from './boothill'
export type { BootHillModel, Grave, Trooper } from './boothill'
// Ticket 024. Beside `bootHillModel` and for the same reason: the screen that
// shows the campaign's totals has no tests, so the arithmetic lives here.
export { campaignSummary } from './boothill'
export type { CampaignSummary } from './boothill'
export { RANKS, rankFor, rankIndexFor, insigniaIndexOf } from './ranks'
export type { Rank } from './ranks'
export { NAME_POOL } from './names'
export {
  saveCampaign,
  loadCampaign,
  CAMPAIGN_SCHEMA_VERSION,
  // Ticket 024. `restartCampaign` seeds a fresh campaign with the same constant
  // a first run gets, so a restart with no seed is the same campaign a new
  // player would have started — `core` has no clock to make a varied one from.
  FRESH_CAMPAIGN_SEED,
} from './persistence'
export type {
  CampaignState,
  DeadRecruit,
  LoadedCampaign,
  MissionEntry,
  MissionOutcome,
  MissionReport,
  PersistencePort,
  Recruit,
  RecruitRecord,
  RecruitStatus,
  SaveResult,
} from './types'
