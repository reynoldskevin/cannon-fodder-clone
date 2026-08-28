import { describe, it, expect } from 'vitest'
import {
  ORDNANCE_COUNT_STYLE,
  ORDNANCE_ICONS,
  ORDNANCE_ICON_ARMED_STYLE,
  ORDNANCE_ICON_BAR_STYLE,
  ORDNANCE_ICON_STYLE,
  ordnanceCountLabel,
} from '../ordnance-icons'
import { ORDNANCE_ORDER, RIFLE_ORDNANCE, ordnanceForHotkey } from '../../core/armoury'
import { ORDNANCE } from '../../core/ordnance'

/**
 * Ticket 067 — the two ordnance types, as things you can click.
 *
 * Arming a grenade was a keyboard-only act: press 2, and the only acknowledgement
 * was a line of monospace in the HUD. These are the same two weapons as painted
 * icons under the squad rail, and clicking one must arm it EXACTLY as its digit
 * does.
 *
 * THE HOTKEY IS THE WHOLE CONTRACT AND IT IS NOT AUTHORED TWICE. `core/armoury`
 * derives a weapon's digit from its position in `ORDNANCE_ORDER`, so an icon
 * table that wrote `hotkey: '2'` beside the grenade would be a second copy of
 * that rule — right today, and wrong the first time a weapon is inserted before
 * it. The icon would then arm the rocket while showing a grenade, and the player
 * would find out by throwing the wrong thing.
 */

describe('the icons are the game’s own weapons', () => {
  it('covers every ordnance the table defines', () => {
    /**
     * A NEW ORDNANCE TYPE MUST NOT ARRIVE WITH NO WAY TO CLICK IT. `ORDNANCE` is
     * where a weapon is added, and this fails the moment one lands without art —
     * which is a build failure at the right time rather than a control that is
     * quietly missing from the level screen.
     */
    expect(ORDNANCE_ICONS.map((icon) => icon.ordnance).sort()).toEqual(Object.keys(ORDNANCE).sort())
  })

  it('and does not offer one for the rifle', () => {
    /**
     * The rifle is unlimited, is what every soldier is already holding, and has
     * no count to show. An icon for it would be a button whose only effect is to
     * undo the other two.
     */
    expect(ORDNANCE_ICONS.some((icon) => icon.ordnance === RIFLE_ORDNANCE)).toBe(false)
  })

  it('and lists them in the armoury’s order, not in its own', () => {
    // So the bar reads left-to-right in the same order as the HUD's selector and
    // as the digits. Two orders would make the second icon the third weapon.
    const expected = ORDNANCE_ORDER.filter((name) => name !== RIFLE_ORDNANCE)
    expect(ORDNANCE_ICONS.map((icon) => icon.ordnance)).toEqual(expected)
  })

  it('and every icon carries art', () => {
    for (const icon of ORDNANCE_ICONS) {
      expect(icon.src).toBeTypeOf('string')
      expect(icon.src.length).toBeGreaterThan(0)
    }
  })
})

