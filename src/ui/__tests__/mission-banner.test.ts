import { describe, it, expect } from 'vitest'
import { BANNER_LAYER_STYLE, BANNER_TEXT_STYLE } from '../mission-banner'
import { DISPLAY_FONT } from '../display-font'

/**
 * Ticket 058 — the mission-end banner is large, centred, and in the display face.
 *
 * WHY THESE ARE STRING ASSERTIONS AND NOT DOM ONES, again. `vitest.config.ts`
 * sets `environment: 'node'` and there is no jsdom, which is why `src/ui` has
 * almost no tests: every file in it calls `document.createElement` on its first
 * line. `screen-chrome.test.ts` set the pattern this follows — the MODULE BODY
 * of `mission-banner.ts` touches no DOM, so the decisions it encodes are plain
 * exported strings that can be imported and read, while the DOM call stays
 * unguarded inside the factory. Adding a DOM environment is a real dependency
 * decision and still belongs to its own ticket.
 */

/** `a:b;c:d` -> `{a:'b', c:'d'}`, so a case asks about a property, not a substring. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of css.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

const layer = declarations(BANNER_LAYER_STYLE)
const text = declarations(BANNER_TEXT_STYLE)

describe('the banner is centred on the viewport', () => {
  it('covers it, rather than sitting in the document flow', () => {
    // `mount` is the canvas's container and the banner goes over the live view,
    // so anything short of a fixed full-viewport layer would land the text
    // wherever the last element happened to leave the cursor.
    expect(layer.get('position')).toBe('fixed')
    expect(layer.get('inset')).toBe('0')
  })

  it('and centres its content on both axes', () => {
    expect(layer.get('display')).toBe('flex')
    expect(layer.get('align-items')).toBe('center')
    expect(layer.get('justify-content')).toBe('center')
  })

  it('and the words themselves are centred, so a wrapped line stays centred', () => {
    expect(text.get('text-align')).toBe('center')
  })
})

describe('and it is set in the display face, large', () => {
  it('names the display stack, not a font of its own', () => {
    /**
     * THE FACE IS `font.woff2` VIA `DISPLAY_FONT`, which is the stack every
     * other screen in the game uses and the only spelling of the family name.
     * Compared against the imported constant rather than against a literal, so
     * this cannot pass while quietly naming a different face.
     */
    expect(text.get('font-family')).toBe(DISPLAY_FONT)
  })

  it('and is bigger than any other line in the game', () => {
    /**
     * LARGE IS THE REQUIREMENT, so it is asserted as a number. The briefing's
     * own title tops out at 3.58rem and is the largest text the game had; this
     * has to beat it, and a `clamp` whose preferred term is a viewport unit is
     * how it scales without a media query.
     */
    const size = text.get('font-size')
    expect(size).toBeDefined()
    expect(size).toMatch(/^clamp\(/)
    const max = /,\s*([\d.]+)rem\s*\)/.exec(size ?? '')
    expect(max).not.toBeNull()
    expect(Number(max?.[1])).toBeGreaterThan(3.58)
  })
})

describe('and it never gets in the way of the field it is over', () => {
  it('swallows no clicks', () => {
    /**
     * A REAL BUG ON A REAL SCREEN, avoided. `briefing.ts` records that the
     * shared backdrop's `pointer-events:none` inherits into its children and
     * made its own button unclickable — the same rule is what this layer NEEDS,
     * because it sits over a live mission for three seconds and the player is
     * still holding a mouse. There is nothing on it to click.
     */
    expect(layer.get('pointer-events')).toBe('none')
  })

  it('and does not black out the field behind it', () => {
    /**
     * THE POINT OF HOLDING AT ALL. The three seconds exist so the player watches
     * the last man fall and hears the result over the ground it happened on; a
     * filled backdrop would make it an end screen that arrives three seconds
     * late instead — strictly worse than the instant cut this replaces.
     */
    expect(BANNER_LAYER_STYLE).not.toMatch(/background(-color)?\s*:/)
  })

  it('but does sit above the HUD, which is the only other thing on screen', () => {
    /**
     * A TIE IS NOT AN ANSWER. `hud.ts` is `z-index:40`, and two elements on the
     * same layer are ordered by which was appended last — which this layer wins
     * only because it is appended when shown and the HUD at boot. Pinned as a
     * number so the result stops depending on that.
     *
     * The imported HUD constant would be better than a literal, but `hud.ts`
     * builds its DOM in the module body and cannot be imported without a
     * `document` — see the header. 40 is transcribed, and this is the case that
     * fails if the two ever meet again.
     */
    const z = Number(layer.get('z-index'))
    expect(z).toBeGreaterThan(40)
    // And below a campaign screen (`screen-chrome.ts`, 60), which must cover it.
    expect(z).toBeLessThan(60)
  })

  it('though the words stay legible over whatever terrain is under them', () => {
    // Jungle, river and sand all pass under this text and none of them is a
    // reliable backdrop for a light face. The shadow is what makes the words
    // readable without a panel — see the case above for why there is no panel.
    expect(text.get('text-shadow')).toBeDefined()
  })
})
