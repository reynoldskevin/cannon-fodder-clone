import { describe, it, expect } from 'vitest'
import {
  advance,
  campaignComplete,
  isMissionExit,
  resolveEntry,
  EVENTS,
  INITIAL_SCREEN,
  SCREENS,
  TRANSITIONS,
} from '../index'
import { applyMissionReport, createCampaign } from '../../campaign'
import type { FlowEvent, Screen } from '../index'

/**
 * Ticket 020 — the screen flow.
 *
 * A TABLE, NOT A SWITCH. `TRANSITIONS` is data, and a sibling test asserts it
 * against the state chart in `ARCHITECTURE_DIAGRAM.md`. A `switch` would be a
 * second place the chart is written down, and the two would diverge on the first
 * screen anybody adds — which is exactly the drift the diagram is supposed to
 * prevent, arriving through the code instead.
 *
 * THE MACHINE HOLDS NOTHING. No campaign, no session, no screens: `advance` is a
 * function of a screen name and an event. Fusing it with the roster would make
 * every transition case here need a squad, and fusing it with the DOM would make
 * none of them runnable at all — `src/ui` has no tests because there is no DOM
 * under Node, which is precisely why the decisions live out here.
 */

/** Every transition the table claims, as `from --event--> to`. */
const rows = (): readonly { from: Screen; event: FlowEvent; to: Screen }[] => TRANSITIONS

describe('the table itself', () => {
  it('has rows', () => {
    // Otherwise every sweep below is vacuously true.
    expect(TRANSITIONS.length).toBeGreaterThan(0)
  })

  it('starts at the menu', () => {
    expect(INITIAL_SCREEN).toBe('Menu')
    expect(SCREENS).toContain('Menu')
  })

  it('names only screens it declares', () => {
    for (const row of rows()) {
      expect({ row: `${row.from}->${row.to}`, known: SCREENS.includes(row.from) && SCREENS.includes(row.to) })
        .toEqual({ row: `${row.from}->${row.to}`, known: true })
    }
  })

  it('names only events it declares', () => {
    for (const row of rows()) {
      expect({ event: row.event, known: EVENTS.includes(row.event) }).toEqual({
        event: row.event,
        known: true,
      })
    }
  })

  it('never gives one screen two destinations for the same event', () => {
    // A non-deterministic machine: pressing Deploy would go somewhere different
    // depending on which row was scanned first.
    const seen = new Set<string>()
    for (const row of rows()) {
      const key = `${row.from}|${row.event}`
      expect({ key, duplicate: seen.has(key) }).toEqual({ key, duplicate: false })
      seen.add(key)
    }
  })

  it('is data, and survives a JSON round-trip', () => {
    expect(JSON.parse(JSON.stringify(TRANSITIONS))).toEqual(TRANSITIONS)
  })

  it('leaves no screen a dead end', () => {
    /**
     * Every screen must have a way OUT, or the game hangs on it with no button
     * that does anything — the softlock a player reports as "it froze". `Menu`
     * is allowed to be terminal in the sense that a campaign can end there, but
     * it still has outgoing rows.
     */
    for (const screen of SCREENS) {
      expect({ screen, hasExit: rows().some((r) => r.from === screen) }).toEqual({
        screen,
        hasExit: true,
      })
    }
  })

  it('leaves no screen unreachable', () => {
    // A screen nothing can reach is dead code that looks like a feature.
    for (const screen of SCREENS) {
      if (screen === INITIAL_SCREEN) continue
      expect({ screen, reachable: rows().some((r) => r.to === screen) }).toEqual({
        screen,
        reachable: true,
      })
    }
  })
})

