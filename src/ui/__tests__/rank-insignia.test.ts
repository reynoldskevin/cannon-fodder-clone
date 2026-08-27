import { describe, it, expect } from 'vitest'
import {
  INSIGNIA_COLUMNS,
  INSIGNIA_ROWS,
  INSIGNIA_STYLE,
  insigniaPosition,
} from '../rank-insignia'
import { RANKS } from '../../core/campaign'

/**
 * Ticket 062 — picking one badge out of a sheet of sixteen.
 *
 * `rank-insignia-sheet.png` is 1920x640: an 8x2 grid of 240x320 cells, measured
 * off the file rather than assumed — the eight column runs and two row runs are
 * exactly uniform and the background is transparent, not matted on black.
 *
 * A CSS SPRITE AND NOT SIXTEEN FILES, because this is a DOM screen and the badge
 * is a `background-image` on a `span`. The whole of the decision is a
 * `background-position`, which is a string, which is testable under Vitest's
 * `node` environment — the same split `screen-chrome.ts`, `mission-banner.ts`
 * and `briefing.ts` already run on.
 *
 * THE PERCENTAGE IS THE PART THAT IS EASY TO GET WRONG. A CSS background
 * position of `n%` does NOT mean "n% along the image" — it aligns the n% point
 * of the IMAGE with the n% point of the BOX, so with an 8-wide sheet scaled to
 * 800% the columns land at multiples of 100/7, not of 100/8. The off-by-one is
 * invisible at column 0 and at the last column, and wrong in between: exactly
 * the shape that ships.
 */

describe('the grid matches the sheet that was measured', () => {
  it('is eight across and two down', () => {
    expect(INSIGNIA_COLUMNS).toBe(8)
    expect(INSIGNIA_ROWS).toBe(2)
  })

  it('and holds exactly as many badges as the ladder has rungs', () => {
    /**
     * THE CONTRACT BETWEEN THE ART AND THE TABLE, and the reason this assertion
     * is in `src/ui` rather than beside either of them: it is the only file that
     * imports both. A seventeenth rank would be a man with no badge; a fifteenth
     * would leave a badge drawn for nobody. Neither would fail anywhere else —
     * `rankFor` would keep working and the sheet would keep loading.
     */
    expect(INSIGNIA_COLUMNS * INSIGNIA_ROWS).toBe(RANKS.length)
  })
})

describe('the badge each rank lands on', () => {
  it('puts the first rung at the top-left corner', () => {
    expect(insigniaPosition(0)).toBe('0% 0%')
  })

  it('and the last at the bottom-right', () => {
    expect(insigniaPosition(15)).toBe('100% 100%')
  })

  it('and the eighth ends the first row rather than starting the second', () => {
    // Index 7 is the last cell of row 0. An implementation that wrapped a cell
    // early or late puts every badge from here down one rank out of step.
    expect(insigniaPosition(7)).toBe('100% 0%')
    expect(insigniaPosition(8)).toBe('0% 100%')
  })

  it('and steps across the row in equal, correctly-sized jumps', () => {
    /**
     * THE 100/7 CASE. A sheet eight cells wide scaled to 800% has its columns at
     * multiples of 100/(8-1), NOT 100/8. Both give 0% for the first cell and
     * both give the last cell a whole number, so only the middle of the row can
     * tell them apart — which is why the middle of the row is what is asserted.
     */
    const x = (index: number): number => Number(/^([\d.]+)%/.exec(insigniaPosition(index))?.[1])
    expect(x(1)).toBeCloseTo(100 / 7, 3)
    expect(x(4)).toBeCloseTo((400 / 7), 3)
    // And not the wrong divisor, which would put column 4 at 50%.
    expect(x(4)).not.toBeCloseTo(50, 1)
  })

  it('and no two ranks share a badge', () => {
    const all = Array.from({ length: RANKS.length }, (_, i) => insigniaPosition(i))
    expect(new Set(all).size).toBe(RANKS.length)
  })
})

describe('an index from outside the table', () => {
  it('is clamped rather than pointing off the sheet', () => {
    /**
     * `background-position` DOES NOT FAIL ON A SILLY VALUE — it just scrolls the
     * image, so an out-of-range index shows a slice of two badges or a blank,
     * with nothing raised anywhere. Clamping keeps a wrong number looking like a
     * rank instead of like a rendering fault.
     */
    expect(insigniaPosition(-3)).toBe(insigniaPosition(0))
    expect(insigniaPosition(99)).toBe(insigniaPosition(RANKS.length - 1))
    expect(insigniaPosition(Number.NaN)).toBe(insigniaPosition(0))
  })
})

describe('the badge as it is drawn', () => {
  /** `a:b;c:d` -> `{a:'b', c:'d'}`. */
  const declarations = (css: string): Map<string, string> => {
    const out = new Map<string, string>()
    for (const part of css.split(';')) {
      const at = part.indexOf(':')
      if (at < 0) continue
      out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
    }
    return out
  }
  const style = declarations(INSIGNIA_STYLE)

  it('shows one cell of the sheet, not the whole sheet', () => {
    // `800% 200%` is what makes the element a window onto one 240x320 cell. At
    // the default `auto` the span would show the entire 1920x640 image squashed
    // into a badge-sized box.
    expect(style.get('background-size')).toBe('800% 200%')
  })

  it('and does not tile', () => {
    // A repeating background would draw the neighbouring badges into the same
    // box the moment the element was not exactly one cell's aspect.
    expect(style.get('background-repeat')).toBe('no-repeat')
  })

  it('and holds its size in a flex row that will try to squash it', () => {
    /**
     * `flex:none` IS NOT DEFENSIVE HERE. The row is `display:flex` with
     * `justify-content:space-between`, and a flex item with a background but no
     * content has a base size of zero — so without this the badge collapses to
     * nothing and the only symptom is a name that did not move.
     */
    expect(style.get('flex')).toBe('none')
  })

  it('and is sized in `em`, so it tracks the row it sits in', () => {
    // The rows are set in a `clamp()` that changes with the viewport. A badge in
    // `px` would be right at one window width and wrong at every other.
    expect(style.get('width')).toMatch(/em$/)
    expect(style.get('height')).toMatch(/em$/)
  })

  it('and keeps the cell’s shape, which is taller than it is wide', () => {
    /**
     * THE CELLS ARE 240x320. A badge drawn square would stretch every chevron by
     * a third, which reads as blurry artwork rather than as a layout bug.
     */
    const em = (value: string | undefined): number => Number(/^([\d.]+)em$/.exec(value ?? '')?.[1])
    const w = em(style.get('width'))
    const h = em(style.get('height'))
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
    expect(w / h).toBeCloseTo(240 / 320, 2)
  })
})