describe('an icon’s digit arms that icon’s weapon', () => {
  it('round-trips through the armoury for every one of them', () => {
    /**
     * THE CASE THE TICKET EXISTS FOR. "Clicking arms it the way pressing 2 does"
     * is only true if the digit printed on the grenade is the digit that selects
     * a grenade. Asked of `core/armoury` rather than of a literal, so the answer
     * comes from the same table the keyboard handler reads.
     */
    for (const icon of ORDNANCE_ICONS) {
      expect(ordnanceForHotkey(icon.hotkey)).toBe(icon.ordnance)
    }
  })

  it('and the grenade and rocket really are 2 and 3 today', () => {
    // The concrete case, so a table that round-tripped some other way — say
    // every icon claiming the rifle's `1` — could not satisfy the loop above.
    const digit = (ordnance: string): string | undefined =>
      ORDNANCE_ICONS.find((icon) => icon.ordnance === ordnance)?.hotkey
    expect(digit('grenade')).toBe('2')
    expect(digit('rocket')).toBe('3')
  })

  it('and no two icons claim the same key', () => {
    const keys = ORDNANCE_ICONS.map((icon) => icon.hotkey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('and each has a name that says what it is and how else to reach it', () => {
    /**
     * The accessible name, and the only text on the control — the art carries no
     * words. It must name the weapon AND its key, because the keyboard route is
     * not discoverable from a picture of a grenade.
     */
    for (const icon of ORDNANCE_ICONS) {
      expect(icon.label.toLowerCase()).toContain(icon.ordnance)
      expect(icon.label).toContain(icon.hotkey)
    }
  })
})

describe('the bar, and the buttons on it', () => {
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
  const bar = declarations(ORDNANCE_ICON_BAR_STYLE)
  const button = declarations(ORDNANCE_ICON_STYLE)
  const armed = declarations(ORDNANCE_ICON_ARMED_STYLE)

  it('takes pointer events back, which the rail around it gives away', () => {
    /**
     * THE ONE THING THAT WILL SILENTLY NOT WORK. `SQUAD_PANEL_STYLE` carries
     * `pointer-events:none` so an order clicked through the rail still reaches
     * the canvas — and that inherits. Without this the icons are drawn perfectly,
     * highlight correctly, and cannot be clicked at all.
     */
    expect(bar.get('pointer-events')).toBe('auto')
  })

  it('and puts the icons in a row under the roster', () => {
    expect(bar.get('display')).toBe('flex')
  })

  it('and the buttons are buttons, not pictures with a handler', () => {
    // `cursor:pointer` is the cheap half of that; the element being a real
    // `<button type="button">` is the half the panel's own source is read for.
    expect(button.get('cursor')).toBe('pointer')
  })

  it('and the square is a positioning context, so the count can sit in its corner', () => {
    /**
     * `position:absolute` RESOLVES AGAINST THE NEAREST POSITIONED ANCESTOR, and
     * without this that is the page: the counts would stack in the corner of the
     * VIEWPORT, both of them, on top of each other. The symptom is two numbers
     * in the bottom-right of the screen and none on the icons.
     */
    expect(button.get('position')).toBe('relative')
  })

  it('and the armed one differs by more than its colour', () => {
    /**
     * WHICH WEAPON AM I HOLDING is the question this bar exists to answer, and a
     * colour-blind player or a washed-out screen must not be the reason it goes
     * unanswered — the same bargain the HUD's selector and roster pips make. So
     * the armed state changes something structural as well: a border, an outline
     * or an opacity, not a hue alone.
     */
    const structural = ['border', 'border-color', 'outline', 'opacity', 'box-shadow', 'filter']
    expect(structural.some((property) => armed.has(property))).toBe(true)
  })

  describe('the count in the corner (ticket 069)', () => {
    const count = declarations(ORDNANCE_COUNT_STYLE)

    it('sits in the bottom-right of the square', () => {
      expect(count.get('position')).toBe('absolute')
      expect(count.get('bottom')).toBeDefined()
      expect(count.get('right')).toBeDefined()
      // And NOT pinned to the other two edges, which would stretch it across the
      // icon and centre the number over the art instead of tucking it in.
      expect(count.get('top')).toBeUndefined()
      expect(count.get('left')).toBeUndefined()
    })

    it('and does not swallow the click meant for the button under it', () => {
      /**
       * The badge is inside the button, so a click on the number IS a click on
       * the button — but only if the badge does not become the event's target
       * and stop there. `pointer-events:none` makes the corner as clickable as
       * the rest of the square, which matters because the corner is exactly
       * where a player aiming at a small icon tends to land.
       */
      expect(count.get('pointer-events')).toBe('none')
    })

    it('and prints the number of rounds', () => {
      expect(ordnanceCountLabel(4)).toBe('4')
      expect(ordnanceCountLabel(1)).toBe('1')
    })

    it('and prints a zero rather than going blank', () => {
      /**
       * AN EMPTY POUCH IS THE THING THE PLAYER MOST NEEDS TO READ. A badge that
       * hid itself at zero would leave an icon that looks exactly like a weapon
       * with rounds in it, and the only difference would be that firing does
       * nothing.
       */
      expect(ordnanceCountLabel(0)).toBe('0')
    })
  })
})
