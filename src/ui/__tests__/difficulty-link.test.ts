import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { difficultyLink } from '../difficulty-link'
import { menuButtons } from '../menu-buttons'

/**
 * Ticket 095 — the way into hard mode, and back out of it.
 *
 * Ticket 093 put hard mode behind `?hard=1` and nothing in the game says so, so
 * the only way to find it is to be told. This is the telling.
 *
 * THE DECISION IS DATA FOR THE REASON `menu-buttons.ts` GIVES AT LENGTH: the
 * menu's rules "have now been wrong twice in a file nothing can import", because
 * `menu.ts` builds `div`s and `vitest.config.ts` sets `environment: 'node'`. A
 * label and an href chosen inline would be checked by opening the screen and
 * reading it, which is exactly how the last two got in.
 */

const fresh = () => menuButtons({ campaignOver: false, campaignUnderway: false, graves: 0 })
const underway = () => menuButtons({ campaignOver: false, campaignUnderway: true, graves: 3 })
const over = () => menuButtons({ campaignOver: true, campaignUnderway: false, graves: 7 })

describe('it appears exactly where there is one button', () => {
  it('on a fresh campaign — the first visit', () => {
    expect(fresh()).toHaveLength(1)
    expect(difficultyLink(fresh(), 'normal')).not.toBeNull()
  })

  it('and on a finished one, which also offers a single button', () => {
    /**
     * A DELIBERATE CONSEQUENCE OF ASKING THE BUTTONS RATHER THAN THE CAMPAIGN.
     * Both one-button screens are a player about to BEGIN a run, which is the
     * only coherent moment to change difficulty, so this is the right answer for
     * the right reason rather than an accident worth suppressing.
     */
    expect(over()).toHaveLength(1)
    expect(difficultyLink(over(), 'normal')).not.toBeNull()
  })

  it('but NOT on a campaign in progress', () => {
    // Two buttons, and a run already carrying its dead. Flipping the difficulty
    // here would change the game under a squad half-way through it.
    expect(underway()).toHaveLength(2)
    expect(difficultyLink(underway(), 'normal')).toBeNull()
    expect(difficultyLink(underway(), 'hard')).toBeNull()
  })
})

describe('and the rule follows the BUTTONS, not a second copy of their condition', () => {
  it('so any single-button list gets a link and any longer one does not', () => {
    /**
     * THE ASSERTION THAT FAILS IF THE RULE IS REWRITTEN AS `!campaignUnderway`.
     * That expression picks out the same screens today and is a second spelling
     * of a decision `menu-buttons.ts` owns; the two would disagree the first
     * time a button is added to either one-button screen, and the link would
     * appear beside two buttons with nothing to say why.
     *
     * Fed a list that no `MenuModel` produces, precisely so it cannot be
     * satisfied by reading the campaign state instead.
     */
    const one = [{ action: 'start' as const, label: 'Anything', confirms: false }]
    const two = [...one, { action: 'reset' as const, label: 'Another', confirms: true }]
    const three = [...two, { action: 'start' as const, label: 'A third', confirms: false }]
    expect(difficultyLink(one, 'normal')).not.toBeNull()
    expect(difficultyLink(two, 'normal')).toBeNull()
    expect(difficultyLink(three, 'normal')).toBeNull()
    expect(difficultyLink([], 'normal')).toBeNull()
  })
})

