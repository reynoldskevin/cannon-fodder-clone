import { describe, it, expect } from 'vitest'
import {
  applyMissionReport,
  CAMPAIGN_SCHEMA_VERSION,
  createCampaign,
  loadCampaign,
  recruitsAvailable,
  saveCampaign,
} from '../index'
import type { CampaignState, PersistencePort } from '../index'

/**
 * Ticket 019 — the campaign survives a reload, or fails loudly.
 *
 * THE ONLY STATE A PLAYER CAN LOSE. Everything else in this game is rebuilt
 * from `level.json`; a campaign is twelve named men and a hill full of
 * gravestones, and it exists only in whatever the port handed back. So the
 * failure that matters is not a crash — it is a SILENT one: starting a fresh
 * campaign over somebody's dead soldiers and saying nothing. A crash at least
 * tells them.
 *
 * `PersistencePort` takes and returns `unknown` on purpose. What comes off a
 * disk is not a `CampaignState` until it has been checked, and typing it as one
 * is how corrupt data becomes a crash three frames later, somewhere else.
 */

/** The in-memory fake `core` is tested against. `app/` supplies the real one. */
function fakePort(initial: unknown = null) {
  let stored: unknown = initial
  const saves: unknown[] = []
  const port: PersistencePort = {
    load: () => stored,
    save: (state: unknown) => {
      stored = state
      saves.push(state)
    },
  }
  return { port, saves, peek: (): unknown => stored }
}

const played = (): CampaignState => {
  const fresh = createCampaign({ seed: 42, recruits: 5 })
  const men = recruitsAvailable(fresh)
  return applyMissionReport(fresh, {
    levelId: 1,
    outcome: 'complete',
    entries: [
      { recruitId: men[0]?.id ?? '', survived: false, kills: 2 },
      { recruitId: men[1]?.id ?? '', survived: true, kills: 3 },
    ],
  })
}

describe('a round trip', () => {
  it('comes back with no notice', () => {
    const { port } = fakePort()
    saveCampaign(port, played())
    expect(loadCampaign(port).notice).toBeNull()
  })

  it('comes back the same campaign', () => {
    const { port } = fakePort()
    const before = played()
    saveCampaign(port, before)
    expect(loadCampaign(port).state).toEqual(before)
  })

  it('brings the dead back as dead, which is the whole point', () => {
    const { port } = fakePort()
    const before = played()
    saveCampaign(port, before)
    const after = loadCampaign(port).state
    expect(after.dead.map((r) => r.name)).toEqual(before.dead.map((r) => r.name))
  })

  it('keeps ranks and kill records', () => {
    const { port } = fakePort()
    const before = played()
    saveCampaign(port, before)
    const after = loadCampaign(port).state
    expect(recruitsAvailable(after)).toEqual(recruitsAvailable(before))
  })

  it('what is written is JSON, because a disk is not a heap', () => {
    // A port backed by `localStorage` can only store a string. Anything with a
    // `Map`, a `Set`, a function or a cycle in it round-trips to something else
    // entirely, and the failure surfaces as a campaign that quietly loses a
    // field rather than as an error here.
    const { port, peek } = fakePort()
    saveCampaign(port, played())
    expect(() => JSON.stringify(peek())).not.toThrow()
    expect(JSON.parse(JSON.stringify(peek()))).toEqual(peek())
  })

  it('records the schema version it was written at', () => {
    const { port, peek } = fakePort()
    saveCampaign(port, played())
    expect((peek() as { version?: number }).version).toBe(CAMPAIGN_SCHEMA_VERSION)
  })
})

describe('nothing is written unless the caller asks', () => {
  it('loading writes nothing', () => {
    /**
     * "Flushed only at mission boundaries, never mid-frame" is structural here:
     * no core module holds a port, so nothing inside the roster CAN flush. This
     * is the observable half of that claim — a load that repaired and re-saved
     * would be a write nobody asked for, at a moment nobody chose.
     */
    const { port, saves } = fakePort()
    loadCampaign(port)
    expect(saves).toEqual([])
  })

  it('a failed load writes nothing either', () => {
    // The tempting place to "helpfully" overwrite the corrupt data, which
    // destroys the only copy of whatever went wrong.
    const { port, saves } = fakePort('{{{ not json')
    loadCampaign(port)
    expect(saves).toEqual([])
  })

  it('applying a mission writes nothing', () => {
    const { port, saves } = fakePort()
    applyMissionReport(createCampaign({ seed: 1 }), {
      levelId: 1,
      outcome: 'complete',
      entries: [],
    })
    expect(saves).toEqual([])
  })

  it('one save call is one write', () => {
    const { port, saves } = fakePort()
    saveCampaign(port, played())
    expect(saves).toHaveLength(1)
  })
})

