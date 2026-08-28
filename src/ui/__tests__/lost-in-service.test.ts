import { describe, it, expect } from 'vitest'
import {
  LOST_IN_SERVICE_TITLE,
  MEMORIAL_GOLD,
  MEMORIAL_SCRIM,
  MEMORIAL_TITLE_STYLE,
  MISSION_HEADING_STYLE,
  FALLEN_ROW_STYLE,
  POPPY_LEFT_STYLE,
  POPPY_RIGHT_STYLE,
  ROLL_Z_INDEX,
  missionHeading,
} from '../lost-in-service'
import { DISPLAY_FONT } from '../display-font'

/**
 * Ticket 073 — the campaign end screen as a memorial.
 *
 * STRING ASSERTIONS FOR THE SAME REASON AS EVERY OTHER `src/ui` TEST.
 * `vitest.config.ts` sets `environment: 'node'` and there is no jsdom, so a
 * module that touches the DOM in its body cannot be imported at all.
 * `mission-banner.ts` and `rank-insignia.ts` set the pattern this follows: the
 * decisions live in exported constants and pure functions, the `document` calls
 * stay inside `menu.ts`'s factory, and what is testable here is everything the
 * screen means rather than everything it draws.
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

const title = declarations(MEMORIAL_TITLE_STYLE)
const heading = declarations(MISSION_HEADING_STYLE)
const row = declarations(FALLEN_ROW_STYLE)
const left = declarations(POPPY_LEFT_STYLE)
const right = declarations(POPPY_RIGHT_STYLE)

describe('the screen is titled for the men, not for the player', () => {
  it('reads LOST IN SERVICE', () => {
    // `assets/mockups/end-screen.png`. The screen previously said "Campaign
    // complete", which is a status line about the PLAYER's progress printed over
    // a list of his dead.
    expect(LOST_IN_SERVICE_TITLE).toBe('LOST IN SERVICE')
  })

  it('in the display face, like every other title in the game', () => {
    expect(title.get('font-family')).toBe(DISPLAY_FONT)
  })

  it('and in gold, which is the one warm colour on a black screen', () => {
    /**
     * COMPARED AGAINST THE EXPORTED CONSTANT, not a literal, so the plaque and
     * the title cannot drift into two nearly-identical golds. It must also not
     * be one of the shared status colours — `GOOD` green would read as a result
     * and `BAD` orange as a warning, and this is neither.
     */
    expect(title.get('color')).toBe(MEMORIAL_GOLD)
    expect(MEMORIAL_GOLD).toMatch(/^#[0-9a-f]{6}$/i)
    expect(MEMORIAL_GOLD).not.toBe('#8fd694')
    expect(MEMORIAL_GOLD).not.toBe('#ff8f6b')
  })

  it('and larger than the mission headings under it', () => {
    // The hierarchy the mockup has: one title, then the missions, then the men.
    const sizeOf = (css: Map<string, string>): number =>
      Number(/([\d.]+)rem\s*\)?\s*$/.exec(css.get('font-size') ?? '')?.[1] ?? '0')
    expect(sizeOf(title)).toBeGreaterThan(sizeOf(heading))
    expect(sizeOf(heading)).toBeGreaterThan(0)
  })
})

describe('a mission heading names the mission', () => {
  it('counts from one, the way the player counts levels', () => {
    expect(missionHeading(1)).toBe('Mission 1')
    expect(missionHeading(9)).toBe('Mission 9')
  })

  it('and never prints a fraction of one', () => {
    /**
     * `diedOnLevel` REACHES THIS FROM A SAVE FILE. `parseState` bounds
     * `unlockedLevels` below and no further, which is the same hole
     * `campaignSummary` floors `levelsCompleted` for — "Mission 2.5" is a
     * sentence no memorial should print.
     */
    expect(missionHeading(2.5)).toBe('Mission 2')
    expect(missionHeading(Number.NaN)).toBe('Mission 1')
    expect(missionHeading(-3)).toBe('Mission 1')
  })
})

describe('the poppies flank the roll without touching it', () => {
  it('and the right one is mirrored, so they lean apart rather than repeat', () => {
    /**
     * ONE ASSET, TWO SIDES. The mockup's poppies are a mirrored pair; shipping a
     * second PNG for it would be 160kB to say `scaleX(-1)`.
     */
    expect(right.get('transform')).toMatch(/scaleX\(\s*-1\s*\)/)
    expect(left.get('transform') ?? '').not.toMatch(/scaleX\(\s*-1\s*\)/)
  })

  it('one against each edge', () => {
    expect(left.get('left')).toBeDefined()
    expect(left.get('right')).toBeUndefined()
    expect(right.get('right')).toBeDefined()
    expect(right.get('left')).toBeUndefined()
  })

  it('sized by HEIGHT, because the flower is a tall stem in a square frame', () => {
    /**
     * MEASURED OFF `poppy.png`: 1024x1024, with the opaque pixels confined to
     * x339-641 and y111-993. Sizing it by width would make the visible flower a
     * third of what was asked for and leave two thirds of the box as empty
     * padding shoving the roll inward.
     */
    expect(left.get('height')).toBeDefined()
    expect(left.get('width')).toBe('auto')
  })

  it('swallowing no clicks, and never covering the roll', () => {
    /**
     * THE FAILURE THIS PREVENTS IS A DEAD SCREEN. The roll scrolls when a
     * campaign is long, and the buttons sit under it; a decorative image on top
     * of either — even a mostly transparent one, since a PNG's transparent
     * pixels still take the mouse — is a screen the player cannot leave.
     * `briefing.ts` records the game already shipping one unclickable button.
     */
    for (const poppy of [left, right]) {
      expect(poppy.get('pointer-events')).toBe('none')
      expect(Number(poppy.get('z-index'))).toBeLessThan(ROLL_Z_INDEX)
    }
  })
})

describe('and the dead are readable over it', () => {
  it('a man and his kill count sit at opposite ends of his row', () => {
    // The mockup's rows are a plaque with the name centred and marks either
    // side. Ours carries a number, so it goes to the far end where a column of
    // them lines up and can be compared down the list.
    expect(row.get('display')).toBe('flex')
    expect(row.get('justify-content')).toBe('space-between')
  })

  it('and the screen behind them is nearly black, not the jungle', () => {
    /**
     * THE MEMORIAL IS NOT THE TITLE CARD. The Menu's own scrim clears to 25%
     * through the middle so the marching cast reads against the jungle; this one
     * has to bury it. Asserted as a NUMBER rather than by eye: an "almost
     * opaque" gradient that drifted back to 0.6 would put leaves behind a list
     * of the dead and nothing would fail.
     */
    const alphas = [...MEMORIAL_SCRIM.matchAll(/rgba\([^)]*?,\s*([\d.]+)\s*\)/g)].map((m) =>
      Number(m[1]),
    )
    expect(alphas.length).toBeGreaterThan(0)
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.9)
  })
})
