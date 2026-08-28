import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { livingRecruitIds } from '../roll-call'
import { makeLevel } from './fixture'
import { createCampaign, recruitsAvailable, selectSquad } from '../../campaign'
import type { LevelData } from '../../level/types'

/**
 * Ticket 066 — who is still standing, in the campaign's own vocabulary.
 *
 * The squad panel lists men by NAME, which is a campaign fact; the world knows
 * only entity ids. `Session.assignment` is the one place those two vocabularies
 * meet — see `squad-assignment.test.ts`, which exists because a mismatch there is
 * the worst bug available: the game would be telling the truth about the wrong
 * people, and nothing inside either half could notice.
 *
 * THIS FUNCTION CROSSES THAT SAME JOIN, so it gets the same treatment. It is
 * handed a map keyed by the sim's ids and valued in the campaign's, and asked
 * which VALUES are still alive. Returning the keys, or testing liveness against
 * the values, both produce a set of the right SIZE — which is why size is never
 * what these cases assert.
 */

const level = (avatars: number): LevelData =>
  makeLevel({
    avatars: Array.from({ length: avatars }, (_, i) => ({ x: 2 + i * 2, y: 7 })),
    enemies: [{ x: 17, y: 13 }],
  })

/** A campaign, a squad chosen from it, and the session they landed in. */
function deployed(avatars: number, seed = 7) {
  const campaign = createCampaign({ seed, recruits: avatars + 2 })
  const chosen = recruitsAvailable(campaign).slice(0, avatars).map((man) => man.id)
  const picked = selectSquad(campaign, level(avatars), chosen)
  if (!picked.ok) throw new Error(picked.reason)
  const session = createSession(level(avatars), { squad: picked.squad })
  return { squad: picked.squad, session }
}

describe('the roll is read in the campaign’s vocabulary', () => {
  it('answers with recruit ids, not entity ids', () => {
    /**
     * THE INVERSION THAT LOOKS RIGHT. `assignment` is `entityId -> recruitId`, so
     * a function that iterated it and collected the keys would return a set of
     * exactly the same size, containing exactly the wrong things — and the panel
     * would then match no name at all and quietly go blank.
     */
    const { squad, session } = deployed(3)
    const living = livingRecruitIds(session.assignment, (id) => session.world.isAlive(id))
    for (const man of squad) expect(living.has(man.id)).toBe(true)
    // And the sim's own ids are NOT what came back.
    for (const entityId of session.assignment.keys()) {
      expect(living.has(String(entityId))).toBe(false)
    }
  })

  it('and everybody is on it the moment they land', () => {
    const { squad, session } = deployed(4)
    const living = livingRecruitIds(session.assignment, (id) => session.world.isAlive(id))
    expect([...living].sort()).toEqual([...squad.map((man) => man.id)].sort())
  })
})

describe('a man who has fallen', () => {
  it('is off the roll, and nobody else is', () => {
    const { squad, session } = deployed(3)
    // The second man's entity. Taken through `assignment` rather than by
    // position in `world.entities`, so this case cannot pass because of a spawn
    // order that happens to line up.
    const pairs = [...session.assignment.entries()]
    const fallen = pairs.find(([, recruitId]) => recruitId === squad[1]?.id)
    expect(fallen).toBeDefined()
    const [entityId, recruitId] = fallen ?? [0, '']

    expect(session.world.despawn(entityId)).toBe(true)

    const living = livingRecruitIds(session.assignment, (id) => session.world.isAlive(id))
    expect(living.has(recruitId)).toBe(false)
    expect(living.has(squad[0]?.id ?? '')).toBe(true)
    expect(living.has(squad[2]?.id ?? '')).toBe(true)
  })

  it('and a wiped squad leaves an empty roll rather than a stale one', () => {
    const { session } = deployed(2)
    for (const entityId of [...session.assignment.keys()]) session.world.despawn(entityId)
    expect(livingRecruitIds(session.assignment, (id) => session.world.isAlive(id)).size).toBe(0)
  })
})

describe('the awkward inputs', () => {
  it('answers an empty assignment with an empty set', () => {
    /**
     * `assignment` is EMPTY, NEVER MISSING, when no squad was given — a fixed
     * contract of `createSession`. A mission run without a campaign behind it
     * must not throw its way out of the render loop.
     */
    const session = createSession(level(2))
    expect(session.assignment.size).toBe(0)
    expect(livingRecruitIds(session.assignment, () => true).size).toBe(0)
    expect(livingRecruitIds(new Map(), () => true).size).toBe(0)
  })

  it('and keeps a man alive while ANY of his entities is', () => {
    /**
     * Two entities mapped to one recruit cannot happen today — `selectSquad`
     * guarantees one man per avatar slot. The case is pinned anyway because the
     * cheap implementation (delete on the first dead entity seen) reports a
     * LIVING man dead, and the day something spawns a second body for a soldier
     * the symptom would be a name vanishing off the rail mid-mission with the
     * man still on his feet.
     */
    const assignment = new Map<number, string>([
      [1, 'soldier-a'],
      [2, 'soldier-a'],
      [3, 'soldier-b'],
    ])
    const living = livingRecruitIds(assignment, (id) => id !== 1)
    expect(living.has('soldier-a')).toBe(true)
    expect(living.has('soldier-b')).toBe(true)
  })
})
