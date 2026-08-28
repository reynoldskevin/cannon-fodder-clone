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
    for (const ordnance of Object.keys(ORDNANCE)) {
      expect(ORDNANCE_ICONS.map((icon) => icon.ordnance)).toContain(ordnance)
    }
  })

  it('and offers one for the rifle too, which is how you put the grenade down', () => {
    /**
     * REVERSED FROM TICKET 067, DELIBERATELY. The rifle was left off on the
     * grounds that it is what every soldier is already holding and has no count
     * to show — right when the bar was two pictures of throwables, wrong once
     * the bar became how the player CHANGES weapon. Arming a grenade was one
     * click and putting it down again was not: the only way back was the `1`
     * key, or spending the last round.
     */
    expect(ORDNANCE_ICONS.some((icon) => icon.ordnance === RIFLE_ORDNANCE)).toBe(true)
  })

  it('and lists them in the armoury’s order, which puts the rifle leftmost', () => {
    /**
     * "TO THE LEFT OF THE GRENADE AND ROCKET" IS NOT ARRANGED HERE — it falls
     * out of `ORDNANCE_ORDER`, which is the rifle followed by `ORDNANCE`'s own
     * keys. Sorting the bar in this file would be a second order that agreed
     * with the digits until somebody changed one of them, and then the second
     * icon would be the third weapon.
     */
    expect(ORDNANCE_ICONS.map((icon) => icon.ordnance)).toEqual([...ORDNANCE_ORDER])
    expect(ORDNANCE_ICONS[0]?.ordnance).toBe(RIFLE_ORDNANCE)
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

  it('and the rifle, grenade and rocket really are 1, 2 and 3 today', () => {
    // The concrete case, so a table that round-tripped some other way — say
    // every icon claiming the rifle's `1` — could not satisfy the loop above.
    const digit = (ordnance: string): string | undefined =>
      ORDNANCE_ICONS.find((icon) => icon.ordnance === ordnance)?.hotkey
    expect(digit(RIFLE_ORDNANCE)).toBe('1')
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

  it('and wraps rather than spilling out of the rail (ticket 073)', () => {
    /**
     * THE THIRD ICON IS WHAT BREAKS THE OLD ARITHMETIC. Three buttons is
     * `3 × 3.9rem` plus two `0.5rem` gaps plus borders — a shade over 13rem —
     * against a rail whose width is `clamp(11rem, 22vw, 16rem)`, and 22vw is
     * below the 11rem floor on any viewport under 800px. Two icons fitted with
     * room to spare; three do not.
     *
     * AND THE OVERFLOW WOULD BE CLIPPED, NOT SHOWN. `SQUAD_PANEL_STYLE` sets
     * `overflow-y:hidden`, which makes the unset `overflow-x` compute to `auto`
     * rather than `visible` — so the spill is cut off AND stops being
     * hit-testable. Centred by `align-self`, that takes a bite out of both ends:
     * the rifle, which is the button this ticket exists to add, would lose part
     * of the click target it was added to provide.
     *
     * WRAPPING RATHER THAN WIDENING THE RAIL, because `ROSTER_COLUMN_WIDTH` is
     * shared with Boot Hill — widening it here to fit an icon would move a
     * screen that has no icons on it.
     */
    expect(bar.get('flex-wrap')).toBe('wrap')
    // And the bar may not measure itself wider than the rail it sits in, or
    // `fit-content` would keep resolving to the un-wrapped intrinsic width.
    expect(bar.get('max-width')).toBe('100%')
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

    it('but says nothing at all for a weapon that cannot run out (ticket 073)', () => {
      /**
       * THE ARMOURY ANSWERS `Number.POSITIVE_INFINITY` FOR THE RIFLE, and
       * `String()` of that is the word `Infinity` — nine characters in the
       * corner of a 3.9rem button, over the art, saying something no player has
       * ever wanted to read.
       *
       * READ OFF THE COUNT, NOT OFF THE WEAPON'S NAME. The rule is "a weapon
       * with no finite count has no badge", which is what `count()` actually
       * says; "the rifle is special" would be a second place that knows which
       * weapon is unlimited, and it would be wrong the first time another one
       * is.
       */
      expect(ordnanceCountLabel(Number.POSITIVE_INFINITY)).toBe('')
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
