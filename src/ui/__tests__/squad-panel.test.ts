import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ROSTER_COLUMN_WIDTH } from '../roster-column'
import {
  SQUAD_NAME_STYLE,
  SQUAD_PANEL_DISPLAY,
  SQUAD_PANEL_STYLE,
  SQUAD_ROW_STYLE,
  rollCall,
  squadRowCells,
} from '../squad-panel'
import type { SquadPanelMember } from '../squad-panel'
import { insigniaPosition } from '../rank-insignia'

/**
 * Ticket 065 — the roll of the men, down the left of the level.
 *
 * The HUD says "Squad 4/6" and draws six pips. That is how MANY are standing and
 * never WHO, and the player has just spent a briefing screen choosing them by
 * name. This is that list, on the level, in the same column width Boot Hill uses
 * for its own roster — and laid out the other way round from Boot Hill's: the
 * name centred, with the man's badge repeated either side of it.
 *
 * WHY THESE ARE STRING ASSERTIONS. `vitest.config.ts` sets `environment: 'node'`
 * and there is no jsdom, so nothing in `src/ui` that touches the DOM can be
 * tested at all. `squad-panel.ts`'s MODULE BODY touches none — the styles are
 * string constants and the row's shape is a pure function — so every decision
 * this ticket makes is importable, while the `document.createElement` calls stay
 * where they cannot be reached. Same split `screen-chrome.ts`, `mission-banner.ts`
 * and `rank-insignia.ts` already run on.
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

const panel = declarations(SQUAD_PANEL_STYLE)
const row = declarations(SQUAD_ROW_STYLE)
const name = declarations(SQUAD_NAME_STYLE)

const source = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

describe('the panel is the same column Boot Hill draws', () => {
  it('takes its width from the shared constant', () => {
    expect(panel.get('width')).toBe(ROSTER_COLUMN_WIDTH)
  })

  it('and Boot Hill takes it from there too, rather than re-spelling it', () => {
    /**
     * THE POINT OF THE TICKET'S "same width as Boot Hill" IS THAT IT STAYS TRUE.
     * Two files carrying the same `clamp()` literal agree until somebody widens
     * one of them, and nothing anywhere would fail — the two screens would simply
     * stop lining up, which is only visible by opening both. So the constant is
     * imported, and this is the assertion that keeps it imported.
     */
    const bootHill = source('boot-hill.ts')
    expect(bootHill).toMatch(/from '\.\/roster-column'/)
    expect(bootHill).toContain('ROSTER_COLUMN_WIDTH')
    // And the literal is gone from it, which is the half that actually rots.
    expect(bootHill).not.toContain('clamp(11rem, 22vw, 16rem)')
  })

  it('and the HUD is pushed clear of the rail by that same width', () => {
    /**
     * THE OVERLAP IS NOT AN EDGE CASE — IT IS EVERY MISSION. The HUD is a fixed
     * card that sat at `left:0.75rem`, which is INSIDE a full-height rail flush
     * to the left edge, and the two are shown on exactly the same screens. The
     * HUD is the higher `z-index`, so the roster would read through it.
     *
     * PINNED HERE BECAUSE NOTHING ELSE CAN. `hud.ts` reaches for `document` in
     * `createHud` but not at module scope, so its `PANEL_STYLE` is out of reach
     * of an import under `environment: 'node'` only because it is not exported —
     * hence a source read. Without this assertion the offset is a line anybody
     * could tidy away, and the symptom would be a HUD over the names.
     */
    const hud = source('hud.ts')
    expect(hud).toMatch(/from '\.\/roster-column'/)
    expect(hud).toMatch(/left:calc\(\$\{ROSTER_COLUMN_WIDTH\}/)
  })
})