describe('every transition the chart promises', () => {
  const valid: readonly [Screen, FlowEvent, Screen][] = [
    ['Menu', 'startCampaign', 'BootHill'],
    ['BootHill', 'squadAssigned', 'Briefing'],
    ['Briefing', 'deploy', 'Mission'],
    ['Mission', 'missionComplete', 'BootHill'],
    ['Mission', 'missionFailed', 'Briefing'],
    ['BootHill', 'campaignComplete', 'Menu'],
    ['Menu', 'demoShortcut', 'Mission'],
  ]

  it('works, one by one', () => {
    for (const [from, event, to] of valid) {
      const result = advance(from, event)
      expect({ from, event, got: result.ok ? result.state : `REFUSED: ${result.reason}` }).toEqual({
        from,
        event,
        got: to,
      })
    }
  })

  it('and the table contains exactly these and no others', () => {
    // The other direction. Without it, a table with a tenth secret row — a
    // Debrief that skips Boot Hill, say — passes everything above.
    const actual = rows()
      .map((r) => `${r.from}|${r.event}|${r.to}`)
      .sort()
    const expected = valid.map(([f, e, t]) => `${f}|${e}|${t}`).sort()
    expect(actual).toEqual(expected)
  })

  const walk = (from: Screen, events: readonly FlowEvent[]): Screen => {
    let screen = from
    for (const event of events) {
      const result = advance(screen, event)
      if (!result.ok) throw new Error(`${screen} refused ${event}: ${result.reason}`)
      screen = result.state
    }
    return screen
  }

  it('a won mission loops back to Boot Hill for the next one', () => {
    // The cycle a player actually walks, end to end, rather than isolated hops
    // that happen to join up on paper.
    expect(
      walk(INITIAL_SCREEN, ['startCampaign', 'squadAssigned', 'deploy', 'missionComplete']),
    ).toBe('BootHill')
  })

  it('and from there straight into the next briefing', () => {
    expect(
      walk(INITIAL_SCREEN, [
        'startCampaign',
        'squadAssigned',
        'deploy',
        'missionComplete',
        'squadAssigned',
      ]),
    ).toBe('Briefing')
  })

  it('but a LOST mission goes back to the briefing, not to Boot Hill', () => {
    /**
     * THE ONE ASYMMETRY IN THE CHART, and the reason it is written down twice.
     *
     * A defeat means the level was not finished — no ground taken, no
     * replacements due — so routing it through Boot Hill would promote a fresh
     * squad for a mission about to be retried. The briefing is also the screen
     * that says what the mission IS, which is what somebody who has just failed
     * it wants to read again.
     */
    expect(walk('Mission', ['missionFailed'])).toBe('Briefing')
  })

  it('and a retry can be lost again, forever, without leaving the loop', () => {
    // The retry has to be a LOOP, not a one-off concession. A chart that let a
    // player fail once and then stranded them is worse than one that never
    // offered the retry.
    expect(walk('Mission', ['missionFailed', 'deploy', 'missionFailed', 'deploy'])).toBe('Mission')
  })

  it('and Boot Hill is still the way out of the campaign', () => {
    expect(walk(INITIAL_SCREEN, ['startCampaign', 'campaignComplete'])).toBe('Menu')
  })
})

describe('the screens this flow no longer has', () => {
  it('does not name Recruitment or Debrief anywhere', () => {
    /**
     * REMOVED FROM THE UNION, NOT LEFT UNREACHABLE. A screen with no row is a
     * dead state the runner must still answer about, and `SCREENS`, `EVENTS` and
     * the view table would all go on describing a game that no longer exists —
     * which is the drift `diagram.test.ts` exists to prevent, arriving through
     * the front door instead.
     *
     * Two things go with them and neither should vanish quietly: manual squad
     * picking, and the post-mission summary. Boot Hill is the right home for the
     * summary — a memorial that does not name the men who just died is not doing
     * its job — but that is its own ticket.
     */
    expect(SCREENS).not.toContain('Recruitment')
    expect(SCREENS).not.toContain('Debrief')
    for (const row of rows()) {
      expect({ row: `${row.from}->${row.to}`, ok: true }).toEqual({
        row: `${row.from}->${row.to}`,
        ok: !`${row.from}${row.to}`.includes('Recruitment'),
      })
    }
  })

  it('and no longer declares the events that only they used', () => {
    // `casualtiesRecorded` and `nextLevel` were Debrief's and Boot Hill's rows
    // into Recruitment. An event left in `EVENTS` with no row is a button the
    // machine will always refuse.
    expect(EVENTS).not.toContain('casualtiesRecorded')
    expect(EVENTS).not.toContain('nextLevel')
  })
})

