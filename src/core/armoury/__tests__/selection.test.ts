import { describe, it, expect } from 'vitest'
import { createArmoury, ordnanceForHotkey, selectorLine, RIFLE_ORDNANCE } from '../index'

/**
 * Ticket 016 — which weapon the squad is holding, and how the HUD says so.
 *
 * WHY THE DECISION IS IN CORE AND NOT IN `src/ui`. Vitest runs under
 * `environment: 'node'`: there is no DOM at test time, `src/ui` has no tests at
 * all, and even `formatMissionTime` is uncovered for that reason. A selector
 * built inside `hud.ts` would ship with its acceptance criterion unverifiable.
 *
 * So this follows the split ticket 014 established between `core/debug/layers.ts`
 * and `ui/debug-panel.ts`: the pure decision — the ordered entries, their
 * counts, which is active, what each row reads as — lives here and is tested;
 * `hud.ts` only writes it into elements. That is not a workaround for the test
 * environment, it is the reason the debug overlay was built that way.
 */

const armoury = () => createArmoury({ starting: { grenade: 4, rocket: 2 } })

describe('what is selected', () => {
  it('starts on the rifle', () => {
    // The weapon that always works and can never run out. Starting on ordnance
    // would mean a fresh squad's first right-click spends a grenade.
    expect(armoury().selected).toBe(RIFLE_ORDNANCE)
  })

  it('selects by name', () => {
    const a = armoury()
    expect(a.select('grenade')).toBe(true)
    expect(a.selected).toBe('grenade')
  })

  it('refuses a name that is not an option, and keeps the one it had', () => {
    const a = armoury()
    a.select('grenade')
    expect(a.select('howitzer')).toBe(false)
    expect(a.selected).toBe('grenade')
  })

  it('lets you select ordnance you have run out of', () => {
    /**
     * DELIBERATE. Selecting an empty pouch and being told it is empty is how a
     * player learns they are out; silently refusing to select it means the
     * weapon simply vanishes from the game with no explanation. The refusal
     * belongs at the moment of FIRING, where it can be reported.
     */
    const a = createArmoury({ starting: { grenade: 0 } })
    expect(a.select('grenade')).toBe(true)
    expect(a.selected).toBe('grenade')
  })
})