describe('a row is a badge, a name, and the same badge again', () => {
  const cells = squadRowCells({ name: 'Jops', rankIndex: 3 })

  it('is exactly three cells', () => {
    expect(cells).toHaveLength(3)
  })

  it('and carries the insignia on both ends, at the same rank', () => {
    /**
     * REPEATED, NOT MIRRORED-AND-DIFFERENT. Two badges showing two ranks would be
     * read as two facts about one man, and the second one would be wrong.
     */
    expect(cells[0]?.kind).toBe('insignia')
    expect(cells[2]?.kind).toBe('insignia')
    expect(cells[0]?.position).toBe(insigniaPosition(3))
    expect(cells[2]?.position).toBe(cells[0]?.position)
  })

  it('and the name in the middle', () => {
    expect(cells[1]?.kind).toBe('name')
    expect(cells[1]?.text).toBe('JOPS')
  })

  it('and upper-cases the name in the VALUE, not in CSS', () => {
    /**
     * `text-transform` leaves the accessible name lower case, so a reader is
     * handed "Jops" while the screen says JOPS. The project's rule, and the one
     * `briefing.ts` carries a header note about.
     */
    expect(squadRowCells({ name: 'stoo', rankIndex: 0 })[1]?.text).toBe('STOO')
    expect(row.get('text-transform')).toBeUndefined()
    expect(name.get('text-transform')).toBeUndefined()
  })

  it('and a rank from outside the sheet is still drawn as a badge', () => {
    // `insigniaPosition` clamps rather than validating — see its own test. What
    // matters here is that the row does not decide to draw something else.
    const wild = squadRowCells({ name: 'Ghost', rankIndex: 99 })
    expect(wild[0]?.position).toBe(insigniaPosition(99))
    expect(wild.map((cell) => cell.kind)).toEqual(['insignia', 'name', 'insignia'])
  })
})

describe('the name sits in the middle of the row', () => {
  it('centres the row’s own content', () => {
    expect(row.get('display')).toBe('flex')
    expect(row.get('align-items')).toBe('center')
    // NOT `space-between`, which is Boot Hill's rule: that pushes the badges to
    // the edges and the name reads as left-aligned against the first of them.
    expect(row.get('justify-content')).toBe('center')
  })

  it('and centres the name inside its own cell', () => {
    expect(name.get('text-align')).toBe('center')
  })

  it('and lets the name take the space, so the badges stay at its ends', () => {
    // Without this the name is only as wide as its text and the two badges
    // close up against it — a three-letter name and an eight-letter one would
    // sit at different distances from the panel's edges.
    expect(name.get('flex')).toMatch(/^1\b/)
  })
})

describe('a dead man leaves the roll (ticket 066)', () => {
  const man = (id: string, name: string, alive: boolean): SquadPanelMember => ({
    id,
    name,
    rankIndex: 0,
    alive,
  })
  const squad = [
    man('a', 'Jops', true),
    man('b', 'Stoo', false),
    man('c', 'Jools', true),
    man('d', 'Ubik', false),
  ]

  it('drops him rather than greying him', () => {
    /**
     * THE WHOLE TICKET. A name on this rail means "this man is still with you",
     * so a struck-through or faded row would be the panel still claiming him and
     * hedging about it. He goes, and the rail closes up behind him.
     */
    expect(rollCall(squad).map((each) => each.name)).toEqual(['Jops', 'Jools'])
  })

  it('and the men who are left keep the order the player chose them in', () => {
    /**
     * NOT RE-SORTED BY ANYTHING. The panel is the list the player built on the
     * Briefing screen and has been reading down the side of the map all mission;
     * a roll that re-ordered itself every time somebody died would make him find
     * his men again at the exact moment he is least able to.
     */
    const reversed = [...squad].reverse()
    expect(rollCall(reversed).map((each) => each.name)).toEqual(['Jools', 'Jops'])
  })

  it('and a wiped squad leaves no rows at all', () => {
    expect(rollCall(squad.map((each) => ({ ...each, alive: false })))).toEqual([])
    expect(rollCall([])).toEqual([])
  })

  it('and the rail is actually drawn from it', () => {
    /**
     * The filtering is worth nothing if `update` still walks the whole squad —
     * the dead man's row would be hidden by the tail loop only when he happened
     * to be last. A source read because `update` closes over the DOM and cannot
     * be imported under `environment: 'node'`; see the header.
     */
    expect(source('squad-panel.ts')).toMatch(/rollCall\(model\.squad\)/)
  })
})