describe('an invalid transition is refused, not ignored', () => {
  it('refuses an event the screen has no row for', () => {
    const result = advance('BootHill', 'deploy')
    expect(result.ok).toBe(false)
  })

  it('says why', () => {
    /**
     * SILENCE IS THE FAILURE MODE HERE. A machine that returned the state
     * unchanged produces a dead button — the player presses Deploy on the
     * Debrief screen, nothing happens, and there is nothing to log or show. A
     * reason is what turns that into something diagnosable.
     */
    const result = advance('BootHill', 'deploy')
    if (result.ok) throw new Error('expected a refusal')
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(10)
  })

  it('refuses every pairing the table does not name', () => {
    // The exhaustive sweep: every screen against every event, minus the nine
    // the chart promises. Anything else accepted is a transition nobody
    // designed.
    const allowed = new Set(rows().map((r) => `${r.from}|${r.event}`))
    const wrongly: string[] = []
    for (const from of SCREENS) {
      for (const event of EVENTS) {
        if (allowed.has(`${from}|${event}`)) continue
        if (advance(from, event).ok) wrongly.push(`${from}|${event}`)
      }
    }
    expect(wrongly).toEqual([])
  })

  it('never throws, because a double-clicked button is ordinary traffic', () => {
    // A stray event is expected, not a programming error. Throwing here would
    // take the game down on an impatient click.
    for (const from of SCREENS) {
      for (const event of EVENTS) {
        expect(() => advance(from, event)).not.toThrow()
      }
    }
  })

  it('survives an event that is not an event at all', () => {
    // The screens are DOM, and a handler can be wired to a typo'd string.
    for (const rubbish of ['', 'deploy ', 'DEPLOY', 'nonsense']) {
      const result = advance('Menu', rubbish as FlowEvent)
      expect({ rubbish, ok: result.ok }).toEqual({ rubbish, ok: false })
    }
  })

  it('survives a screen that is not a screen at all', () => {
    const result = advance('Nowhere' as Screen, 'deploy')
    expect(result.ok).toBe(false)
  })
})

describe('the injected entry state', () => {
  it('defaults to the menu', () => {
    expect(resolveEntry(undefined)).toBe(INITIAL_SCREEN)
  })

  it('accepts any screen the machine knows', () => {
    for (const screen of SCREENS) {
      expect({ screen, resolved: resolveEntry(screen) }).toEqual({ screen, resolved: screen })
    }
  })

  it('refuses a screen that does not exist, rather than starting nowhere', () => {
    /**
     * A DEEP LINK IS A URL A STRANGER CAN TYPE. Ticket 029's `?demo=1&level=N`
     * feeds this, so the value arrives from outside the program entirely.
     * Starting the machine in a state with no outgoing rows is a game that
     * opens to a screen with no working buttons.
     */
    for (const rubbish of ['Nowhere', '', 'menu', 'MISSION', '../Menu', 'Mission ']) {
      expect({ rubbish, resolved: resolveEntry(rubbish) }).toEqual({
        rubbish,
        resolved: INITIAL_SCREEN,
      })
    }
  })

  it('refuses things that are not strings', () => {
    for (const rubbish of [null, 42, {}, [], true]) {
      expect({
        rubbish: JSON.stringify(rubbish) ?? 'undefined',
        resolved: resolveEntry(rubbish),
      }).toEqual({ rubbish: JSON.stringify(rubbish) ?? 'undefined', resolved: INITIAL_SCREEN })
    }
  })

  it('whatever it resolves to can always be left', () => {
    // The property that actually matters: an entry state is only useful if the
    // player can get out of it.
    for (const rubbish of ['Nowhere', 'Mission', 'BootHill', null]) {
      const screen = resolveEntry(rubbish)
      expect({ screen, hasExit: rows().some((r) => r.from === screen) }).toEqual({
        screen,
        hasExit: true,
      })
    }
  })
})

