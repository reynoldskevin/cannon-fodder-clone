/**
 * BOOT HILL (ticket 022, redrawn to the original's own screen in 054).
 *
 * `assets/mockups/boot-hill.jpg` is the screen this is now built to: a black
 * scoreboard across the top reading HOME <kills> : <deaths> AWAY, a roster
 * column down the left with HEROES over SQUAD, and the hill itself filling the
 * rest — a field of white crosses, one per man who has died.
 *
 * THE HILL IS A SECOND VIEW OF THE SAME LIST, NEVER THE ONLY ONE. Every man on
 * it is also a bar in the HEROES column carrying his name and his tally, with
 * his rank and the level he fell on on the row's `title`; the crosses are the
 * picture and the column is the record.
 * A memorial that said "twelve" only by drawing twelve marks would be
 * unreadable to a screen reader and unreadable to anybody counting.
 *
 * DRAWS `BootHillModel` AND DECIDES NOTHING. Which men are on the hill, in what
 * order, what each stone says, which stones are new, who is still standing and
 * both scoreboard numbers are answered in `src/core/campaign/boothill.ts`, where
 * Vitest can see them under Node. Nothing in `src/ui` is unit-tested — Vitest
 * runs `environment: 'node'` — so anything decided here would be verified by
 * looking at the screen and nowhere else.
 *
 * WHERE THE CROSSES STAND IS THIS FILE'S BUSINESS AND NOBODY ELSE'S. A grave's
 * position on a hillside is not a campaign fact; it is scenery, and putting it
 * in the model would mean `core` owning a layout it cannot see. It is derived
 * from the man's INDEX rather than from anything random, so the hill a player
 * left is the hill he comes back to — see `plot`.
 *
 * DOM APIs and inline styles, matching `hud.ts` and the campaign screens, so the
 * UI layer ships no stylesheet. ELEMENTS ARE REUSED AND TEXT IS WRITTEN ONLY ON
 * CHANGE, the same bargain the HUD makes: the hill grows by a stone or two a
 * mission, and rebuilding every row would throw away and reallocate the whole
 * memorial to add one name to the end of it.
 */

import { createChrome } from './screen-chrome'
import { DISPLAY_FONT, loadDisplayFont } from './display-font'
import hillUrl from '../../assets/source/hill-path-background.webp?url'
import type { BootHillModel, Grave, Promotion, Trooper } from '../core/campaign'

export interface BootHillOptions {
  /**
   * Leave the memorial and go on to the next thing.
   *
   * Where that goes is `core/flow`'s answer, not this file's: Boot Hill leads to
   * Recruitment mid-campaign and to the Menu when the campaign is over, and a
   * screen that chose between them would be a second copy of the flow graph.
   */
  readonly onContinue: () => void
  /** What the button says. The flow knows where it leads; this file does not. */
  readonly continueLabel?: string
}

export interface BootHillScreen {
  /** Redraw from `model`. Safe to call repeatedly; rows are reused. */
  update(model: BootHillModel): void
  /**
   * Take the screen down and stop the Continue button firing. Safe to call
   * twice, and safe to call while a click is still reachable — both the removal
   * and `onContinue` are behind one flag, so nothing runs a second time.
   */
  dispose(): void
}

/** Matched to the HUD and `screen-chrome.ts`, so the game has one palette. */
const TEXT = '#f2efe6'
const MUTED = '#9fb3bd'
const PROMOTED = '#8fd694'
/** The colour of a fresh stone. The same warm one the lose screen uses. */
const FRESH = '#ff8f6b'
/** The original's panel headings are gold on black. These two are the only ones. */
const HEADING = '#f2c14e'

/**
 * The hillside itself (ticket 057).
 *
 * THE PAINTED ONE AT LAST. Ticket 054 shipped a CSS sky and two radial mounds
 * because no such asset existed; this is that placeholder retired.
 *
 * WEBP, NOT THE PNG CUT IT ARRIVED AS (ticket 058). Same picture, 144 KB rather
 * than 1.2 MB — which on a screen the player meets between missions is most of
 * the reason it appears at all rather than a frame later.
 *
 * `cover` AND BOTTOM-ANCHORED, which is the whole reason it is not `center`: the
 * art is a horizon in its top third and a foreground of grass and poppies along
 * its bottom edge, and a window shorter than the image crops from wherever it is
 * told to. Cropping off the top loses sky nobody was reading; cropping off the
 * bottom loses the ground the crosses stand on, which is the picture.
 */