describe('the ordnance bar under the roster (ticket 067)', () => {
  const panelSource = source('squad-panel.ts')

  it('is built from the shared table rather than from a second list', () => {
    /**
     * The table is where "which weapons have icons, in what order, on which
     * digit" is decided and tested (`ordnance-icons.test.ts`). A panel that
     * hand-listed the grenade and the rocket would be a second answer to all
     * three, and the tested one would not be the one on screen.
     */
    expect(panelSource).toMatch(/from '\.\/ordnance-icons'/)
    expect(panelSource).toContain('ORDNANCE_ICONS')
  })

  it('and makes each one a real button that a keyboard can reach', () => {
    /**
     * NOT A `div` WITH A CLICK HANDLER. A button is focusable, is activated by
     * Enter and Space, and announces itself as a control — and the whole point of
     * this bar is to be the mouse route to something that already has a keyboard
     * one. `type="button"` because a bare `<button>` inside any future form
     * submits and reloads the page, which mid-mission costs the mission.
     */
    expect(panelSource).toMatch(/createElement\('button'\)/)
    expect(panelSource).toMatch(/\.type = 'button'/)
  })

  it('and tells the caller which weapon was asked for, deciding nothing itself', () => {
    /**
     * The panel does not touch the command queue and does not know what arming
     * means; it reports the ordnance and `app/main.ts` does with that exactly
     * what it does with a digit — which is what makes "clicking arms it the way
     * pressing 2 does" true by construction rather than by two call sites that
     * happen to agree.
     */
    expect(panelSource).toMatch(/onSelectOrdnance/)
  })

  it('and an empty count hides its badge rather than drawing a blank plate (ticket 073)', () => {
    /**
     * THE RIFLE HAS NO NUMBER TO SHOW. `ordnanceCountLabel` answers `''` for a
     * count that is not finite, and the badge is not a bare text node: it
     * carries a dark plate, a border-width of padding and a minimum width, all
     * so a digit stays legible over the art. Written empty it keeps every one of
     * those and becomes a small blank tile sitting in the corner of the rifle,
     * which reads as a readout that has failed rather than as one that does not
     * apply.
     *
     * DRIVEN BY THE LABEL, NOT BY THE WEAPON. Whatever `ordnanceCountLabel`
     * calls empty is what has no badge, so the two rules cannot disagree — and
     * the one place that decides which weapons are countable stays the armoury.
     */
    expect(panelSource).toMatch(/ordnanceCountLabel/)
    // The label is put in a variable and asked about, rather than passed
    // straight into `setText` — which is what the display toggle needs.
    expect(panelSource).toMatch(/label === ''|label !== ''|=== ''|!== ''/)
    expect(panelSource).toMatch(/count\.style\.display/)
  })
})

describe('the panel is a rail, and it is not in the way', () => {
  it('is fixed to the left edge and spans the height', () => {
    expect(panel.get('position')).toBe('fixed')
    expect(panel.get('left')).toBe('0')
    expect(panel.get('top')).toBe('0')
    expect(panel.get('bottom')).toBe('0')
  })

  it('and never eats a click meant for the squad', () => {
    /**
     * THE HUD'S OWN RULE, for the HUD's own reason: an order given through the
     * panel is an order that never arrives. This one is a full-height rail down
     * the side of the map, so it covers far more of the level than the HUD does.
     */
    expect(panel.get('pointer-events')).toBe('none')
  })

  it('and is a column when it is shown', () => {
    /**
     * The shown value is a CONSTANT because `setVisible` has to put this exact
     * string back after `display:none` — a literal in both places breaks the
     * layout the day the panel stops being a column, and `hud.ts` carries the
     * same note.
     */
    expect(SQUAD_PANEL_DISPLAY).toBe('flex')
    expect(panel.get('display')).toBe(SQUAD_PANEL_DISPLAY)
    expect(panel.get('flex-direction')).toBe('column')
  })

  it('and is built hidden, like the HUD', () => {
    /**
     * The panel is built once at boot, before the first screen is decided.
     * Visible-by-default would put a squad roster over the Menu.
     */
    expect(source('squad-panel.ts')).toMatch(/display\s*=\s*'none'/)
  })
})
