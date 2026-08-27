/**
 * Saving and loading a campaign (ticket 019).
 *
 * THE FAILURE THAT MATTERS HERE IS NOT A CRASH — IT IS A SILENT ONE. A campaign
 * is twelve named men and a hill full of gravestones, and it exists only in
 * whatever the port hands back. Starting a fresh campaign over somebody's dead
 * soldiers and saying nothing is the worst outcome available: they will not find
 * out until they go looking for men who no longer exist. So every rejected save
 * comes back with a `notice`, and only a genuinely absent one is silent.
 *
 * NOTHING IS EVER REPAIRED AND RE-WRITTEN. A load that "helpfully" overwrote
 * what it could not read would destroy the only copy of whatever went wrong, at
 * the exact moment somebody might want to recover it — and it would be a write
 * nobody asked for, at a moment nobody chose. `load` reads; `save` writes; the
 * caller decides when, at a mission boundary.
 *
 * NEITHER FUNCTION EVER THROWS. A throw on load takes the game down on startup,
 * before the player can reach a menu to start again from; a throw on save takes
 * the session down at a mission boundary, which turns "you lost your save" into
 * "you lost the squad you just spent ten minutes on" as well.
 */

import { createCampaign, MAX_UNLOCKED_LEVELS } from './roster'
import type {
  CampaignState,
  DeadRecruit,
  LoadedCampaign,
  PersistencePort,
  RecruitRecord,
  SaveResult,
} from './types'

/**
 * Bump this whenever a stored field's MEANING changes, not merely when one is
 * added. A mismatch discards the save with a notice, which is honest; reading an
 * old document as if it were a new one is how a campaign comes back subtly
 * wrong — the same twelve men, three of them at the wrong rank.
 */
export const CAMPAIGN_SCHEMA_VERSION = 1

/**
 * The seed a campaign gets when there is nothing to load from.
 *
 * RE-EXPORTED FROM `roster.ts`, WHERE IT IS `createCampaign`'S OWN DEFAULT
 * (ticket 040). It was declared here, and a second constant would have been the
 * cheaper edit — but then "the seed a fresh save gets" and "the seed a campaign
 * built with no options gets" would be two numbers that agree until somebody
 * changed one, and a campaign loaded from an empty store would field a different
 * eight men than a campaign made from nothing.
 */
export { FRESH_CAMPAIGN_SEED } from './roster'

const NOTICE_UNREADABLE = 'The saved campaign could not be read, so a new one was started.'
const NOTICE_DAMAGED = 'The saved campaign was damaged, so a new one was started.'
const NOTICE_VERSION =
  'The saved campaign was from a different version of the game, so a new one was started.'
const NOTICE_SAVE_FAILED =
  'This campaign could not be saved — browser storage refused the write, so progress will be lost when the page closes.'

/**
 * Hand the port a plain object. NOT A STRING: a port backed by a browser store
 * serialises for itself (`app/local-storage-port.ts`), and a port backed by a
 * test double or a future file store should not have to parse one back.
 *
 * The payload is the state plus its version, and every field in it is JSON —
 * no `Map`, no `Set`, no function, no cycle. A field that failed that would not
 * fail here; it would come back missing, which is a campaign that quietly lost
 * a man.
 */
export function saveCampaign(port: PersistencePort, state: CampaignState): SaveResult {
  try {
    port.save({ version: CAMPAIGN_SCHEMA_VERSION, ...state })
    return { saved: true, notice: null }
  } catch {
    // Quota exceeded, or a private window that refuses writes. NOT rethrown —
    // losing the save is bad, losing the session on top of it is worse — but
    // NOT silent either: a swallowed write is how a player is told each launch
    // that their campaign was damaged while every save is quietly dropped. The
    // caller owns the screen; this owns the sentence.
    return { saved: false, notice: NOTICE_SAVE_FAILED }
  }
}

/**
 * Read a campaign back, or fall back to a fresh one and say why.
 *
 * `notice` is `null` for a clean load AND for a first run — an empty store is
 * not a failure and does not deserve a warning. Everything else gets a line.
 */
