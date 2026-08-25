import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSession } from '../../session'
import { makeLevel } from '../../session/__tests__/fixture'

/**
 * Ticket 012 — the AI does not break replay.
 *
 * The whole simulation's contract is that the same level, seed and commands
 * produce the same mission every time, and a decision layer is the easiest place
 * in a codebase to lose it: `Math.random` for a bit of variety, a `Set` of
 * alerted units iterated to issue orders, a target chosen by scanning a `Map`.
 * None of those throw and none of them look wrong.
 *
 * ASSERTED TWICE, ON PURPOSE. The behavioural run below would catch a `Map`
 * whose order happened to differ between the two sessions — but both sessions
 * insert in the same order, so it very likely would NOT. The source scan cannot
 * see an ordering bug at all, but it does catch the clock and the random. They
 * fail differently, so both are here.
 */

const AI_DIR = new URL('..', import.meta.url).pathname

/**
 * A firefight busy enough that a divergence has somewhere to show up.
 *
 * SIX A SIDE, NOT THREE, AND IT IS THE LETHALITY THAT FORCES IT. At
 * `INFANTRY_HEALTH = 1` every man dies to the first round that finds him, so a
 * mission cannot be made busier by running it LONGER — a three-a-side skirmish
 * is decided inside 65 of these 600 ticks and the remaining 535 are silent. The
 * only lever is the size of the opening volley. (Reaching for a bigger number by
 * having the enemy keep firing at corpses is the other way to get it, and it is
 * how an earlier draft of this file quietly acquired a covering-fire behaviour
 * nobody had asked for.)
 *
 * The two blocked clumps are cover, so that sightlines break and reform and the
 * machine has to run its `pursue` edges rather than standing in the open
 * trading rounds.
 */
const skirmish = () =>
  makeLevel({
    avatars: [
      { x: 3, y: 3 },
      { x: 3, y: 5 },
      { x: 3, y: 7 },
      { x: 3, y: 9 },
      { x: 3, y: 11 },
      { x: 2, y: 7 },
    ],
    enemies: [
      { x: 15, y: 3 },
      { x: 15, y: 5 },
      { x: 15, y: 7 },
      { x: 15, y: 9 },
      { x: 15, y: 11 },
      { x: 12, y: 7 },
    ],
    blocked: new Set(['9,4', '9,5', '9,6', '10,10', '10,11']),
  })

/** Everything the mission did, flattened to something comparable. */
function replay(): string[] {
  const s = createSession(skirmish(), { seed: 7 })
  const log: string[] = []
  const squad = [...s.selection()]
  s.queue.push({ type: 'move', unitIds: squad, target: { x: 16, y: 7 } })
  // THE PLAYER SHOOTS TOO, and the mission is much thinner without it. Both
  // sides are one hit point, so an enemy-only firefight is three rounds and
  // over — too small a sample for a divergence to have anywhere to appear, and
  // too quiet to exercise the alert radius at all. A standing fire order keeps
  // rounds going out for the whole six hundred ticks, and each one is a
  // `ShotFired` some idle enemy across the map has to react to identically in
  // both runs.
  // Aimed at a tile an enemy is actually standing on, so the player's rounds
  // kill as well as make noise. Casualties on BOTH sides is what makes this a
  // sample rather than a massacre — it exercises the machine's bookkeeping for
  // a target that dies and for a shooter that dies, and the assertions below
  // require both.
  s.queue.push({ type: 'fire', unitIds: squad, ordnance: 'rifle', target: { x: 12, y: 7 } })
  for (let f = 0; f < 600; f += 1) {
    s.advance(1 / 60)
    for (const e of s.events()) {
      if (e.type === 'ShotFired') log.push(`${e.tick}:shot:${e.shooterId}->${e.targetId ?? 'x'}`)
      if (e.type === 'UnitDied') log.push(`${e.tick}:died:${e.id}`)
    }
  }
  for (const e of s.world.entities) {
    log.push(`end:${e.id}:${e.x.toFixed(9)}:${e.z.toFixed(9)}:${e.health}:${e.state}`)
  }
  return log
}

describe('two runs of the same mission are the same mission', () => {
  const a = replay()

  it('produced a real firefight, so the comparison means something', () => {
    // An empty log compares equal to an empty log. This is what stops a mission
    // in which nothing happened from certifying the sim as deterministic.
    expect(a.filter((l) => l.includes(':shot:')).length).toBeGreaterThan(10)
    // Both sides losing men, not just one. A one-sided sample would leave the
    // "a shooter dies mid-engagement" path untaken, and that is the path where a
    // machine keyed on anything shakier than the entity id comes apart.
    const dead = a.filter((l) => l.includes(':died:'))
    expect(dead.length).toBeGreaterThan(4)
    expect(a.some((l) => l.startsWith('end:'))).toBe(true) // survivors, so not a wipe
  })

  it('fires the same rounds and ends in the same place', () => {
    expect(replay()).toEqual(a)
  })

  it('and a third time, in case two agreed by luck', () => {
    expect(replay()).toEqual(a)
  })
})

describe('no non-determinism at the source level', () => {
  /**
   * Comments removed, so a mention of `Math.random` in prose is not a finding.
   *
   * A pure string function, kept separate from the file read so the guard below
   * can exercise it on a literal. Pointing it at THIS file instead is the
   * obvious move and it is a trap: any phrase the assertion names as a needle is
   * also a string literal here, and `strip` removes comments, not literals, so
   * the needle survives its own strip and the guard can never pass.
   */
  function strip(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  const code = (file: string): string => strip(readFileSync(file, 'utf8'))

  const sources = readdirSync(AI_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(AI_DIR, f))

  it('has sources to scan', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('calls no Math.random', () => {
    for (const file of sources) {
      expect({ file, found: /Math\s*\.\s*random/.test(code(file)) }).toEqual({ file, found: false })
    }
  })

  it('calls no wall clock', () => {
    for (const file of sources) {
      const src = code(file)
      expect({
        file,
        found: /Date\s*\.\s*now|new\s+Date\b|performance\s*\.\s*now/.test(src),
      }).toEqual({ file, found: false })
    }
  })

  it('strips comments without eating the code around them', () => {
    // The two scans above are only as good as this. A stripper that returned ''
    // would pass them both on any source whatsoever.
    const sample = [
      '/** Math.random in a block comment. */',
      "const kept = 'Math' // Math.random in a line comment",
      '/* multi',
      '   line Math.random */',
      "const url = 'https://example.com/not-a-comment'",
    ].join('\n')
    const out = strip(sample)
    expect(out).not.toMatch(/Math\s*\.\s*random/)
    expect(out).toContain('const kept')
    expect(out).toContain('const url')
    expect(out).toContain('https://example.com/not-a-comment')
  })
})
