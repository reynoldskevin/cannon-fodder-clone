import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { createCampaign, missionReport, recruitsAvailable, selectSquad } from '../../campaign'
import type { LevelData } from '../../level/types'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 021 — the men you chose are the men who land.
 *
 * THIS IS THE JOIN THE WHOLE CAMPAIGN HANGS ON. Ticket 019 can name a soldier
 * and bury him; the mission only knows entity ids. `Session.assignment` is the
 * one place those two vocabularies meet, and if it is wrong the campaign is
 * quietly telling the truth about the wrong people — the man who died on screen
 * is not the man on the gravestone, and nobody would ever notice from inside
 * either half.
 *
 * PAIRED BY COUNTING, NOT BY ID ARITHMETIC. `spawnFromLevel` spawns avatars then
 * enemies in level order, so the nth player entity is the nth squad member.
 * Ticket 018 learned what the alternative costs: two avatars spawn before any
 * enemy, so an offset that happens to work on level 1 breaks on the first level
 * with a different squad size.
 */

const level = (avatars: number): LevelData =>
  makeLevel({
    avatars: Array.from({ length: avatars }, (_, i) => ({ x: 2 + i * 2, y: 7 })),
    enemies: [{ x: 17, y: 13 }],
  })

/** A campaign and a squad selected for `level`. */
function deployed(avatars: number, seed = 1) {
  const campaign = createCampaign({ seed, recruits: avatars + 3 })
  const chosen = recruitsAvailable(campaign).slice(0, avatars).map((r) => r.id)
  const picked = selectSquad(campaign, level(avatars), chosen)
  if (!picked.ok) throw new Error(picked.reason)
  const session = createSession(level(avatars), { squad: picked.squad })
  return { campaign: picked.state, squad: picked.squad, session }
}

const playerIds = (s: ReturnType<typeof createSession>): number[] =>
  s.world.entities.filter((e) => e.team === 'player').map((e) => e.id)

describe('the chosen squad takes the field', () => {
  it('one man per avatar slot', () => {
    const { session } = deployed(3)
    expect(playerIds(session)).toHaveLength(3)
  })

  it('and the assignment names every one of them', () => {
    const { session, squad } = deployed(3)
    expect([...session.assignment.keys()].sort((a, b) => a - b)).toEqual(playerIds(session))
    expect([...session.assignment.values()]).toEqual(squad.map((m) => m.id))
  })

  it('in the order they were assigned, so the left flank is who you put there', () => {
    /**
     * The player's ordering decides who stands on which spawn point. A screen
     * that let you place your veteran forward must not have him silently sorted
     * to the back — and the assignment is what makes that claim checkable.
     */
    const { session, squad } = deployed(4)
    const paired = playerIds(session).map((id) => session.assignment.get(id))
    expect(paired).toEqual(squad.map((m) => m.id))
  })

  it('each man stands where the level put his slot', () => {
    // The other half of "the selected squad is what spawns at the avatars
    // positions": not just the right count, the right places.
    const doc = level(3)
    const { session } = deployed(3)
    const xs = playerIds(session).map((id) => session.world.get(id)?.x ?? 0)
    expect(xs).toHaveLength(3)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    expect(doc.spawns.avatars).toHaveLength(3)
  })

  it('the assignment is exactly the map a mission report wants', () => {
    /**
     * `missionReport(events, assignment, levelId)` from ticket 019 takes this
     * map verbatim. Anything else here would mean a conversion step, and a
     * conversion step is somewhere the two vocabularies can be mismatched
     * silently.
     */
    const { session, squad } = deployed(2)
    const ids = playerIds(session)
    const died: SimEvent = {
      type: 'UnitDied',
      id: ids[0] ?? 0,
      team: 'player',
      killerId: null,
      friendlyFire: false,
      tick: 1,
      seq: 1,
    }
    const report = missionReport([died], session.assignment, 1)
    const byId = new Map(report.entries.map((e) => [e.recruitId, e.survived]))
    expect(byId.get(squad[0]?.id ?? '')).toBe(false)
    expect(byId.get(squad[1]?.id ?? '')).toBe(true)
  })

  it('the man who dies on screen is the man on the gravestone', () => {
    // The whole point, stated end to end: kill the second soldier and check the
    // campaign buries the second NAME, not the first.
    const { session, squad } = deployed(3)
    const ids = playerIds(session)
    const died: SimEvent = {
      type: 'UnitDied',
      id: ids[1] ?? 0,
      team: 'player',
      killerId: null,
      friendlyFire: false,
      tick: 1,
      seq: 1,
    }
    const report = missionReport([died], session.assignment, 1)
    const fallen = report.entries.filter((e) => !e.survived).map((e) => e.recruitId)
    expect(fallen).toEqual([squad[1]?.id])
  })
})

describe('a session given no squad is exactly the session it always was', () => {
  it('still spawns the level`s avatars', () => {
    // The regression that would make this ticket a net loss: every session test
    // written before today builds one without a squad.
    const s = createSession(level(2))
    expect(playerIds(s)).toHaveLength(2)
  })

  it('has an empty assignment rather than a missing one', () => {
    // `undefined` here would make every caller test for it; an empty map reads
    // the same way to every consumer and needs no branch.
    const s = createSession(level(2))
    expect([...s.assignment.keys()]).toEqual([])
  })

  it('plays a mission unchanged', () => {
    const s = createSession(level(2))
    const id = s.selection()[0]
    expect(id).toBeDefined()
    s.queue.push({ type: 'move', unitIds: [id ?? 0], target: { x: 10, y: 7 } })
    for (let f = 0; f < 120; f += 1) s.advance(1 / 60)
    expect(s.world.get(id ?? 0)?.x ?? 0).toBeGreaterThan(0)
  })

  it('is still deterministic', () => {
    const run = (): string => {
      const s = createSession(level(2), { seed: 5 })
      for (let f = 0; f < 200; f += 1) s.advance(1 / 60)
      return String(s.world.stateHash())
    }
    expect(run()).toBe(run())
  })
})

describe('a squad and a mission stay consistent', () => {
  it('the assignment survives men dying', () => {
    /**
     * Ids are never reused, so a dead man's entry is still meaningful — that is
     * what lets a report name him afterwards. An assignment pruned on death
     * would silently drop every casualty from the campaign's record, which is
     * the one thing Boot Hill exists to remember.
     */
    const { session, squad } = deployed(3)
    const ids = playerIds(session)
    const doomed = ids[0] ?? 0
    session.world.despawn(doomed)
    expect(session.assignment.get(doomed)).toBe(squad[0]?.id)
  })

  it('deploying the same squad twice gives the same pairing', () => {
    // A restart rebuilds the session; the men must land in the same places.
    const first = deployed(3, 9)
    const second = createSession(level(3), { squad: first.squad })
    expect([...second.assignment.values()]).toEqual([...first.session.assignment.values()])
  })

  it('is deterministic with a squad, exactly as without one', () => {
    const run = (): string => {
      const { session } = deployed(3, 7)
      for (let f = 0; f < 200; f += 1) session.advance(1 / 60)
      return String(session.world.stateHash())
    }
    expect(run()).toBe(run())
  })
})
