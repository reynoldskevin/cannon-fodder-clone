import { describe, it, expect } from 'vitest'
import { menuButtons, type MenuButtonModel } from '../menu-buttons'

/**
 * Ticket 077 — which buttons the Menu offers, and what pressing one does.
 *
 * A TABLE RATHER THAN A CHAIN OF `if`s IN `menu.ts`, because this rule has now
 * been wrong twice in a file `environment: 'node'` cannot import. The screen
 * offered "Play again (keeps Boot Hill)" on a finished campaign, which issued
 * `startCampaign` and walked Menu -> Controls -> BootHill -> Menu: three clicks
 * back to the very screen it was pressed on, because `advanceFromBootHill` reads
 * a finished campaign and fires `campaignComplete`. Nothing failed anywhere; the
 * game simply did not move.
 */

const state = (over: readonly ['fresh' | 'underway' | 'over', number]): MenuButtonModel => ({
  campaignOver: over[0] === 'over',
  campaignUnderway: over[0] !== 'fresh',
  graves: over[1],
})

describe('the memorial offers one way out, and it works', () => {
  const buttons = menuButtons(state(['over', 4]))

  it('exactly one button', () => {
    // Two was the bug: a dead "Play again" beside a live "Start over", and the
    // dead one read like the primary action.
    expect(buttons.length).toBe(1)
  })

  it('called Play again', () => {
    expect(buttons[0]?.label).toBe('Play again')
  })

  it('and it RESETS rather than starting the finished campaign again', () => {
    /**
     * THE WHOLE TICKET, IN ONE ASSERTION. `start` from a finished campaign is
     * the closed loop — the chart cannot get anywhere from a Boot Hill whose
     * campaign is over except back to the Menu. `reset` is the only command that
     * produces a campaign with a level left in it.
     */
    expect(buttons[0]?.action).toBe('reset')
  })

  it('and needs no second press, because nothing is left to protect', () => {
    // The confirmation exists to save a LIVE campaign from a misclick. Here the
    // campaign is over, the memorial is the reward, and a player who reached
    // this screen and pressed the only button meant it.
    expect(buttons[0]?.confirms).toBe(false)
  })
})

describe('a campaign in progress keeps both, and keeps its guard', () => {
  const buttons = menuButtons(state(['underway', 7]))

  it('offers Continue and a wipe, in that order', () => {
    expect(buttons.map((b) => b.action)).toEqual(['start', 'reset'])
    expect(buttons[0]?.label).toBe('Continue campaign')
  })

  it('and the wipe still takes two presses', () => {
    /**
     * NOT RELAXED ALONGSIDE THE MEMORIAL'S. This is the case the confirmation
     * was built for: a live campaign, a hill full of stones, and a destructive
     * button sitting beside the one the player actually wants. Ticket 077
     * removes the confirmation exactly where it guards nothing and nowhere else.
     */
    expect(buttons[1]?.confirms).toBe(true)
  })

  it('and says how many graves it would erase', () => {
    expect(buttons[1]?.label).toBe('Start over (erases 7 graves)')
  })

  it('and does not claim graves it has not got', () => {
    const noDead = menuButtons(state(['underway', 0]))
    expect(noDead[1]?.label).toBe('Start over')
  })
})

describe('a fresh campaign is offered nothing to destroy', () => {
  const buttons = menuButtons(state(['fresh', 0]))

  it('just Start', () => {
    /**
     * A GREYED-OUT WIPE WOULD STILL TELL A FIRST-TIME PLAYER that this screen
     * can destroy something of his, which is a question he does not have yet.
     * The control is simply not there until he has a campaign.
     */
    expect(buttons.map((b) => b.action)).toEqual(['start'])
    expect(buttons[0]?.label).toBe('Start campaign')
  })
})

describe('and no state is left without a way forward', () => {
  it('every menu the game can show has at least one button', () => {
    // A menu with no buttons is a page the player cannot leave without a reload
    // — the same class of failure as the loop this ticket removes, and the one
    // an over-eager cleanup of the cases above would introduce.
    for (const kind of ['fresh', 'underway', 'over'] as const) {
      for (const graves of [0, 3]) {
        const offered = menuButtons(state([kind, graves]))
        expect({ kind, graves, count: offered.length }).toEqual({
          kind,
          graves,
          count: offered.length,
        })
        expect(offered.length).toBeGreaterThan(0)
      }
    }
  })

  it('and every button says something and does something', () => {
    for (const kind of ['fresh', 'underway', 'over'] as const) {
      for (const button of menuButtons(state([kind, 2]))) {
        expect(button.label.trim().length).toBeGreaterThan(0)
        expect(['start', 'reset']).toContain(button.action)
      }
    }
  })
})