const HILL_IMAGE = `url(${hillUrl})`

/**
 * What the sky and the grass are, underneath the picture.
 *
 * TWO BANDS MATCHED TO THE ART, on the same 35% line its horizon sits on. They
 * are what shows on the first frame before the image has decoded, and what shows
 * for good if it never does — a hillside that is dark green under a slate sky
 * rather than a black rectangle with white crosses floating on it.
 */
const HILL_FALLBACK = 'linear-gradient(#39414d 0%, #39414d 35%, #2c3a24 35%, #1d2a17 100%)'

const LIST_STYLE =
  'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.15rem'

/**
 * One roster row, as the original draws it: a BAR, not a bullet (ticket 058).
 *
 * NAME LEFT, TALLY RIGHT, AND NOTHING ELSE ON THE LINE. The mockup's column is a
 * stack of plaques four characters wide at the name and two at the number; the
 * rank and the level a man fell on used to ride along in front of the name and
 * wrapped every row on a narrow window, which is what turned a scoreboard back
 * into prose. Both still reach anyone who wants them, through the row's `title`
 * — see `graveLine`.
 */
const ROW_STYLE = [
  'display:flex',
  'align-items:center',
  'justify-content:space-between',
  'gap:0.5rem',
  'padding:0.1rem 0.4rem',
  'background:rgba(58,62,44,0.85)',
  'border:1px solid rgba(242,193,78,0.22)',
  `font-family:${DISPLAY_FONT}`,
  'font-size:clamp(0.85rem, 2vw, 1.05rem)',
  'letter-spacing:0.06em',
].join(';')

/** Write `text` into `node` only when it has actually changed. See `hud.ts`. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/**
 * One stone, as a line: who he was, what he was, where he fell and what it cost
 * the other side.
 *
 * A PURE STRING FUNCTION so the wording is one expression rather than four
 * appends — and so the only thing the row element does is hold it.
 */
export function graveLine(grave: Grave): string {
  const kills = grave.kills === 1 ? '1 kill' : `${String(grave.kills)} kills`
  return `${grave.rankAtDeath} ${grave.name} — fell on level ${String(grave.diedOnLevel)}, ${kills}`
}

/** One promotion, with BOTH ranks: the change is the news, not the new title. */
export function promotionLine(promotion: Promotion): string {
  return `${promotion.name}: ${promotion.from} → ${promotion.to}`
}

/**
 * Where the nth cross stands, as percentages of the hillside.
 *
 * DERIVED FROM THE INDEX, NOT DRAWN AT RANDOM. `Math.random` here would move
 * every grave on the hill each time the screen was shown — a memorial that
 * rearranges its own dead between two viewings a minute apart. Index-derived, a
 * man keeps his plot for the life of the campaign, and the same campaign draws
 * the same hill on any machine.
 *
 * THE MULTIPLIERS ARE IRRATIONAL-ISH ON PURPOSE. Two arithmetic sequences would
 * lay the crosses out on a visible diagonal; stepping by fractions that do not
 * divide into one another scatters them without a pattern the eye catches, and
 * without a random number generator to seed.
 *
 * IT IS ALLOWED TO COLLIDE. Two crosses close together on a busy hill reads as a
 * graveyard; the arithmetic to guarantee spacing would need to know the hill's
 * pixel size, which is a viewport away from anything this function is handed.
 */
export function plot(index: number): { left: number; top: number } {
  const across = (index * 0.618033) % 1
  const down = (index * 0.381966 + 0.13) % 1
  return {
    // Kept off both edges: a cross half off the side of the hill reads as a
    // clipping bug rather than as a distant grave.
    left: 6 + across * 84,
    /**
     * BELOW THE HORIZON, WITH ROOM TO SPARE. The art's skyline sits around 35%
     * of the picture, and the picture is `cover`-cropped to the panel — on a
     * wide, short window the crop lifts that line further up the element. The
     * band starts well under it so a cross cannot end up hanging in the clouds,
     * which is the one placement that reads as a bug rather than as a distance.
     */
    top: 46 + down * 46,
  }
}

