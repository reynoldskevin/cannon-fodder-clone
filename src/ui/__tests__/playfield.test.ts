import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PLAYFIELD_STYLE } from '../playfield'
import { ROSTER_COLUMN_WIDTH } from '../roster-column'
import { SQUAD_PANEL_STYLE } from '../squad-panel'

/**
 * Ticket 074 — the playfield stops at the rail instead of running under it.
 *
 * The canvas was the whole window with the rail painted on top, so a strip of
 * map the width of the roster was permanently behind the panel: men walked into
 * it and vanished, and the camera's idea of what was on screen included ground
 * the player could not see.
 *
 * PINNED OUT HERE BECAUSE IT CANNOT BE PINNED IN THERE. Vitest runs
 * `environment: 'node'` with no DOM, so a style applied inside a function that
 * touches `document` is out of reach — the same split every file in `src/ui`
 * runs on. The string is a module-scope constant and the wiring is read out of
 * `main.ts` as text.
 */

/** `a:b;c:d` -> `{a:'b', c:'d'}`, so a test asks about a property. */
const declarations = (css: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const part of css.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

const style = declarations(PLAYFIELD_STYLE)
const main = readFileSync(new URL('../../app/main.ts', import.meta.url), 'utf8')
const source = readFileSync(new URL('../playfield.ts', import.meta.url), 'utf8')

describe('the canvas starts where the rail ends', () => {
  it('is inset from the left by the rail’s width', () => {
    expect(style.get('left')).toBe(ROSTER_COLUMN_WIDTH)
  })

  it('and is the rest of the screen wide', () => {
    expect(style.get('width')).toBe(`calc(100vw - ${ROSTER_COLUMN_WIDTH})`)
  })

  it('and takes that width from the rail rather than re-spelling it', () => {
    /**
     * THE WHOLE POINT IS THAT THE TWO EDGES ARE ONE NUMBER. A `clamp()` copied
     * into this file would agree with the rail exactly until somebody widened
     * one of them, and then the map would either run back under the panel or
     * show a strip of dead background beside it — with nothing failing anywhere.
     */
    expect(source).toMatch(/from '\.\/roster-column'/)
    expect(source).toContain('ROSTER_COLUMN_WIDTH')
    expect(source).not.toContain('clamp(11rem, 22vw, 16rem)')
  })

  it('and fills the height', () => {
    expect(style.get('top')).toBe('0')
    expect(style.get('height')).toBe('100vh')
  })

  it('and is positioned, but claims no stacking order of its own', () => {
    /**
     * UNDER THE RAIL AND UNDER EVERY SCREEN. The playfield is the bottom of the
     * page; a `z-index` here would be an invitation to fight the rail's 30, the
     * banner's 41 and the error overlay's 50 over something that has no reason
     * to rise at all.
     */
    expect(style.get('position')).toBe('fixed')
    expect(style.has('z-index')).toBe(false)
  })
})

describe('the inset is the space the rail actually occupies', () => {
  /**
   * THE BUG THE ARITHMETIC DID NOT CATCH AND THE SCREEN DID. Both columns are
   * `width: ROSTER_COLUMN_WIDTH` with `0.6rem` of padding either side and the
   * default `content-box`, so each one OCCUPIES the constant plus `1.2rem`. The
   * playfield subtracts the constant, so 19 pixels of map went on living under
   * the panel — a thinner version of exactly the bug this ticket is about, and
   * invisible in any test that compares one string to another.
   *
   * FIXED BY MAKING THE CONSTANT TRUE rather than by adding the padding back on
   * in a third file, which would have put the rail's own padding into the
   * playfield's arithmetic and broken the day somebody changed it.
   */
  it('so the rail measures its width the way the playfield reads it', () => {
    // Asked of the exported STYLE and not of the file's text: a source read
    // would pass on a comment that merely mentions the property, which is
    // exactly what a comment about this would say.
    expect(declarations(SQUAD_PANEL_STYLE).get('box-sizing')).toBe('border-box')
  })

  it('and Boot Hill’s column does the same, so the two screens still match', () => {
    /**
     * "The same width as Boot Hill" is the promise ticket 065 made and
     * `squad-panel.test.ts` guards. Border-boxing one and not the other would
     * keep the constant equal and make the columns differ by `1.2rem` — the
     * promise kept in the source and broken on the screen.
     *
     * A SOURCE READ AND NOT A STYLE, BECAUSE THERE IS NO STYLE TO READ: Boot
     * Hill builds its column's `cssText` inside the function that creates it, so
     * there is nothing importable to assert against. Weaker than the rail's test
     * above by exactly that much, and worth having anyway.
     */
    const bootHill = readFileSync(new URL('../boot-hill.ts', import.meta.url), 'utf8')
    expect(bootHill).toContain("'box-sizing:border-box',")
  })
})

describe('and everything is measured from the canvas, not the window', () => {
  it('the style is actually put on the canvas', () => {
    // Everything below pins how the canvas is MEASURED; without this, all of it
    // would still hold on a canvas that had never been given the style at all.
    expect(main).toMatch(/canvas\.style\.cssText = PLAYFIELD_STYLE/)
  })

  it('the renderer is sized from the element', () => {
    /**
     * THE FAILURE THIS PREVENTS IS SUBTLE AND PERMANENT. Sized to
     * `window.innerWidth`, the drawing buffer is wider than the element the CSS
     * gives it, so the whole scene is squeezed horizontally — every sprite
     * slightly the wrong shape, and no error anywhere. Read off the element and
     * the buffer matches what is on screen by definition.
     */
    expect(main).toMatch(/renderer\.setSize\(\s*canvas\.clientWidth/)
  })

  it('and Three is told not to restyle it', () => {
    /**
     * `setSize` WRITES `style.width`/`style.height` IN PIXELS unless its third
     * argument says otherwise, which would overwrite the `calc()` above with a
     * fixed number — correct for exactly one viewport size, and wrong from the
     * first resize onwards.
     */
    expect(main).toMatch(/renderer\.setSize\([^)]*false\s*\)/s)
  })

  it('and so is the camera, on boot and on resize alike', () => {
    // Two places that must agree: the rig's initial viewport and the resize
    // handler. An aspect taken from the window would letterbox or crop the
    // view against a canvas that is a different shape.
    expect(main).not.toMatch(/rig\.resize\(window\.innerWidth/)
    expect(main).toMatch(/rig\.resize\(\s*canvas\.clientWidth/)
    expect(main).not.toMatch(/\{ width: window\.innerWidth, height: window\.innerHeight \}/)
  })
})