export function loadCampaign(port: PersistencePort): LoadedCampaign {
  let raw: unknown
  try {
    raw = port.load()
  } catch {
    // The ACCESS itself throws in private browsing on some browsers, before any
    // parsing happens. A game that will not start in a private window is a bug
    // report nobody can reproduce.
    return fallback(NOTICE_UNREADABLE)
  }

  if (raw === null || raw === undefined) return { state: freshCampaign(), notice: null }

  let payload: unknown = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      // A half-written document from a browser killed mid-flush, or a key some
      // other tab wrote into the same slot.
      return fallback(NOTICE_DAMAGED)
    }
  }

  if (!isRecord(payload)) return fallback(NOTICE_DAMAGED)

  const version = payload['version']
  if (!isFiniteNumber(version)) return fallback(NOTICE_DAMAGED)
  // Checked BEFORE the shape, so a document from a build two weeks newer says
  // "different version" rather than "damaged" — the distinction a player can
  // act on by not downgrading again.
  if (version !== CAMPAIGN_SCHEMA_VERSION) return fallback(NOTICE_VERSION)

  const state = parseState(payload)
  if (state === null) return fallback(NOTICE_DAMAGED)
  return { state, notice: null }
}

function freshCampaign(): CampaignState {
  return createCampaign()
}

function fallback(notice: string): LoadedCampaign {
  return { state: freshCampaign(), notice }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A name has to be printable: a blank one is a blank gravestone. */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * EVERY FIELD IS CHECKED, and one bad field rejects the whole document.
 *
 * Partial acceptance is the tempting alternative and it is worse: a campaign
 * missing its dead list looks perfectly healthy and has silently emptied Boot
 * Hill. Rejecting loudly at least tells the player something happened.
 */
function parseState(payload: Record<string, unknown>): CampaignState | null {
  const seed = payload['seed']
  const unlockedLevels = payload['unlockedLevels']
  const recruitsIssued = payload['recruitsIssued']
  const rawRecruits = payload['recruits']
  const rawDead = payload['dead']

  if (!isFiniteNumber(seed)) return null
  // ZERO IS REFUSED, an over-large value is CLAMPED, and the asymmetry is
  // deliberate: a campaign that can play no level at all is a corrupted counter
  // rather than a state, while one claiming more levels than exist is still
  // perfectly playable — and discarding a hill full of gravestones over a
  // counter would be the loud version of the silent failure this file exists to
  // prevent.
  if (!isFiniteNumber(unlockedLevels) || unlockedLevels < 1) return null
  if (!isFiniteNumber(recruitsIssued) || recruitsIssued < 0) return null
  if (!Array.isArray(rawRecruits) || !Array.isArray(rawDead)) return null

  const recruits: RecruitRecord[] = []
  for (const entry of rawRecruits) {
    const record = parseRecord(entry)
    if (record === null) return null
    recruits.push(record)
  }

  const dead: DeadRecruit[] = []
  for (const entry of rawDead) {
    if (!isRecord(entry)) return null
    const record = parseRecord(entry)
    const diedOnLevel = entry['diedOnLevel']
    const rank = entry['rank']
    const rankAtDeath = entry['rankAtDeath']
    if (record === null || !isFiniteNumber(diedOnLevel)) return null
    // READ BACK EXACTLY AS CARVED, never recomputed from `missionsSurvived`.
    // The ladder is a tuning surface: rebuilding these would load a man saved a
    // Sergeant back as a Corporal the first time somebody raised a threshold —
    // silently, with no notice, because nothing about the document is wrong.
    // A living man's rank is derived because his record still changes; a dead
    // man's is recorded because his never will.
    if (!isName(rank) || !isName(rankAtDeath)) return null
    dead.push({
      ...record,
      rank,
      rankAtDeath,
      // The one field NOT read off the document: status is which list he is on,
      // and this is the dead list. A stored status could contradict it.
      status: 'dead',
      diedOnLevel,
    })
  }

  return {
    seed,
    recruits,
    dead,
    unlockedLevels: Math.min(unlockedLevels, MAX_UNLOCKED_LEVELS),
    recruitsIssued,
  }
}

/** The fields every man has, living or dead. */
function parseRecord(value: unknown): RecruitRecord | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const name = value['name']
  const missionsSurvived = value['missionsSurvived']
  const kills = value['kills']
  if (typeof id !== 'string' || id.length === 0) return null
  if (!isName(name)) return null
  if (!isFiniteNumber(missionsSurvived) || missionsSurvived < 0) return null
  if (!isFiniteNumber(kills) || kills < 0) return null
  return { id, name, missionsSurvived, kills }
}
