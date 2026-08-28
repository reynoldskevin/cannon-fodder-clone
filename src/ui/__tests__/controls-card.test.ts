import { describe, it, expect } from 'vitest'
import {
  CONTROLS_TITLE,
  CONTROLS_BACKDROP_STYLE,
  CONTROLS_TITLE_STYLE,
  CONTROLS_IMAGE_STYLE,
  CONTROLS_CONTINUE_LABEL,
} from '../controls-card'
import { DISPLAY_FONT } from '../display-font'

/**
 * Ticket 074 — the controls card's look.
 *
 * STRING ASSERTIONS, for the reason every `src/ui` test gives: `vitest.config.ts`
 * sets `environment: 'node'`, there is no jsdom, and a module that touches the
 * DOM in its body cannot be imported at all. What is checkable here is what the
 * screen MEANS — its title, its face, its colour and the rules that keep the
 * button pressable — while the `document` calls stay in the factory.
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

const backdrop = declarations(CONTROLS_BACKDROP_STYLE)
const title = declarations(CONTROLS_TITLE_STYLE)
const image = declarations(CONTROLS_IMAGE_STYLE)

describe('the card is titled CONTROLS', () => {
  it('in those words', () => {
    expect(CONTROLS_TITLE).toBe('CONTROLS')
  })

  it('in the display face, like every other title in the game', () => {
    expect(title.get('font-family')).toBe(DISPLAY_FONT)
  })

  it('and in white', () => {
    /**
     * WHITE, NOT THE MEMORIAL'S GOLD. `#e8a317` is the colour the campaign's end
     * earned, and an instruction card wearing it would read like a eulogy. Nor
     * either status colour: this screen reports neither a win nor a loss.
     */
    const colour = title.get('color')
    expect(colour).toBeDefined()
    expect(colour?.toLowerCase()).toMatch(/^(#fff|#ffffff|white)$/)
  })

  it('and large enough to be the heading of a screen', () => {
    const size = title.get('font-size')
    expect(size).toBeDefined()
    expect(size).toMatch(/^clamp\(/)
    const max = /,\s*([\d.]+)rem\s*\)/.exec(size ?? '')
    expect(Number(max?.[1])).toBeGreaterThan(1.5)
  })
})

describe('and the screen behind it is flat black', () => {
  it('opaque, so nothing shows through', () => {
    /**
     * FLAT, NOT A GRADIENT AND NOT A TINT. `instructions.png` is grey-green
     * panels on transparency, and anything behind them competes with the one
     * thing this screen exists to make legible. Asserted as an OPAQUE colour:
     * an `rgba(...)` that drifted to 0.8 would let the previous screen ghost
     * through and nothing else here would fail.
     */
    const background = backdrop.get('background') ?? backdrop.get('background-color')
    expect(background).toBeDefined()
    expect(background).toMatch(/^(#000|#000000|black|rgb\(0,\s*0,\s*0\))$/i)
  })

  it('with no image behind it', () => {
    // The Menu sets a jungle on its backdrop. This screen must not inherit or
    // repeat that — see the case above.
    expect(CONTROLS_BACKDROP_STYLE).not.toMatch(/background-image|url\(/)
  })
})

describe('the instructions are shown whole', () => {
  it('scaled to fit rather than cropped', () => {
    /**
     * THE FAILURE THIS PREVENTS IS A HALF-VISIBLE CARD. `instructions.png` is
     * 2400x960 — wider than 2:1 — so on any ordinary window `cover`, or a plain
     * `width:100%` with a capped height, would slice the rifle and rocket panels
     * off the edges. `contain` is what guarantees every panel is on screen.
     */
    expect(image.get('object-fit')).toBe('contain')
    expect(image.get('max-width')).toBeDefined()
    expect(image.get('max-height')).toBeDefined()
  })

  it('and never enlarged past its own pixels into mush', () => {
    // A 2400px-wide PNG stretched across a 4K display is soft; the cap is in
    // `rem` so the card stops growing once it is comfortably readable.
    expect(image.get('max-width')).toMatch(/rem/)
  })
})

describe('and the button under it can actually be pressed', () => {
  it('says what it does', () => {
    expect(CONTROLS_CONTINUE_LABEL.length).toBeGreaterThan(0)
    expect(CONTROLS_CONTINUE_LABEL).toBe(CONTROLS_CONTINUE_LABEL.trim())
  })

  it('and the picture above it swallows no clicks', () => {
    /**
     * A REAL BUG THIS GAME HAS ALREADY SHIPPED ONCE. `briefing.ts` records the
     * shared backdrop's `pointer-events:none` inheriting into its children and
     * making its own button unclickable; ticket 073 avoided the mirror image of
     * it with the poppies. A full-width image is exactly the element that lands
     * over a centred button.
     */
    expect(image.get('pointer-events')).toBe('none')
  })
})