export function createBootHill(mount: HTMLElement, options: BootHillOptions): BootHillScreen {
  // THE SHARED SURFACE, NOT A COPY OF IT (ticket 043). This file used to
  // transcribe the backdrop and panel styles itself, which is precisely how the
  // memorial could have stayed a translucent overlay after the shared value was
  // made opaque — two spellings, one of them fixed. `createChrome` sets the
  // role, the `aria-modal="false"` and the label this screen used to set by hand.
  const { backdrop, panel } = createChrome('Boot Hill')

  // The card and the memorial are set in the same face. See `display-font.ts`;
  // it registers once however many screens ask.
  loadDisplayFont()

  /**
   * THE WHOLE WINDOW, WHICH THE SHARED COLUMN IS NOT. `PANEL_STYLE` is a
   * left-indented reading column of `min(46rem, 100%)` — right for the Menu's
   * notice, wrong for a screen that is a scoreboard, a roster column and a
   * hillside. Overridden on the instance, as the Menu and the Briefing override
   * it: the shared value stays what those screens are built from.
   */
  panel.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'width:100%',
    'max-height:100%',
    'gap:0',
    'pointer-events:auto',
    'overflow:hidden',
  ].join(';')
  backdrop.style.padding = '0'

  /**
   * HOME <kills> : <deaths> AWAY.
   *
   * MY TEAM'S KILLS AGAINST MY SQUAD'S DEATHS, which is the original's own
   * arithmetic and is why the two numbers can be wildly different sizes without
   * either being wrong. Both come from `campaignSummary` through the model, so
   * the memorial and the Menu's end-of-campaign totals cannot disagree.
   */
  const scoreboard = document.createElement('div')
  scoreboard.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'gap:clamp(1rem, 5vw, 4rem)',
    'padding:0.4rem 1rem',
    'background:#000',
    `color:${TEXT}`,
    `font-family:${DISPLAY_FONT}`,
    'font-size:clamp(1.1rem, 3.2vw, 2rem)',
    'letter-spacing:0.08em',
    'flex:none',
  ].join(';')

  const homeLabel = document.createElement('span')
  homeLabel.textContent = 'HOME'
  const awayLabel = document.createElement('span')
  awayLabel.textContent = 'AWAY'
  /**
   * The score itself, as ONE element and one string.
   *
   * `272 : 13` is read as a single figure, and two spans with a colon between
   * them would let the gap between "home" and "away" drift with the font. It is
   * also the only text on this screen that changes every mission, so writing it
   * in one place is what `setText` is for.
   */
  const score = document.createElement('span')
  scoreboard.append(homeLabel, score, awayLabel)

  /** The scoreboard, the roster and the hill, in that order down the screen. */
  const body = document.createElement('div')
  body.style.cssText = 'display:flex;flex:1;min-height:0'

  /**
   * The roster column: HEROES over SQUAD, as the original has it.
   *
   * SCROLLS ON ITS OWN rather than growing the screen. The hill GROWS across a
   * campaign and by level five the dead outnumber a screenful; a memorial whose
   * Continue button had been pushed off the bottom would strand the player on
   * it.
   */
  const roster = document.createElement('aside')
  roster.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'gap:0.35rem',
    'width:clamp(11rem, 22vw, 16rem)',
    'flex:none',
    'padding:0.5rem 0.6rem 1rem',
    'overflow-y:auto',
    'background:#0a0d0b',
    'border-right:1px solid rgba(159,179,189,0.35)',
  ].join(';')

  /** One gold bar over a list, in the original's own hand. */
  const sectionHeading = (text: string): HTMLElement => {
    const bar = document.createElement('h2')
    bar.textContent = text
    bar.style.cssText = [
      'margin:0.35rem 0 0.15rem',
      `color:${HEADING}`,
      `font-family:${DISPLAY_FONT}`,
      'font-size:clamp(1rem, 2.6vw, 1.4rem)',
      'letter-spacing:0.1em',
      'text-align:center',
      'border-bottom:1px solid rgba(242,193,78,0.4)',
    ].join(';')
    return bar
  }

  const heroesHeading = sectionHeading('HEROES')
  /**
   * NO EMPTY-STATE LINE AND NO COUNT (tickets 058 and 060). "5 men lie here" was
   * a number the column was already holding five rows of; "No one has fallen yet"
   * was a sentence under a gold bar announcing a section with nothing in it. A
   * player who has lost nobody is told so by a hill with no crosses on it, which
   * is the whole picture and does not need a caption.
   */
  const graves = document.createElement('ul')
  graves.style.cssText = LIST_STYLE

  const squadHeading = sectionHeading('SQUAD')
  const squad = document.createElement('ul')
  squad.style.cssText = LIST_STYLE
  /**
   * What the SQUAD column says when it has nobody to list.
   *
   * SINCE TICKET 056 THIS IS A RARE AND TERMINAL LINE, not the ordinary case it
   * used to be. The column is the LIVING ROSTER now, so an empty one means the
   * campaign has no men left at all — not, as it did before, that the two men
   * who deployed both died while six waited in reserve.
   */
  const squadEmpty = document.createElement('p')
  squadEmpty.textContent = 'No one left.'
  squadEmpty.style.cssText = `margin:0;font-size:0.8rem;color:${FRESH}`

  const promotionsHeading = sectionHeading('PROMOTIONS')
  const promotions = document.createElement('ul')
  promotions.style.cssText = LIST_STYLE

  roster.append(
    heroesHeading,
    graves,
    squadHeading,
    squad,
    squadEmpty,
    promotionsHeading,
    promotions,
  )

  /** The hillside, and every cross standing on it. */
  const hill = document.createElement('div')
  hill.style.cssText = [
    'position:relative',
    'flex:1',
    'min-width:0',
    `background-image:${HILL_IMAGE},${HILL_FALLBACK}`,
    // `auto` for the gradient, so the two bands stretch to the element rather
    // than being scaled to the picture's aspect and tiling under it.
    'background-size:cover,auto',
    'background-position:center bottom,center',
    'background-repeat:no-repeat,no-repeat',
    'overflow:hidden',
  ].join(';')

  const carryOn = document.createElement('button')
  carryOn.type = 'button'
  carryOn.textContent = options.continueLabel ?? 'Carry on'
  carryOn.style.cssText = [
    // Over the hill rather than under it: the hillside fills the panel, and a
    // button in the flow below would push the horizon up a row.
    'position:absolute',
    'left:50%',
    'bottom:1.25rem',
    'transform:translateX(-50%)',
    'padding:0.4rem 1.6rem',
    'border:1px solid rgba(242,239,230,0.65)',
    'background:rgba(4,9,7,0.72)',
    `color:${TEXT}`,
    `font-family:${DISPLAY_FONT}`,
    'font-size:clamp(1rem, 2.6vw, 1.5rem)',
    'letter-spacing:0.08em',
    'cursor:pointer',
  ].join(';')
  hill.append(carryOn)

  body.append(roster, hill)
  panel.append(scoreboard, body)
  // No `backdrop.append(panel)` here: `createChrome` has already done it. This
  // file used to build both itself and the line survived the conversion, which
  // re-appended the same node to the same parent — a no-op the DOM absorbs
  // silently, and exactly the sort of leftover a conversion leaves behind.
  mount.append(backdrop)
  // Focused, so the keyboard alone can leave the memorial — and so the player's
  // next click does not go to the map underneath by accident.
  carryOn.focus()

  let done = false
  const dispose = (): void => {
    // Guarded rather than merely idempotent-by-luck: `remove()` on a detached
    // node is harmless, but the flag is what lets a caller that disposes on both
    // "the player clicked" and "the screen changed" do so without thinking.
    if (done) return
    done = true
    backdrop.remove()
  }

  carryOn.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — it does not drop this listener, and a detached button can
    // still be clicked by anything still holding a reference to it. Without
    // this, a second click fires `onContinue` again; the screen leads to
    // Recruitment, so a double fire advances the flow twice and the player is
    // handed a screen he never asked for.
    if (done) return
    // THE SCREEN IS NOT TORN DOWN HERE (ticket 022b). The router in `main.ts`
    // mounts exactly one screen for `runner.screen()` and disposes it when that
    // changes, so a memorial that had already removed itself when the command
    // was REFUSED would leave the router agreeing that Boot Hill is still up and
    // nothing at all on the page.
    options.onContinue()
  })

  /**
   * The row elements, by position in their list. Kept and reused for the reason
   * given in the header: the hill only ever gains rows at the end.
   */
  const graveRows: HTMLElement[] = []
  const squadRows: HTMLElement[] = []
  const promotionRows: HTMLElement[] = []
  /** The crosses, one per grave, in the same order and reused the same way. */
  const crosses: HTMLElement[] = []

  function rowAt(cache: HTMLElement[], list: HTMLElement, index: number): HTMLElement {
    const existing = cache[index]
    if (existing !== undefined) return existing
    const row = document.createElement('li')
    row.style.cssText = ROW_STYLE
    cache[index] = row
    list.append(row)
    return row
  }

  /**
   * One cross on the hillside.
   *
   * `aria-hidden`, AND THAT IS NOT AN OVERSIGHT. Every man drawn here is also a
   * row in the HEROES column with his name, his rank and where he fell; a screen
   * reader announcing twelve unlabelled crosses as well would read the memorial
   * twice, the second time as noise. The picture is for the eye and the column
   * is the record.
   */
  function crossAt(index: number): HTMLElement {
    const existing = crosses[index]
    if (existing !== undefined) return existing
    const cross = document.createElement('span')
    cross.textContent = '✝'
    cross.setAttribute('aria-hidden', 'true')
    const { left, top } = plot(index)
    cross.style.cssText = [
      'position:absolute',
      `left:${left.toFixed(2)}%`,
      `top:${top.toFixed(2)}%`,
      'transform:translate(-50%, -100%)',
      'font-size:clamp(1rem, 2.4vw, 1.75rem)',
      'line-height:1',
      'text-shadow:0 2px 3px rgba(0,0,0,0.55)',
      'pointer-events:none',
    ].join(';')
    crosses[index] = cross
    hill.append(cross)
    return cross
  }

  /**
   * Hide the rows past `used` instead of removing them.
   *
   * A screen shown twice with different models must not leave the previous
   * one's tail on display — a promotion from last mission still listed under
   * this one's would be indistinguishable from a bug in `promotionsBetween`.
   */
  function trim(cache: readonly HTMLElement[], used: number): void {
    for (let i = used; i < cache.length; i += 1) {
      const row = cache[i]
      if (row !== undefined && row.style.display !== 'none') row.style.display = 'none'
    }
  }

  /** A name on the left, his tally on the right — the original's two columns. */
  function setRow(row: HTMLElement, left: string, right: string): void {
    let name = row.firstElementChild as HTMLElement | null
    let tally = row.lastElementChild as HTMLElement | null
    if (name === null || tally === null || name === tally) {
      row.replaceChildren()
      name = document.createElement('span')
      tally = document.createElement('span')
      tally.style.cssText = 'flex:none;opacity:0.85'
      row.append(name, tally)
    }
    setText(name, left)
    setText(tally, right)
  }

  function update(model: BootHillModel): void {
    setText(score, `${String(model.enemyKilled)} : ${String(model.casualties)}`)

    const count = model.graves.length
    /**
     * THE WHOLE HEROES SECTION GOES WHEN THE HILL IS EMPTY (ticket 060), heading
     * and all — the same bargain PROMOTIONS has always made below. A gold bar
     * over nothing reads as a panel that failed to load its own contents, and on
     * a first mission it is the first thing on the screen.
     *
     * Restored to the EXPLICIT `display` each element was built with rather than
     * to `''`: clearing the property drops the inline `display:flex` the list's
     * `cssText` set, and the column silently loses its gap. Same trap as the
     * promotions block.
     */
    const heroesShown = count === 0 ? 'none' : 'flex'
    if (graves.style.display !== heroesShown) graves.style.display = heroesShown
    const heroesHeadingShown = count === 0 ? 'none' : 'block'
    if (heroesHeading.style.display !== heroesHeadingShown) {
      heroesHeading.style.display = heroesHeadingShown
    }

    // `fallenThisMission` is a subset of `graves` by position at the END of the
    // list — the dead list is append-only — so the fresh stones are the last
    // `fallenThisMission.length` of them. Matching by name instead would light
    // up the wrong stone the day two men share one.
    const freshFrom = count - model.fallenThisMission.length

    for (let i = 0; i < count; i += 1) {
      const grave = model.graves[i]
      if (grave === undefined) continue
      const row = rowAt(graveRows, graves, i)
      if (row.style.display !== 'flex') row.style.display = 'flex'
      const fresh = i >= freshFrom
      setRow(row, grave.name.toUpperCase(), String(grave.kills))
      // HIS RANK AND WHERE HE FELL STILL REACH THE READER, off the face of the
      // bar. The mockup's plaque has room for a name and a number and nothing
      // else, but the rest of the record is not worth losing — it is the same
      // prose line this screen used to print, moved to where it costs no width.
      row.title = graveLine(grave)
      const state = fresh ? 'fresh' : 'old'
      if (row.dataset.state !== state) {
        row.dataset.state = state
        // WITH THE PRINTED MARKERS GONE (ticket 058) THIS IS COLOUR AND WEIGHT
        // ALONE, which is a real loss and a deliberate one: the bars carry no
        // room for a glyph in front of the name. The distinction is a nicety —
        // every man here is dead either way — and the border is a second,
        // non-chromatic channel for a player who cannot see the warm tint.
        row.style.color = fresh ? FRESH : MUTED
        row.style.fontWeight = fresh ? '600' : '400'
        row.style.borderColor = fresh ? 'rgba(255,143,107,0.7)' : 'rgba(242,193,78,0.22)'
      }

      const cross = crossAt(i)
      if (cross.style.display !== '') cross.style.display = ''
      // The hill carries the same distinction the column does: this mission's
      // dead are warm and bright, the older ones have weathered to bone.
      const crossState = fresh ? 'fresh' : 'old'
      if (cross.dataset.state !== crossState) {
        cross.dataset.state = crossState
        cross.style.color = fresh ? FRESH : '#e8e4d8'
      }
    }
    trim(graveRows, count)
    trim(crosses, count)

    const standing = model.squad.length
    for (let i = 0; i < standing; i += 1) {
      const man: Trooper | undefined = model.squad[i]
      if (man === undefined) continue
      const row = rowAt(squadRows, squad, i)
      if (row.style.display !== 'flex') row.style.display = 'flex'
      if (row.style.color !== TEXT) row.style.color = TEXT
      setRow(row, man.name.toUpperCase(), String(man.kills))
      row.title = `${man.rank} ${man.name}`
    }
    trim(squadRows, standing)
    // See `squadEmpty`: an empty roster is the end of the campaign's manpower,
    // not the ordinary aftermath of a bad mission.
    const emptied = standing === 0 ? 'block' : 'none'
    if (squadEmpty.style.display !== emptied) squadEmpty.style.display = emptied

    // Hidden outright when nobody was promoted, rather than left as a heading
    // over nothing: an empty section reads as a screen that failed to load its
    // own content.
    const promoted = model.promotions.length
    const shown = promoted === 0 ? 'none' : 'flex'
    // Restored to the EXPLICIT display each element was built with, never to
    // `''`: clearing the property drops the inline `display:flex` the list's
    // `cssText` set, and the column silently loses its gap.
    if (promotions.style.display !== shown) promotions.style.display = shown
    const headingShown = promoted === 0 ? 'none' : 'block'
    if (promotionsHeading.style.display !== headingShown) {
      promotionsHeading.style.display = headingShown
    }
    for (let i = 0; i < promoted; i += 1) {
      const promotion = model.promotions[i]
      if (promotion === undefined) continue
      const row = rowAt(promotionRows, promotions, i)
      if (row.style.display !== 'flex') row.style.display = 'flex'
      if (row.style.color !== PROMOTED) row.style.color = PROMOTED
      setRow(row, promotion.name, `${promotion.from} → ${promotion.to}`)
      row.title = promotionLine(promotion)
    }
    trim(promotionRows, promoted)
  }

  return { update, dispose }
}