describe('a save that cannot be trusted falls back, and says so', () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['nothing stored at all', null],
    ['undefined', undefined],
    ['a truncated string', '{"version":1,"recr'],
    ['a bare string', 'hello'],
    ['a number', 7],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a null recruits list', { version: CAMPAIGN_SCHEMA_VERSION, recruits: null, dead: [] }],
    ['recruits that are not objects', { version: CAMPAIGN_SCHEMA_VERSION, recruits: [1, 2], dead: [] }],
    ['a missing dead list', { version: CAMPAIGN_SCHEMA_VERSION, recruits: [] }],
    ['a recruit with no name', { version: CAMPAIGN_SCHEMA_VERSION, recruits: [{ id: 'a' }], dead: [] }],
    ['a version from the future', { version: CAMPAIGN_SCHEMA_VERSION + 1, recruits: [], dead: [] }],
    ['a version from the past', { version: CAMPAIGN_SCHEMA_VERSION - 1, recruits: [], dead: [] }],
    ['a version that is not a number', { version: 'two', recruits: [], dead: [] }],
  ]

  it('never throws, whatever it is handed', () => {
    /**
     * A THROW HERE TAKES THE GAME DOWN ON STARTUP, before the player can reach a
     * menu to start again from. Every one of these is a shape a real save can
     * have: a half-written string from a browser killed mid-flush, a document
     * from a build two weeks newer, a key some other tab wrote.
     */
    for (const [label, stored] of cases) {
      const { port } = fakePort(stored)
      expect({ label, threw: threwOnLoad(port) }).toEqual({ label, threw: false })
    }
  })

  it('gives back a playable campaign every time', () => {
    // Falling back to `null`, or to a campaign with no recruits, is a different
    // way of being broken rather than a recovery.
    for (const [label, stored] of cases) {
      const { port } = fakePort(stored)
      const { state } = loadCampaign(port)
      expect({ label, playable: recruitsAvailable(state).length > 0 }).toEqual({
        label,
        playable: true,
      })
    }
  })

  it('says so, except when there was simply nothing saved', () => {
    /**
     * The distinction that matters to a player. A FIRST RUN has nothing stored
     * and deserves silence. A DISCARDED SAVE means their campaign is gone, and
     * saying nothing about it is the worst outcome available here — worse than
     * refusing to start, because they will not find out until they look for men
     * who no longer exist.
     */
    for (const [label, stored] of cases) {
      const { port } = fakePort(stored)
      const { notice } = loadCampaign(port)
      const expected = stored === null || stored === undefined ? null : 'a notice'
      expect({ label, notice: notice === null ? null : 'a notice' }).toEqual({ label, notice: expected })
    }
  })

  it('the notice is something a human can read', () => {
    const { port } = fakePort({ version: CAMPAIGN_SCHEMA_VERSION - 1, recruits: [], dead: [] })
    const { notice } = loadCampaign(port)
    expect(typeof notice).toBe('string')
    expect((notice ?? '').length).toBeGreaterThan(10)
  })

  it('a port that throws on load is survived too', () => {
    // `localStorage` throws in private browsing on some browsers — the access
    // itself, not the parse. A game that will not start in a private window is
    // a bug report nobody can reproduce.
    const port: PersistencePort = {
      load: () => {
        throw new Error('SecurityError')
      },
      save: () => undefined,
    }
    expect(threwOnLoad(port)).toBe(false)
    expect(recruitsAvailable(loadCampaign(port).state).length).toBeGreaterThan(0)
    expect(loadCampaign(port).notice).not.toBeNull()
  })

  it('a port that throws on save does not take the game down', () => {
    // Quota exceeded, at a mission boundary, with a squad the player just spent
    // ten minutes on. Losing the save is bad; losing the session is worse.
    const port: PersistencePort = { load: () => null, save: () => { throw new Error('QuotaExceeded') } }
    expect(() => saveCampaign(port, played())).not.toThrow()
  })
})

/** Did `loadCampaign` throw? Kept out of the loops so a failure names its case. */
function threwOnLoad(port: PersistencePort): boolean {
  try {
    loadCampaign(port)
    return false
  } catch {
    return true
  }
}

describe('a fresh campaign from a fresh port is a real campaign', () => {
  it('can be played and saved immediately', () => {
    const { port } = fakePort()
    const { state } = loadCampaign(port)
    const after = applyMissionReport(state, { levelId: 1, outcome: 'complete', entries: [] })
    saveCampaign(port, after)
    expect(loadCampaign(port).state.unlockedLevels).toBe(2)
  })

  it('two fresh loads are not required to be the same campaign', () => {
    // Deliberately NOT asserted as equal: a fresh campaign's seed is the
    // caller's business (`app/` will pass one), and pinning it here would make
    // this file the place a seeding decision lives.
    const { state } = loadCampaign(fakePort().port)
    expect(recruitsAvailable(state).length).toBeGreaterThan(0)
  })
})