describe('what it says and where it goes', () => {
  it('offers HARD to a player on the normal game', () => {
    expect(difficultyLink(fresh(), 'normal')).toEqual({
      label: 'Switch to HARD mode',
      href: '?hard=1',
    })
  })

  it('and EASY to a player already in hard mode', () => {
    /**
     * "EASY" AND NOT "NORMAL", which is the one place the two vocabularies meet.
     * The engine's default difficulty IS `normal` and calling it easy in
     * `weapons.ts` would misdescribe the shipped game — but a player looking for
     * the way out of hard mode wants the word he would use, and "Switch to
     * NORMAL mode" reads like a settings screen rather than a relief.
     */
    expect(difficultyLink(fresh(), 'hard')).toEqual({
      label: 'Switch to EASY mode',
      href: '/',
    })
  })

  it('and the two are genuinely different, in both fields', () => {
    // A single assertion that fails if the label is switched and the href is
    // not, which is the plausible half-done version.
    const easy = difficultyLink(fresh(), 'normal')
    const hard = difficultyLink(fresh(), 'hard')
    expect(easy?.label).not.toBe(hard?.label)
    expect(easy?.href).not.toBe(hard?.href)
  })

  it('and `?hard=1` is exactly what `difficultyFromSearch` accepts', () => {
    /**
     * THE CONTRACT BETWEEN THIS LINK AND TICKET 093'S PARSER, which is strict:
     * `?hard=true` and `?hard` both mean normal. A link that pointed at either
     * would look right, navigate, and silently leave the player on the easy
     * game — no error, and nothing else in the suite would notice.
     */
    const href = difficultyLink(fresh(), 'normal')?.href ?? ''
    expect(new URLSearchParams(href).get('hard')).toBe('1')
  })
})

describe('and the menu actually draws it', () => {
  const menu = (): string => readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')

  /**
   * `menu.ts` with its comments removed.
   *
   * A BLUNT `toContain` CANNOT TELL CODE FROM PROSE, and the first draft of the
   * `window.location` case below failed on the doc comment EXPLAINING why the
   * difficulty is handed in — a guard that forbids describing the rule it
   * enforces. Stripping first keeps the assertion about what the file DOES.
   */
  const menuCode = (): string =>
    menu()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('asks the function rather than deciding inline', () => {
    // Nothing in a node environment can mount this screen, so the wiring is read.
    expect(menu()).toContain('difficultyLink')
  })

  it('and CALLS it with the buttons, rather than calling it and dropping the answer', () => {
    /**
     * THE GAP MUTATION TESTING FOUND, and it is the failure this project has
     * shipped before: `?demo=1&level=N` is parsed by code nothing calls. Every
     * other case here passes against a `menu.ts` that computes the link and then
     * assigns `null` over it — the function is imported, an anchor is built, the
     * assignments are all present, and the link simply never appears.
     *
     * So the CALL is asserted, with its real arguments. `offered` is the button
     * list, which is also the ticket's central design claim: the "only one
     * button" rule is asked of the buttons rather than restated from the
     * campaign state, and a call passing the model instead fails here.
     */
    expect(menuCode()).toMatch(/difficultyLink\(\s*offered\s*,\s*next\.difficulty\s*\)/)
  })

  it('and puts BOTH halves of the answer on the element', () => {
    // A label written without an href is a link to nowhere; an href without a
    // label is an empty one. Both assignments must read from what it returned.
    const code = menuCode()
    expect(code).toMatch(/\.href\s*=\s*\w+\.href/)
    expect(code).toMatch(/setText\(\w+,\s*\w+\.label\)/)
  })

  it('and builds an ANCHOR, because the difficulty needs a page load', () => {
    /**
     * `main.ts` resolves the difficulty ONCE at boot — deliberately, so it cannot
     * change between missions of one campaign — so a click handler that flipped a
     * variable would change precisely nothing. The reload is the mechanism, and
     * an anchor with a real `href` is the plainest way to say it.
     */
    const source = menu()
    expect(source).toMatch(/createElement\('a'\)/)
    expect(source).toMatch(/\.href\s*=/)
  })

  it('and takes the difficulty from the model rather than reading the address bar', () => {
    /**
     * `src/ui` must not reach for `window.location`: it is the layer the node
     * suite can only read, and a screen that sourced its own difficulty could
     * disagree with the one `main.ts` handed the session. One value, resolved at
     * boot, passed down.
     */
    expect(menuCode()).not.toContain('window.location')
    // And the guard is not vacuous: the phrase IS present, in the comment that
    // explains the rule.
    expect(menu()).toContain('window.location')
  })
})