describe('the hotkeys', () => {
  it('1 is the rifle', () => {
    expect(ordnanceForHotkey('1')).toBe(RIFLE_ORDNANCE)
  })

  it('every entry has a hotkey, and they are all different', () => {
    const keys = armoury()
      .slots()
      .map((s) => s.hotkey)
    expect(keys.every((k) => k.length > 0)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every slot`s hotkey actually resolves back to that slot', () => {
    /**
     * The mutation ticket 014 caught in its own hotkey table: `layerForHotkey`
     * could be replaced with `return undefined` and the whole suite stayed
     * green, leaving "every key on the legend works" entirely unverified on a
     * tool whose only controls ARE the keys. The same trap is here.
     */
    for (const slot of armoury().slots()) {
      expect({ key: slot.hotkey, resolved: ordnanceForHotkey(slot.hotkey) }).toEqual({
        key: slot.hotkey,
        resolved: slot.ordnance,
      })
    }
  })

  it('a key that selects nothing resolves to nothing', () => {
    for (const key of ['0', '9', 'a', '', 'Enter', 'Shift']) {
      expect({ key, resolved: ordnanceForHotkey(key) }).toEqual({ key, resolved: undefined })
    }
  })
})

describe('cycling, which is what the wheel does', () => {
  it('goes forward through every entry and comes back round', () => {
    const a = armoury()
    const seen = [a.selected]
    for (let i = 0; i < a.slots().length - 1; i += 1) {
      a.cycle(1)
      seen.push(a.selected)
    }
    expect(new Set(seen).size).toBe(a.slots().length)
    a.cycle(1)
    expect(a.selected).toBe(seen[0])
  })

  it('goes backward too', () => {
    const a = armoury()
    a.cycle(1)
    const forward = a.selected
    a.cycle(-1)
    expect({ forward, back: a.selected }).toEqual({ forward, back: RIFLE_ORDNANCE })
  })

  it('wraps backward off the front rather than falling off it', () => {
    // `(-1) % n` is `-1` in JavaScript, not `n - 1`. Indexing an array with it
    // gives `undefined`, and the selection becomes nothing at all.
    const a = armoury()
    a.cycle(-1)
    const slots = a.slots()
    expect(a.selected).toBe(slots[slots.length - 1]?.ordnance)
  })

  it('a delta of zero changes nothing', () => {
    const a = armoury()
    a.select('grenade')
    a.cycle(0)
    expect(a.selected).toBe('grenade')
  })

  it('survives a wildly out-of-range delta', () => {
    // A trackpad can deliver a large wheel delta in one event.
    const a = armoury()
    a.cycle(1000)
    expect(a.slots().some((s) => s.ordnance === a.selected)).toBe(true)
    a.cycle(-1000)
    expect(a.slots().some((s) => s.ordnance === a.selected)).toBe(true)
  })

  it('cycles in the same order the HUD lists them', () => {
    // Otherwise the wheel appears to jump around the selector at random.
    const a = armoury()
    const order = a.slots().map((s) => s.ordnance)
    const walked = [a.selected]
    for (let i = 0; i < order.length - 1; i += 1) {
      a.cycle(1)
      walked.push(a.selected)
    }
    expect(walked).toEqual(order)
  })
})

describe('the HUD model', () => {
  it('lists the rifle first', () => {
    expect(armoury().slots()[0]?.ordnance).toBe(RIFLE_ORDNANCE)
  })

  it('lists ordnance after it, and includes both weapons the ticket names', () => {
    const names = armoury()
      .slots()
      .map((s) => s.ordnance)
    expect(names).toContain('grenade')
    expect(names).toContain('rocket')
  })

  it('marks exactly one slot active, and it is the selected one', () => {
    const a = armoury()
    a.select('rocket')
    const active = a.slots().filter((s) => s.active)
    expect(active).toHaveLength(1)
    expect(active[0]?.ordnance).toBe('rocket')
  })

  it('carries the live count, not the starting one', () => {
    const a = armoury()
    a.consume('grenade')
    expect(a.slots().find((s) => s.ordnance === 'grenade')?.count).toBe(3)
  })

  it('marks the rifle unlimited and the ordnance not', () => {
    const slots = armoury().slots()
    expect(slots.find((s) => s.ordnance === RIFLE_ORDNANCE)?.unlimited).toBe(true)
    expect(slots.find((s) => s.ordnance === 'grenade')?.unlimited).toBe(false)
  })

  it('hands back a fresh model each time', () => {
    // The renderer holds this across a frame. Handing back the live array is the
    // aliasing bug the tracer buffer and the ordnance system have each already
    // had once.
    const a = armoury()
    const held = a.slots()
    const before = held.find((s) => s.ordnance === 'grenade')?.count
    a.consume('grenade')
    expect(held.find((s) => s.ordnance === 'grenade')?.count).toBe(before)
    expect(a.slots()).not.toBe(held)
  })
})

describe('the line each slot reads as', () => {
  it('names the weapon', () => {
    const slot = armoury()
      .slots()
      .find((s) => s.ordnance === 'grenade')
    expect(slot).toBeDefined()
    expect(selectorLine(slot!).toLowerCase()).toContain('grenade')
  })

  it('shows the count', () => {
    const a = armoury()
    const slot = a.slots().find((s) => s.ordnance === 'rocket')
    expect(selectorLine(slot!)).toContain('2')
  })

  it('shows no number for the unlimited rifle', () => {
    // "Rifle 0" would read as an empty weapon, which is the opposite of true.
    const slot = armoury()
      .slots()
      .find((s) => s.ordnance === RIFLE_ORDNANCE)
    expect(selectorLine(slot!)).not.toMatch(/\d/)
  })

  it('distinguishes the active slot from the rest', () => {
    // The one thing the selector exists to communicate. Without this the player
    // cannot tell what a right-click is about to do.
    const a = armoury()
    a.select('grenade')
    const slots = a.slots()
    const active = selectorLine(slots.find((s) => s.active)!)
    const idle = selectorLine(slots.find((s) => !s.active && s.ordnance === 'rocket')!)
    expect(active).not.toBe(idle)
  })

  it('an empty pouch still renders, showing zero', () => {
    const a = createArmoury({ starting: { grenade: 0 } })
    const slot = a.slots().find((s) => s.ordnance === 'grenade')
    expect(slot).toBeDefined()
    expect(selectorLine(slot!)).toContain('0')
  })
})
