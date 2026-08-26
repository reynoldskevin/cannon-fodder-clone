import { describe, it, expect } from 'vitest'
import { createSession } from '../index'
import { makeLevel } from './fixture'
import { tileToWorld } from '../../view/projection'
import { RIFLE_ORDNANCE } from '../../armoury'
import type { SimEvent } from '../../world/events'

/**
 * Ticket 011c — pointing in a man's direction is enough, in the real game.
 *
 * `line-of-fire.test.ts` pins the geometry against a bare combat system. This
 * file asks the only question that cannot: does a right-click on empty ground,
 * through the whole session — command queue, accuracy roll, cooldowns and all —
 * actually kill the man standing in that direction?
 *
 * IT MATTERS THAT THIS GOES THROUGH `session.queue` RATHER THAN CALLING
 * `orderFire`. The pointer builds a `fire` command naming a TILE, `applyCommand`
 * accepts any in-bounds tile including empty ground, and only then does combat
 * see it. A change that worked when the combat system was driven directly and
 * not when the command layer drove it would be invisible to the other suite.
 */

/**
 * A level with OUR man and nobody else.
 *
 * The target is spawned in afterwards, UNARMED and standing still — see
 * `fireAt`. An armed enemy would shoot back, and "did he die" would then be the
 * outcome of a duel our man can lose rather than a fact about where the round
 * went. That is the fixture-on-a-convenient-value trap this project has walked
 * into five times, and it would have shown up here as a test that passed on
 * three seeds out of five for reasons nothing in it mentions.
 */
const empty = () =>
  makeLevel({
    avatars: [{ x: 4, y: 7 }],
    enemies: [],
    objectives: [{ type: 'kill_all' }],
  })

/** Play a mission, right-clicking `aim` every tick, and report what happened. */
function fireAt(aim: { x: number; y: number }, apart: number, seed: number) {
  const session = createSession(empty(), { seed })
  const me = session.world.entities.filter((e) => e.team === 'player')[0]
  if (me === undefined) throw new Error('fixture did not spawn')
  /**
   * A target of a kind `WEAPON_BY_KIND` has never heard of, so it is unarmed —
   * it can be shot and killed and it never fires back. One hit point, like any
   * infantryman, so the shot that connects is the shot that kills.
   */
  const at = tileToWorld(4 + apart, 7, session.world.level.size)
  const enemy = session.world.spawn({ kind: 'sandbag', team: 'enemy', x: at.x, z: at.z })
  // RE-ISSUED EVERY FRAME, the way holding the right button does. A standing
  // order survives on its own, but re-issuing is what the pointer actually
  // produces and it must not become rapid fire — the cooldown is untouched by a
  // re-aim, which `commanded.test.ts` pins.
  const shots: SimEvent[] = []
  for (let frame = 0; frame < 900; frame += 1) {
    session.queue.push({ type: 'fire', unitIds: [me.id], ordnance: RIFLE_ORDNANCE, target: aim })
    session.advance(1 / 60)
    for (const event of session.events()) {
      if (event.type === 'ShotFired' && event.shooterId === me.id) shots.push(event)
    }
    if (!session.world.isAlive(enemy.id)) break
  }
  const first = shots[0]
  return {
    session,
    me,
    enemy,
    shots,
    /**
     * Who the FIRST round of the mission named.
     *
     * THE FIRST, AND NOT WHETHER HE EVENTUALLY DIED, and that distinction cost a
     * probe to find. The target is on the enemy team, so the AI pursues — he
     * walks toward our man every tick, and given ninety-six frames he wanders
     * into the OLD two-tile tolerance and dies to it. A test written on "did he
     * die" therefore passed against the unfixed code, measuring pursuit while
     * claiming to measure aim. The first round is fired before anybody has
     * moved.
     */
    firstTarget: first !== undefined && first.type === 'ShotFired' ? first.targetId : null,
    killed: !session.world.isAlive(enemy.id),
  }
}

const SEEDS = [1, 2, 3, 4, 5]

describe('a right-click on empty ground finds the man in that direction', () => {
  it('aiming SHORT of him still puts the first round into him', () => {
    /**
     * The player's own complaint, end to end: he is six tiles away and the click
     * lands two tiles ahead of the muzzle. Before this ticket that was four
     * tiles from the aim point, outside the two-tile tolerance, and the round
     * hit nothing at all — every seed, forever.
     *
     * Across seeds because ticket 011b made a round a chance; the claim is that
     * he dies, not that the first one lands.
     */
    for (const seed of SEEDS) {
      const { firstTarget, enemy, shots } = fireAt({ x: 6, y: 7 }, 6, seed)
      expect({ seed, hit: firstTarget === enemy.id, fired: shots.length > 0 }).toEqual({
        seed,
        hit: true,
        fired: true,
      })
    }
  })

  it('and aiming PAST him puts it into him too', () => {
    for (const seed of SEEDS) {
      const { firstTarget, enemy } = fireAt({ x: 13, y: 7 }, 6, seed)
      expect({ seed, hit: firstTarget === enemy.id }).toEqual({ seed, hit: true })
    }
  })

  it('and so does aiming a little to one side of him', () => {
    // The corridor, through the real thing: a click a tile off the line of a man
    // eight tiles away is a pointer that was very slightly high, which is what
    // aiming with a mouse across a jungle actually looks like.
    for (const seed of SEEDS) {
      const { firstTarget, enemy } = fireAt({ x: 12, y: 8 }, 6, seed)
      expect({ seed, hit: firstTarget === enemy.id }).toEqual({ seed, hit: true })
    }
  })

  it('but aiming AWAY from him finds nobody at all', () => {
    /**
     * THE CONTROL, AND WITHOUT IT THE THREE CASES ABOVE PROVE NOTHING. A rule
     * that ignored the aim entirely and simply shot the nearest enemy — which is
     * the AUTO-ENGAGE rule — would satisfy every one of them. This is the case
     * that can only pass if the direction is actually being read.
     */
    for (const seed of SEEDS) {
      const { firstTarget } = fireAt({ x: 1, y: 7 }, 6, seed)
      expect({ seed, hit: firstTarget }).toEqual({ seed, hit: null })
    }
  })
})

describe('the round the player sees is the round that killed him', () => {
  it('the reported endpoint is the man, and the mission agrees he died', () => {
    const { shots, enemy, killed } = fireAt({ x: 13, y: 7 }, 6, 1)
    // Death as well as attribution here, because this is the case that has to
    // join the two: the round the player saw is the round that killed him.
    expect(killed).toBe(true)
    const landed = shots.filter((s) => s.type === 'ShotFired' && s.hit)
    expect(landed.length).toBeGreaterThan(0)
    const last = landed[landed.length - 1]
    if (last === undefined || last.type !== 'ShotFired') throw new Error('no landed shot')
    expect(last.targetId).toBe(enemy.id)
  })

  it('and a mission fought this way still replays exactly', () => {
    // The command goes through the queue, the roll comes from `world.rng`, and
    // both are seeded — so two runs of the same script are the same mission.
    const run = (): string => {
      const { session } = fireAt({ x: 13, y: 7 }, 6, 9)
      return String(session.world.stateHash())
    }
    expect(run()).toBe(run())
  })
})
