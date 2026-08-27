import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKDROP_STYLE, PANEL_STYLE } from '../screen-chrome'

/**
 * Ticket 043 — the campaign screens are screens, not overlays on the level.
 *
 * The Menu and Boot Hill were drawn on `rgba(9,11,13,0.82)`, so the terrain and
 * the squad showed through them, and both put a bordered card on top of that.
 * The Briefing was already right — full-bleed `#000` with its text directly on
 * it — so this converges the other two onto it.
 *
 * WHY THESE ARE STRING ASSERTIONS AND NOT DOM ONES. `vitest.config.ts` sets
 * `environment: 'node'` and there is no jsdom in `devDependencies`, which is why
 * `src/ui` has no tests at all: every file in it calls `document.createElement`
 * on its first line. `screen-chrome.ts`'s MODULE BODY touches no DOM — these are
 * plain string constants — so the decision this ticket changes can be imported
 * and read directly, while the DOM call stays unguarded. That is the same split
 * `core/audio-events`/`src/audio` and `core/render-state/fx`/`src/render` already
 * run on. Adding a DOM environment is a real dependency decision and belongs to
 * its own ticket; see the ticket's "Still open".
 */

/** `a:b;c:d` -> `{a:'b', c:'d'}`, so a test asks about a property, not a substring. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of css.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

const backdrop = declarations(BACKDROP_STYLE)
const panel = declarations(PANEL_STYLE)

describe('the backdrop is a screen, not a veil over the level', () => {
  it('is opaque black', () => {
    expect(backdrop.get('background')).toBe('#000')
  })

  it('carries no alpha channel anywhere', () => {
    /**
     * THE ACTUAL DEFECT, stated as its own case. `rgba(9,11,13,0.82)` is the
     * value that let the river and the squad show through the start screen. A
     * fix that merely darkened it — `rgba(0,0,0,0.98)` — would satisfy "looks
     * black" and still be an overlay.
     */
    expect(BACKDROP_STYLE).not.toMatch(/rgba?\(/)
  })

  it('covers the whole viewport', () => {
    expect(backdrop.get('position')).toBe('fixed')
    expect(backdrop.get('inset')).toBe('0')
  })

  it('still swallows clicks that land on the bare background', () => {
    // Unchanged and deliberately so: an opaque backdrop that ate a click meant
    // for nothing is the same bug it always was.
    expect(backdrop.get('pointer-events')).toBe('none')
  })
})

describe('the content column is not a card', () => {
  it('has no background fill of its own', () => {
    // `rgba(13,16,18,0.94)` was the panel. Content sits directly on the black now.
    expect(panel.get('background')).toBeUndefined()
    expect(PANEL_STYLE).not.toMatch(/rgba?\(/)
  })

  it('has no border', () => {
    expect(panel.get('border')).toBeUndefined()
  })

  it('takes input, so the buttons inside it still work', () => {
    expect(panel.get('pointer-events')).toBe('auto')
  })
})

describe('one spelling of a campaign screen, not three transcriptions', () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

  /**
   * The same file with every comment removed.
   *
   * THE ASSERTIONS BELOW ARE ABOUT CODE, NOT ABOUT PROSE. This codebase explains
   * what it stopped doing and why, constantly and deliberately — so a naive
   * source match fails on the very comment that documents the fix. Two of these
   * cases were written the naive way first and both failed on their own
   * explanation. Stripping comments keeps the claim ("this file does not DO
   * this") without making its history unmentionable.
   */
  const code = (file: string): string =>
    source(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[^\n'"`]*?\/\/.*$/gm, '')

  /**
   * SOURCE-LEVEL, and that is the point. The failure this guards is not a wrong
   * value — it is a SECOND value: Boot Hill carried its own copy of the backdrop
   * and panel styles, so `screen-chrome.ts` could be fixed while the memorial
   * screen stayed translucent. This project already pins a document against code
   * the same way in `core/flow/__tests__/diagram.test.ts`.
   */
  for (const file of ['boot-hill.ts', 'briefing.ts', 'menu.ts']) {
    it(`${file} does not transcribe a translucent backdrop of its own`, () => {
      expect(code(file)).not.toMatch(/rgba\(9,\s*11,\s*13/)
    })

    it(`${file} does not transcribe a panel card of its own`, () => {
      expect(code(file)).not.toMatch(/rgba\(13,\s*16,\s*18/)
    })
  }

  it('the briefing no longer hand-rolls its own full-bleed card', () => {
    /**
     * It was right first and is now the shared value rather than a fourth copy
     * of it. The old `CARD_STYLE` DECLARATION going away is the convergence.
     *
     * It reads COMMENT-STRIPPED code, which is the whole reason `code` exists. A
     * first draft matched raw source and failed on the comment that explains
     * where the value went — exactly the kind of note this codebase writes
     * everywhere and should not be punished for. The claim is that the screen
     * does not DECLARE its own card style, not that its history is unmentionable.
     */
    expect(code('briefing.ts')).not.toMatch(/CARD_STYLE/)
  })

  it('boot hill builds its chrome from the shared helper', () => {
    expect(code('boot-hill.ts')).toMatch(/createChrome/)
  })

  /**
   * THE ONE THE STRING ASSERTIONS ABOVE COULD NOT SEE, and it shipped for real
   * before a screenshot caught it.
   *
   * The shared backdrop carries `pointer-events:none` so a click on the bare
   * black is swallowed rather than reaching the canvas. `pointer-events`
   * INHERITS. The Briefing used to own a backdrop with no such rule and appended
   * its heading, objectives and Start button straight onto it — so the moment it
   * moved to the shared surface, its only button became unclickable. Every
   * assertion in this file still passed: the styles were all exactly right, and
   * the screen was dead.
   *
   * So the rule is structural and is pinned as such: content goes in the column.
   * A screen that appends to `backdrop` is a screen whose buttons do not work.
   */
  for (const file of ['boot-hill.ts', 'briefing.ts', 'menu.ts']) {
    it(`${file} appends its content to the column, not to the backdrop`, () => {
      expect(code(file)).not.toMatch(/\bbackdrop\.append\(/)
    })
  }
})
