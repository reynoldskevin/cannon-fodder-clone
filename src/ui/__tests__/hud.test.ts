import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  HUD_PANEL_SHOWN,
  HUD_SECTIONS,
  RAIL_SUPERSEDED,
  hudSectionShown,
  objectiveLabel,
  type HudSection,
} from '../hud'
import { ORDNANCE_ICONS } from '../ordnance-icons'
import { ORDNANCE } from '../../core/ordnance'

/**
 * Ticket 072 — the rail says it better, so the HUD stops saying it.
 *
 * The left rail names every living man and paints both weapons with their
 * remaining rounds. The HUD's roster pips and its monospace weapon selector are
 * the older answers to those two questions, and they are on screen at the same
 * time as the newer ones — the player reads his squad twice, in two vocabularies,
 * and reads his ordnance twice, in two places that must agree.
 *
 * HIDDEN AND NOT DELETED, which is the user's own instruction and the shape of
 * the whole ticket: the elements are still built, the pooling is still there, and
 * one constant brings either block back.
 *
 * WHY THERE IS A GATE AND NOT JUST A `display:none`. Whatever hides the pixels
 * must also be what skips the per-frame work, or the two drift: hide the block
 * and leave the loop and the game writes text into an invisible node sixty times
 * a second; skip the loop and leave the block shown and un-hiding it later
 * reveals an empty box that never fills. So the predicate is exported, is asked
 * in both places, and is what these tests interrogate.
 */

describe('the whole card is off', () => {
  it('the panel is not shown at all', () => {
    /**
     * WIDENED MID-TICKET, ON THE USER'S CALL. It started as the two blocks the
     * rail duplicates — the pips and the selector — with the header's
     * `Squad 3/3`, the clock and the objectives argued to stay, on the grounds
     * that the rail shows the living only and so `n/m` is the one statement of
     * losses. The answer was "that whole box can go". It goes.
     *
     * THE MISSION CLOCK AND THE OBJECTIVE PROGRESS ARE NOW SHOWN NOWHERE. That
     * is the point of this being one loud constant rather than four quiet
     * deletions: it is a decision somebody can find and reverse.
     */
    expect(HUD_PANEL_SHOWN).toBe(false)
  })

  it('and no section of it is drawn, whatever the section gate would have said', () => {
    /**
     * THE PANEL SWITCH SITS ABOVE THE SECTION GATE, not beside it. A header that
     * was not superseded by the rail is still not drawn, because the card it
     * lives on is not drawn — and `hudSectionShown` is what both `createHud` and
     * `update` ask, so it has to give that answer rather than the one it would
     * have given on a visible panel.
     */
    for (const section of HUD_SECTIONS) {
      expect(hudSectionShown(section)).toBe(false)
    }
  })

  it('but the section gate survives underneath it', () => {
    /**
     * WHAT SWITCHING THE CARD BACK ON MUST NOT ALSO BRING BACK. The pips and the
     * selector are duplicates of the rail whether or not the panel is shown;
     * folding them into the panel switch would mean anybody who ever wanted the
     * clock back got two roster readouts with it, and would have to rediscover
     * this whole ticket to work out why.
     */
    expect([...RAIL_SUPERSEDED].sort()).toEqual(['roster', 'selector'])
  })
})

describe('the gate itself', () => {
  it('names only sections the HUD actually has', () => {
    /**
     * A TYPO IN THE LIST IS OTHERWISE SILENT. `RAIL_SUPERSEDED` holding
     * `'selecter'` would hide nothing, fail nothing, and leave the selector on
     * screen — and the only symptom would be a duplicate readout nobody thought
     * to look for again.
     */
    for (const section of RAIL_SUPERSEDED) {
      expect(HUD_SECTIONS).toContain(section)
    }
  })

  it('and lists each of them once', () => {
    expect(new Set(RAIL_SUPERSEDED).size).toBe(RAIL_SUPERSEDED.length)
  })

  it('and answers for every section the HUD has', () => {
    // No section may fall through the gate undecided: a `HudSection` this
    // function has no answer for is a block whose fate is whatever `undefined`
    // happens to coerce to.
    for (const section of HUD_SECTIONS) {
      expect(hudSectionShown(section)).toBeTypeOf('boolean')
    }
  })

  it('and with the card off, that is every section there is', () => {
    const hidden = HUD_SECTIONS.filter((section: HudSection) => !hudSectionShown(section))
    expect([...hidden].sort()).toEqual([...HUD_SECTIONS].sort())
  })
})

