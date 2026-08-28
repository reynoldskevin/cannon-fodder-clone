import { describe, it, expect } from 'vitest'
import {
  LOST_IN_SERVICE_TITLE,
  MEMORIAL_GOLD,
  MEMORIAL_SCRIM,
  MEMORIAL_TITLE_STYLE,
  MISSION_HEADING_STYLE,
  FALLEN_ROW_STYLE,
  FALLEN_NAME_STYLE,
  MEMORIAL_TITLE_STYLE as TITLE_FOR_SCALE,
  POPPY_LEFT_STYLE,
  POPPY_RIGHT_STYLE,
  ROLL_Z_INDEX,
  missionHeading,
} from '../lost-in-service'
import { DISPLAY_FONT } from '../display-font'
import { INSIGNIA_STYLE } from '../rank-insignia'
import { readFileSync } from 'node:fs'

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

describe('a man wears his insignia rather than being labelled with it (ticket 088)', () => {
  /**
   * THE ROLL WAS THE ONE SCREEN THAT SPELT THE RANK OUT. `squad-panel.ts` and
   * `boot-hill.ts` both draw the badge from `rank-insignia.ts` beside a name;
   * the memorial printed "Private Jools". The art and the index were already
   * there — `Grave` carries `rankIndex` — so this moves a rank from words into
   * the picture the rest of the game uses for it.
   */

  it('the name claims the middle, so a third child is not spread by the row', () => {
    /**
     * THE BUG TICKET 062 ALREADY HIT ON BOOT HILL, arriving here for the same
     * reason. `FALLEN_ROW_STYLE` is `justify-content:space-between`: with two
     * children that puts the name left and the count right, and with THREE it
     * spreads them evenly — badge left, name stranded in the middle, count
     * right. `flex:1` on the name is what keeps the badge next to it.
     */
    expect(FALLEN_NAME_STYLE).toContain('flex:1')
  })

  it('and the row centres its items, because a badge has no baseline', () => {
    /**
     * `align-items:baseline` was right for two spans of text. The badge is a
     * background on an EMPTY span, which has no text baseline to align to, so it
     * would sit wherever the box model left it — usually a little high. Both
     * other screens that draw this badge use `center`.
     */
    expect(row.get('align-items')).toBe('center')
  })

  it('and the roll asks `rank-insignia` for the badge instead of writing the word', () => {
    /**
     * READ FROM `menu.ts`'S SOURCE, because that is where the row is built and
     * `environment: 'node'` cannot import it — the same technique
     * `squad-panel.test.ts` uses, and the same reason.
     *
     * BOTH HALVES ARE ASSERTED. That the badge is drawn, and that the rank WORD
     * is gone: a build that added the insignia and left `rankAtDeath` in the
     * visible text would satisfy either half alone while changing nothing the
     * player would call a fix.
     */
    const menu = readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')
    expect(menu).toMatch(/insigniaPosition\(/)
    expect(menu).toContain('INSIGNIA_STYLE')
    /**
     * THE VISIBLE TEXT IS THE NAME AND NOTHING ELSE. Asserted on the ASSIGNMENT
     * rather than by searching the file for the old string — the rank still
     * appears in `menu.ts`, in the `title` two cases below, so a bare
     * `not.toContain` would fail on the very line that makes this accessible.
     * An earlier draft of this test did exactly that.
     */
    expect(menu).toMatch(/who\.textContent\s*=\s*man\.name\b/)
    expect(menu).not.toMatch(/textContent\s*=\s*`\$\{man\.rankAtDeath\}/)
  })

  it('and a man whose rank no longer exists gets no badge, not a wrong one', () => {
    /**
     * `Grave.rankIndex` IS `number | null`. A stone carved under a ladder the
     * game no longer has reports `null`, and `insigniaPosition` CLAMPS — it
     * would happily turn that into badge 0 and decorate a sergeant as a private.
     * Boot Hill already answers this by hiding the box, and the roll has to make
     * the same choice rather than inherit the clamp by accident.
     */
    const menu = readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')
    expect(menu).toMatch(/man\.rankIndex === null/)
  })

  it('and the rank is moved out of sight, not out of existence', () => {
    /**
     * THE FAILURE THIS TICKET COULD EASILY HAVE SHIPPED. Boot Hill marks its
     * badge `aria-hidden` and calls it decorative — which is only honest because
     * the row carries the rank in its `title` as well. Hiding the badge here
     * WITHOUT that would delete the rank for a screen reader rather than show it
     * differently, and nothing on screen would look wrong.
     */
    const menu = readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')
    /**
     * NAMED ON THE BADGE, not searched for anywhere in the file. An earlier
     * draft matched a bare /aria-hidden/ and SURVIVED the mutant that removed
     * the badge's — because `menu.ts` already hides the decorative poppies, so
     * the regex was answering a question about a different element entirely.
     */
    expect(menu).toMatch(/insignia\.setAttribute\('aria-hidden'/)
    expect(menu).toMatch(/title\s*=\s*`\$\{man\.rankAtDeath\} \$\{man\.name\}`/)
  })
})

describe('the roll is set large enough to be the subject (ticket 089)', () => {
  /**
   * THE NAMES WERE THE SMALLEST THING ON A SCREEN ABOUT THE NAMES — a row at
   * `clamp(0.9rem, 2vw, 1.1rem)` under a title reaching 3.4rem. Ticket 089
   * doubled both roll sizes; ticket 090 then took them back down a quarter, so
   * the numbers below are 089's doubling times 0.75. The title has never moved:
   * it is already the largest element and would overflow a narrow viewport.
   *
   * THE STOPS ARE PINNED AS WRITTEN so a retune is a deliberate edit here rather
   * than a drift nobody notices. What the ROW is worth in itself is checked in
   * ticket 090's group below, against the badge that hangs off it.
   */

  /** The three stops of a `clamp(min, preferred, max)`, as written. */
  const clampStops = (style: string): readonly string[] => {
    const found = /font-size:clamp\(([^)]*)\)/.exec(style)
    if (found === null) throw new Error(`no clamped font-size in: ${style}`)
    return (found[1] as string).split(',').map((s) => s.trim())
  }

  it('a fallen row is set at the roll scale, at every stop', () => {
    /**
     * ALL THREE STOPS, NEVER JUST THE CEILING. A `clamp` is a floor, a
     * viewport-relative preference and a ceiling, and a phone sits on the floor
     * or the `vw` term — so resizing only the maximum changes nothing at all on
     * the narrow screens the roll is hardest to read on, while looking like a
     * change on a desktop. True of 089's doubling and of 090's reduction alike.
     */
    expect(clampStops(FALLEN_ROW_STYLE)).toEqual(['1.35rem', '3vw', '1.65rem'])
  })

  it('and a mission heading tracks it, so the roll keeps its hierarchy', () => {
    // Doubled in 089, then brought down a quarter in 090 — always together with
    // the row, or the headings end up smaller than the names they introduce.
    expect(clampStops(MISSION_HEADING_STYLE)).toEqual(['1.425rem', '3.3vw', '1.875rem'])
  })

  it('and the heading still outranks the row it heads', () => {
    /**
     * THE RELATIONSHIP, NOT THE NUMBERS. Stated separately because the two cases
     * above would both pass if the pair were doubled into the wrong order — and
     * a heading set smaller than its list is the one outcome that would look
     * like a bug rather than a resize.
     */
    const rem = (stop: string): number => Number(stop.replace('rem', ''))
    const row = clampStops(FALLEN_ROW_STYLE)
    const heading = clampStops(MISSION_HEADING_STYLE)
    expect(rem(heading[2] as string)).toBeGreaterThan(rem(row[2] as string))
  })

  it('but the title is untouched — the roll rises toward it, not everything away', () => {
    expect(clampStops(TITLE_FOR_SCALE)).toEqual(['1.9rem', '6vw', '3.4rem'])
  })
})

describe('and the insignia doubles with the row rather than separately', () => {
  it('because the badge is sized in `em`, which is what makes this two numbers', () => {
    /**
     * THE MECHANISM, PINNED. `INSIGNIA_STYLE` is `1.05em x 1.4em` and therefore
     * tracks whatever `font-size` its row carries — so the doubling above
     * reaches the badge for free.
     *
     * AND IT MUST STAY THAT WAY FOR A SECOND REASON. `squad-panel.ts` and
     * `boot-hill.ts` draw from this same constant: sizing the memorial's badge
     * HERE would grow the roster chevrons and the Boot Hill stones as a side
     * effect. A `px` value would break the scaling and leak the change at once.
     */
    expect(INSIGNIA_STYLE).toContain('width:1.05em')
    expect(INSIGNIA_STYLE).toContain('height:1.4em')
    expect(INSIGNIA_STYLE).not.toMatch(/width:[\d.]+px|height:[\d.]+px/)
  })
})

describe('the text is a quarter down from 089, and the badge a quarter down from 090', () => {
  /**
   * TWO TICKETS, ONE ARITHMETIC. 090 shrank the TEXT 25% and held the badge
   * still, which it did by widening the badge's `em` box by `1 / 0.75`. 091 then
   * brought the BADGE down by the same quarter — which cancels that factor
   * exactly and lands back on the shared `1.05em x 1.4em`.
   *
   * So the second change was a DELETION, and these cases exist to keep it one:
   * a memorial-only override restating `1.05em` would be two values that agree
   * today and drift the first time either moves.
   */

  /** The three stops of a `clamp(min, preferred, max)`, as written. */
  const clampStops = (style: string): readonly string[] => {
    const found = /font-size:clamp\(([^)]*)\)/.exec(style)
    if (found === null) throw new Error(`no clamped font-size in: ${style}`)
    return (found[1] as string).split(',').map((s) => s.trim())
  }

  const remOf = (stop: string): number => Number(stop.replace('rem', ''))

  /**
   * The style a memorial badge actually ends up with, resolved from the SOURCE.
   *
   * TWO EARLIER DRAFTS OF THIS CASE WERE VACUOUS, which is why it is built this
   * way. The first compared two literals (`1.05 * 1.35` against
   * `1.4 * 1.35 * 0.75`) — arithmetic true whatever the code does. The second
   * read `menu.ts`'s template, which names its style constant by IDENTIFIER, so
   * an override defined elsewhere never appeared in the captured text.
   *
   * So: find which constant `menu.ts` names, then go and read THAT constant's
   * box — from `lost-in-service.ts` if it is a memorial-local one, or from the
   * shared import if it is not.
   */
  const memorialBadgeStyle = (): string => {
    const menu = readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')
    const named = /insignia\.style\.cssText =[\s\S]*?\$\{(\w+)\}/.exec(menu)?.[1]
    if (named === undefined) throw new Error('no style constant named for the memorial badge')
    if (named === 'INSIGNIA_STYLE') return INSIGNIA_STYLE
    const lis = readFileSync(new URL('../lost-in-service.ts', import.meta.url), 'utf8')
    const body = new RegExp(`export const ${named} = ([\\s\\S]*?)\n\n`).exec(lis)?.[1]
    if (body === undefined) throw new Error(`cannot resolve ${named}`)
    return `${INSIGNIA_STYLE};${body}`
  }

  /** The `em` box a style string ends up with, last declaration winning. */
  const emBox = (style: string): { width: number; height: number } => {
    const all = [...style.matchAll(/(width|height):([\d.]+)em/g)]
    const last = (which: string): number => {
      const hits = all.filter((m) => m[1] === which)
      const found = hits[hits.length - 1]
      if (found === undefined) throw new Error(`no ${which} in em: ${style}`)
      return Number(found[2])
    }
    return { width: last('width'), height: last('height') }
  }

  it('the row text is where ticket 090 left it — this ticket did not touch type', () => {
    expect(clampStops(FALLEN_ROW_STYLE)).toEqual(['1.35rem', '3vw', '1.65rem'])
  })

  it('and the badge renders at three quarters of what 090 held it to', () => {
    /**
     * ASSERTED AS A PRODUCT, for the reason 090's version of this case gave: `em`
     * times `font-size` is the rendered box, so a test pinning `1.05em` alone
     * would pass just as happily if the row size moved underneath it.
     *
     * 090 held the badge at 1.4em x 1.8666667em against clamp(1.35rem, ..., 1.65rem).
     */
    const box = emBox(memorialBadgeStyle())
    const row = clampStops(FALLEN_ROW_STYLE)
    const heldMin = 1.4 * 1.35
    const heldMax = 1.8666667 * 1.65
    expect(box.width * remOf(row[0] as string)).toBeCloseTo(heldMin * 0.75, 5)
    expect(box.height * remOf(row[2] as string)).toBeCloseTo(heldMax * 0.75, 5)
  })

  it('and it gets there by using the shared box, not by restating it', () => {
    /**
     * THE DELETION, PINNED. `1.05em x 1.4em` is already what `INSIGNIA_STYLE`
     * says; a memorial-only override spelling the same numbers again would be a
     * second copy of a shared constant — the "two values that agree today" shape
     * this project keeps meeting. So the override must be GONE, not retuned.
     */
    const source = readFileSync(new URL('../lost-in-service.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('MEMORIAL_INSIGNIA_STYLE')
    const menu = readFileSync(new URL('../menu.ts', import.meta.url), 'utf8')
    expect(menu).toContain('INSIGNIA_STYLE')
    expect(menu).not.toContain('MEMORIAL_INSIGNIA_STYLE')
  })

  it('and the shared constant itself is untouched, so two other screens hold still', () => {
    // The memorial is REJOINING the squad panel and Boot Hill here, not dragging
    // them with it.
    expect(INSIGNIA_STYLE).toContain('width:1.05em')
    expect(INSIGNIA_STYLE).toContain('height:1.4em')
  })
})