describe('leaving a mission', () => {
  it('is true for the transitions that end one', () => {
    /**
     * The pure half of "mission teardown fully disposes Three.js resources".
     * The counting is a manual e2e — there is no GPU under Node — but WHICH
     * transitions must release resources is a decision, and a decision belongs
     * where it can be tested. `main.ts` calls `teardown()` on this predicate.
     */
    expect(isMissionExit('Mission', 'Debrief')).toBe(true)
  })

  it('is false for transitions that never touched a mission', () => {
    expect(isMissionExit('Menu', 'Recruitment')).toBe(false)
    expect(isMissionExit('Debrief', 'BootHill')).toBe(false)
    expect(isMissionExit('BootHill', 'Recruitment')).toBe(false)
  })

  it('is false for entering a mission', () => {
    // Tearing down on the way IN would dispose the level that was just built.
    expect(isMissionExit('Briefing', 'Mission')).toBe(false)
    expect(isMissionExit('Menu', 'Mission')).toBe(false)
  })

  it('covers every way out of a mission the table allows', () => {
    // Five levels in a session with one exit path unreleased is the leak the
    // acceptance criterion is about, and it would be invisible on the path
    // anybody tests by hand.
    for (const row of rows()) {
      if (row.from !== 'Mission') continue
      expect({ exit: `${row.from}->${row.to}`, releases: isMissionExit(row.from, row.to) }).toEqual({
        exit: `${row.from}->${row.to}`,
        releases: true,
      })
    }
  })
})

describe('when the campaign is over', () => {
  it('is not over while levels remain', () => {
    expect(campaignComplete(3, 5)).toBe(false)
  })

  it('is over once the last one is beaten', () => {
    /**
     * `CampaignState.unlockedLevels` COUNTS, and has no idea how many levels
     * exist — beat level 5 of 5 and it reports 6, which is right for a counter
     * and meaningless as a progression. So the comparison lives here, where a
     * level count can be supplied, rather than teaching the roster what a
     * campaign is.
     */
    expect(campaignComplete(6, 5)).toBe(true)
  })

  it('is NOT over when the last level is merely unlocked', () => {
    /**
     * THE BOUNDARY THE WHOLE COMPARISON TURNS ON, and the first draft never
     * asserted it. Walked through a real campaign: beating level 4 of 5 sets
     * `unlockedLevels` to 5 — the final mission is now available and has not
     * been played. `>=` here would declare the campaign over at that moment and
     * the player would NEVER PLAY THE LAST LEVEL, with the suite green.
     *
     * Every other case in this block sits comfortably to one side or the other,
     * which is exactly why none of them can see it.
     */
    expect(campaignComplete(5, 5)).toBe(false)
  })

  it('and is over only once it has actually been beaten', () => {
    expect(campaignComplete(6, 5)).toBe(true)
  })

  it('the same boundary, walked rather than asserted', () => {
    // Against the real roster, so a change to how `unlockedLevels` counts cannot
    // quietly move the finish line without this failing too.
    const total = 5
    let state = createCampaign({ seed: 1, recruits: 3 })
    const answers: boolean[] = []
    for (let level = 1; level <= total; level += 1) {
      state = applyMissionReport(state, { levelId: level, outcome: 'complete', entries: [] })
      answers.push(campaignComplete(state.unlockedLevels, total))
    }
    expect(answers).toEqual([false, false, false, false, true])
  })

  it('is over if the counter somehow ran past the end', () => {
    expect(campaignComplete(99, 5)).toBe(true)
  })

  it('is not over on a fresh campaign', () => {
    expect(campaignComplete(1, 5)).toBe(false)
  })

  it('survives a nonsense level count rather than declaring victory', () => {
    // A caller that fails to load its level list must not be told the player
    // has won.
    for (const total of [0, -1, Number.NaN]) {
      expect({ total: String(total), over: campaignComplete(1, total) }).toEqual({
        total: String(total),
        over: false,
      })
    }
  })
})
