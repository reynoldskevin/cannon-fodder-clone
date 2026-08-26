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
  applyMissionReport,
  missionReport,
  DEFAULT_RECRUITS,
  MAX_ROSTER,
  MAX_UNLOCKED_LEVELS,
} from './roster'
export type { CreateCampaignOptions } from './roster'
export { RANKS, rankFor } from './ranks'
export type { Rank } from './ranks'
export { NAME_POOL } from './names'
export { saveCampaign, loadCampaign, CAMPAIGN_SCHEMA_VERSION } from './persistence'
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
