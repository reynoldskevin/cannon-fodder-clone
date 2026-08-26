import { describe, it, expect } from 'vitest'
import { SCREENS, SCREEN_VIEWS, VIEWS, viewFor } from '../index'
import type { Screen } from '../index'

/**
 * Ticket 022b — which screens cover the game, as data.
 *
 * THE ROUTER'S ONLY DECISION, PULLED OUT OF THE ROUTER. `main.ts` mounts one
 * screen at a time and disposes the last; `src/ui` has no tests and cannot have
 * any, so a mapping written as a chain of `if`s inside that function is a
 * mapping nothing checks. A screen with no view is a black page over a running
 * mission, and the player's only way out is a reload.
 *
 * IT IS NOT 1:1 WITH `Screen`, WHICH IS WHY IT IS A TABLE AND NOT A NAME.
 * `Mission` maps to `null`: the canvas is always mounted, and being "on" the
 * Mission screen is the ABSENCE of an overlay over it rather than the presence
 * of one. Every other screen covers the game. That distinction is the whole
 * content of this table — spell it as `view = screen.toLowerCase()` and the
 * router would dutifully mount a "mission" overlay over the mission.
 *
 * The same bargain the transition table makes: plain data, JSON
 * round-trippable, no behaviour in a row. See `transitions.ts`.
 */

describe('every screen knows what it mounts', () => {
  it('the table is total over SCREENS', () => {
    /**
     * `Record<Screen, …>` already makes an omission a compile error, and this is
     * the runtime half of the same claim — because the compiler checks the
     * table against the `Screen` UNION while the router iterates `SCREENS`, and
     * those are two different things that a careless edit can put out of step.
     */
    expect(Object.keys(SCREEN_VIEWS).sort()).toEqual([...SCREENS].sort())
  })

  it('and nothing is mapped that is not a screen', () => {
    // The other direction. A stale key left behind by a renamed screen is a
    // view nothing can ever mount, which reads in review as coverage.
    for (const key of Object.keys(SCREEN_VIEWS)) {
      expect({ key, known: SCREENS.some((s) => s === key) }).toEqual({ key, known: true })
    }
  })

  it('exactly one screen mounts no overlay, and it is the Mission', () => {
    /**
     * STATED AS A COUNT, not just as `SCREEN_VIEWS.Mission === null`. The failure
     * this catches is a second screen quietly mapped to `null` — the player
     * lands on a Debrief that renders nothing, sees the mission still on screen
     * behind it, and has no button to press.
     */
    const uncovered = SCREENS.filter((s) => SCREEN_VIEWS[s] === null)
    expect(uncovered).toEqual(['Mission'])
  })

  it('every other screen names a distinct view', () => {
    // Two screens sharing a view id would make the router mount the same panel
    // for both, and the one that lost would be unreachable — a softlock that
    // type-checks, which is the same failure `Screen` being a closed union
    // exists to prevent.
    const named = SCREENS.map((s) => SCREEN_VIEWS[s]).filter((v) => v !== null)
    expect(new Set(named).size).toBe(named.length)
    expect(named).toHaveLength(SCREENS.length - 1)
  })

  it('VIEWS lists exactly the ids the table uses', () => {
    const used = new Set(SCREENS.map((s) => SCREEN_VIEWS[s]).filter((v) => v !== null))
    expect([...VIEWS].sort()).toEqual([...used].sort())
  })
})

describe('viewFor is the reading the router does', () => {
  it('answers for every screen', () => {
    for (const screen of SCREENS) {
      expect({ screen, view: viewFor(screen) }).toEqual({ screen, view: SCREEN_VIEWS[screen] })
    }
  })

  it('refuses an unknown screen with null rather than undefined', () => {
    /**
     * The router branches on `null` to mean "show the game". An unknown screen —
     * a typo'd string from a handler, the same case `advance` refuses rather
     * than throwing — must not fall through to `undefined` and be treated as a
     * mission by a truthiness check, because that would strip the overlay off a
     * screen the game is not actually on.
     */
    expect(viewFor('Nowhere' as Screen)).toBeNull()
    expect(viewFor(undefined as unknown as Screen)).toBeNull()
  })
})

describe('the table is data, like every other table in core', () => {
  it('survives a JSON round trip unchanged', () => {
    // The bargain `transitions.ts`, `ranks.ts`, `weapons.ts` and `ordnance/table.ts`
    // all make: a row carries no behaviour, so a later ticket can read these out
    // of a document without a line of code changing.
    expect(JSON.parse(JSON.stringify(SCREEN_VIEWS))).toEqual(SCREEN_VIEWS)
  })

  it('holds no function and no undefined', () => {
    for (const screen of SCREENS) {
      const view = SCREEN_VIEWS[screen]
      expect({ screen, ok: view === null || typeof view === 'string' }).toEqual({
        screen,
        ok: true,
      })
    }
  })
})