describe('nothing is hidden that the rail does not really replace', () => {
  it('the rail draws a row per living man', () => {
    /**
     * READ FROM THE RAIL'S OWN SOURCE, not asserted about the HUD. The pips are
     * being taken away on the promise that something else shows the squad; if
     * `rollCall` ever stopped being what the rail draws, this ticket's premise
     * would be false and the player would have no roster at all.
     */
    const panel = readFileSync(new URL('../squad-panel.ts', import.meta.url), 'utf8')
    expect(panel).toContain('rollCall')
    expect(panel).toContain('squadRowCells')
  })

  it('and an icon for every weapon that is not the rifle', () => {
    /**
     * The selector listed every slot. The icons must cover the same ground, or
     * hiding it would leave a weapon the player can arm and cannot see.
     */
    expect(ORDNANCE_ICONS.map((icon) => icon.ordnance).sort()).toEqual(Object.keys(ORDNANCE).sort())
  })

  it('and the rail is what shows them, not some third thing', () => {
    const panel = readFileSync(new URL('../squad-panel.ts', import.meta.url), 'utf8')
    expect(panel).toMatch(/from '\.\/ordnance-icons'/)
  })
})

describe('hidden, not deleted', () => {
  const source = readFileSync(new URL('../hud.ts', import.meta.url), 'utf8')

  it('still builds the roster and the selector elements', () => {
    /**
     * "JUST HIDE IT IN CASE IT IS NEEDED" IS THE INSTRUCTION. Deleting the
     * elements would make this a revert-a-commit job rather than a flip-a-
     * constant one, and the pooling that keeps the HUD from reallocating a dozen
     * nodes a frame would have to be written again from scratch.
     */
    expect(source).toContain("document.createElement")
    expect(source).toMatch(/const roster = document\.createElement/)
    expect(source).toMatch(/const selector = document\.createElement/)
  })

  it('and keeps the pools that draw them', () => {
    expect(source).toMatch(/function pipAt\(/)
    expect(source).toMatch(/function slotAt\(/)
  })

  it('and hides them through the gate rather than by a hard-coded display', () => {
    /**
     * THE PIXELS AND THE WORK MUST COME BACK TOGETHER. A bare
     * `roster.style.display = 'none'` beside a loop that still runs is a node
     * being written to invisibly forever; a skipped loop beside a block that is
     * still shown is an empty panel the day somebody re-enables it. So the
     * predicate is asked more than once — at least where the block is hidden and
     * again where its per-frame loop is skipped.
     */
    const asked = source.match(/hudSectionShown\(/g) ?? []
    expect(asked.length).toBeGreaterThanOrEqual(4)
  })

  it('and the router cannot show the card past the switch', () => {
    /**
     * `app/main.ts` CALLS `setVisible(true)` ON EVERY MISSION and has no idea
     * this ticket happened — it asks for the HUD whenever the screen is the
     * mission, which is exactly right and must stay that way. So the switch is
     * honoured HERE, at the one place that writes the panel's `display`, rather
     * than by the caller remembering not to ask.
     */
    expect(source).toMatch(/HUD_PANEL_SHOWN/)
    expect(source).toMatch(/setVisible\(visible: boolean\)/)
  })

  it('and says so honestly when asked, which is what stops the per-frame work', () => {
    /**
     * `isVisible()` IS LOAD-BEARING AND NOT A CONVENIENCE. `main.ts` gates its
     * whole `hud.update(...)` — including building the model — on it, so a panel
     * that reported itself visible while showing nothing would go on formatting
     * a clock and a roster into invisible nodes sixty times a second. The cost
     * has to go with the pixels.
     */
    const main = readFileSync(new URL('../../app/main.ts', import.meta.url), 'utf8')
    expect(main).toMatch(/if \(hud\.isVisible\(\)\)/)
    // And the HUD is still BUILT and still DISPOSED — hidden, not deleted, all
    // the way up to the caller.
    expect(main).toMatch(/createHud\(mount\)/)
    expect(main).toMatch(/hud\.dispose\(\)/)
  })

  it('and skips the per-frame work for both of them', () => {
    // Named explicitly, so a gate that happened to be asked four times about the
    // objectives could not satisfy the count above.
    expect(source).toMatch(/hudSectionShown\('roster'\)/)
    expect(source).toMatch(/hudSectionShown\('selector'\)/)
  })
})

describe('what the rest of the game still reads off this file', () => {
  it('objectiveLabel keeps saying the same words as the briefing', () => {
    /**
     * `briefing.ts` imports this so the orders the player reads before the drop
     * and the objectives he reads during it are one table. Nothing about hiding
     * two blocks may take it away.
     */
    expect(objectiveLabel('kill_all')).toBe('Eliminate all enemies')
    // And an unknown type is still shown by its own name rather than swallowed.
    expect(objectiveLabel('escort_the_goat')).toBe('escort_the_goat')
  })
})
