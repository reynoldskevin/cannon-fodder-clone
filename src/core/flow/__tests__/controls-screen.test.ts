import { describe, it, expect } from 'vitest'
import { advance, SCREENS, EVENTS, TRANSITIONS, INITIAL_SCREEN, SCREEN_VIEWS } from '../index'
import type { Screen } from '../index'

/**
 * Ticket 074 — the controls card joins the chart.
 *
 * A NEW SCREEN AND NOT A PANEL THE MENU OPENS. Nothing in the game says how to
 * play it; `instructions.png` is the card that does. Putting it behind a flag
 * inside `menu.ts` would hide a piece of the campaign's flow in the one layer
 * `environment: 'node'` cannot test, and `viewFor` would go on reporting the
 * Menu while the player looked at something else.
 *
 * THE INTERESTING FAILURE IS THE ROW THAT MUST BE DELETED, not the two being
 * added. `advance` returns the FIRST row matching a screen and an event, so a
 * table that kept `Menu -> BootHill` alongside `Menu -> Controls` would satisfy
 * every case about the new screen and ship a card no player ever reaches.
 */

describe('Start goes to the controls card, not to the hill', () => {
  it('the Menu leads to Controls', () => {
    expect(advance('Menu', 'startCampaign')).toEqual({ ok: true, state: 'Controls' })
  })

  it('and the card leads on to Boot Hill', () => {
    expect(advance('Controls', 'controlsAcknowledged')).toEqual({ ok: true, state: 'BootHill' })
  })

  it('and the Menu can NO LONGER reach Boot Hill in one move', () => {
    /**
     * THE DELETED ROW, ASSERTED AGAINST THE TABLE ITSELF rather than through
     * `advance`. Checking only that `startCampaign` lands on Controls would pass
     * with the old row still present but second — the card would be unreachable
     * and every other case here would stay green.
     */
    const direct = TRANSITIONS.filter((row) => row.from === 'Menu' && row.to === 'BootHill')
    expect(direct).toEqual([])
  })

  it('so the shortest way to the hill is two moves, and it is through the card', () => {
    let screen: Screen = INITIAL_SCREEN
    for (const event of ['startCampaign', 'controlsAcknowledged'] as const) {
      const result = advance(screen, event)
      if (!result.ok) throw new Error(`${screen} refused ${event}: ${result.reason}`)
      screen = result.state
    }
    expect(screen).toBe('BootHill')
  })
})

describe('and the card is a door, not a room with one way in', () => {
  it('every screen can be reached from the start', () => {
    /**
     * A SCREEN NOTHING LEADS TO IS THE FAILURE THIS TICKET COULD INTRODUCE — an
     * arm in the router, a view in the table, and no route. Walked from
     * `INITIAL_SCREEN` rather than asserted per screen, so the claim is about
     * the chart a player actually traverses.
     */
    const seen = new Set<Screen>([INITIAL_SCREEN])
    const queue: Screen[] = [INITIAL_SCREEN]
    while (queue.length > 0) {
      const at = queue.shift()
      if (at === undefined) break
      for (const event of EVENTS) {
        const result = advance(at, event)
        if (!result.ok || seen.has(result.state)) continue
        seen.add(result.state)
        queue.push(result.state)
      }
    }
    expect([...seen].sort()).toEqual([...SCREENS].sort())
  })

  it('and no screen is a dead end', () => {
    // Controls with no way out would be a softlock that type-checks: the player
    // reads the card and the only escape is a reload.
    for (const screen of SCREENS) {
      const exits = TRANSITIONS.filter((row) => row.from === screen)
      expect({ screen, hasExit: exits.length > 0 }).toEqual({ screen, hasExit: true })
    }
  })

  it('and the card refuses everything except the one event that leaves it', () => {
    /**
     * NOT A SECOND MENU. `squadAssigned` from here would skip Boot Hill and
     * `deploy` would launch a mission with no briefing and no squad — both are
     * events that exist and both would be plausible typos in a router arm.
     */
    const allowed = EVENTS.filter((event) => advance('Controls', event).ok)
    expect(allowed).toEqual(['controlsAcknowledged'])
  })
})

describe('the demo shortcut still skips everything', () => {
  it('goes straight from the Menu to the Mission', () => {
    /**
     * THE ONE PATH THAT EXISTS TO SKIP CLICKS must not gain one. `?demo=1` is
     * how the game is opened on a level during development, and routing it
     * through a controls card would put an instruction screen in front of the
     * person who least needs it.
     */
    expect(advance('Menu', 'demoShortcut')).toEqual({ ok: true, state: 'Mission' })
  })

  it('and the card is not on that route at all', () => {
    const viaControls = TRANSITIONS.filter(
      (row) => row.from === 'Controls' && row.to === 'Mission',
    )
    expect(viaControls).toEqual([])
  })
})

describe('and the router can mount it', () => {
  it('Controls names a view rather than the canvas', () => {
    /**
     * `null` MEANS "THE MISSION IS THE SCREEN" and would mean, here, a black
     * page with no card and no button — the exact failure `views.ts` was pulled
     * out of the router to prevent. Stated for this screen by name because the
     * sibling test asserts only that the uncovered set is `['Mission']`, which a
     * future edit could widen.
     */
    expect(SCREEN_VIEWS.Controls).toBe('controls')
  })
})
