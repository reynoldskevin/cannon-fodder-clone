import { describe, it, expect } from 'vitest'
import { BACK_TO_BASE_LABEL, BACK_TO_BASE_STYLE, DEPLOY_LABEL, DEPLOY_STYLE } from '../briefing'
import { DISPLAY_FONT } from '../display-font'

/**
 * Ticket 059 — the Briefing's second button, and why it is SMALLER.
 *
 * The card's own button is the mission: GO FOR IT, set at the card's heading
 * size and last in the box, exactly as the original does it. BACK TO BASE is the
 * way out of a screen the player did not mean to be on — a secondary action, and
 * a secondary action drawn at the same weight as the primary one turns a card
 * with an obvious next step into a fork.
 *
 * WHY THESE ARE STRING ASSERTIONS AND NOT DOM ONES, for the third time in this
 * directory. `vitest.config.ts` sets `environment: 'node'`, there is no jsdom,
 * and every file in `src/ui` calls `document.createElement` on its first line.
 * `screen-chrome.test.ts` set the pattern and `mission-banner.test.ts` followed
 * it: the DECISIONS come out as exported strings that can be imported and read,
 * while the DOM calls stay inside the factory.
 *
 * WHAT THAT LEAVES UNTESTED IS NAMED IN THE TICKET AND WORTH REPEATING HERE: the
 * click ROUTING — that a press on BACK TO BASE does not also deploy — is a fact
 * about one listener on a backdrop, and no assertion in this file can reach it.
 * It is the sharp edge of this ticket and it is checked by eye.
 */

/** `a:b;c:d` -> `{a:'b', c:'d'}`, so a case asks about a property. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of css.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

/**
 * The `rem` ceiling out of a `clamp(min, preferred, max)`.
 *
 * BOTH SIZES ARE CLAMPS, so "smaller" has to be compared at a defined point
 * rather than between two strings. The upper bound is the one the player sees on
 * anything but a phone, and comparing the mins instead would let a back button
 * that overtakes GO FOR IT at every real width pass.
 */
function ceilingRem(size: string | undefined): number {
  const match = /,\s*([\d.]+)rem\s*\)\s*$/.exec(size ?? '')
  if (match === null) throw new Error(`not a clamp ending in rem: ${String(size)}`)
  return Number(match[1])
}

const deploy = declarations(DEPLOY_STYLE)
const back = declarations(BACK_TO_BASE_STYLE)

describe('the words on them', () => {
  it('say what the player asked them to say', () => {
    expect(BACK_TO_BASE_LABEL).toBe('BACK TO BASE')
  })

  it('and the mission button is untouched', () => {
    // The card's voice is the original's and this ticket has no business
    // changing it. Pinned so a later edit to the shared styling cannot.
    expect(DEPLOY_LABEL).toBe('GO FOR IT')
  })
})

describe('BACK TO BASE is the smaller of the two', () => {
  it('measurably, at the size a desktop actually renders', () => {
    expect(ceilingRem(back.get('font-size'))).toBeLessThan(ceilingRem(deploy.get('font-size')))
  })

  it('and at the small end too, so it is never the larger one', () => {
    /**
     * TWO CLAMPS CAN CROSS. A back button whose minimum sits above GO FOR IT's
     * would be smaller on a monitor and BIGGER on a phone — which is precisely
     * the bug a single-width check waves through, and phones are where the
     * clamp's lower bound is what renders.
     */
    const floorRem = (size: string | undefined): number => {
      const match = /^clamp\(\s*([\d.]+)rem/.exec(size ?? '')
      if (match === null) throw new Error(`not a clamp starting in rem: ${String(size)}`)
      return Number(match[1])
    }
    expect(floorRem(back.get('font-size'))).toBeLessThan(floorRem(deploy.get('font-size')))
  })

  it('and quieter, not just smaller', () => {
    /**
     * `MUTED` IS THE SECONDARY COLOUR AND `TEXT` THE PRIMARY ONE. Size alone
     * would still read as a second call to action; the point of a secondary
     * action is that the eye passes over it on the way to the real one.
     */
    expect(back.get('color')).not.toBe(deploy.get('color'))
  })
})

describe('and it is still part of the same screen', () => {
  it('set in the display face, like everything else on the card', () => {
    expect(back.get('font-family')).toBe(DISPLAY_FONT)
  })

  it('and carries no chrome of its own', () => {
    /**
     * NO BORDER AND NO FILL, matching GO FOR IT. `createButton` ships a pill
     * with a border, and `briefing.ts` deliberately strips it — the mockup's
     * card has no boxes inside it, and a bordered button under the card would
     * put back the chrome the whole screen was built without.
     */
    expect(back.get('border')).toBe('none')
    expect(back.get('background')).toBe('transparent')
  })

})
