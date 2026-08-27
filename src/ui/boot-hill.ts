/**
 * BOOT HILL (ticket 022, redrawn to the original's own screen in 054).
 *
 * `assets/mockups/boot-hill.jpg` is the screen this is now built to: a black
 * scoreboard across the top reading HOME <kills> : <deaths> AWAY, a roster
 * column down the left with HEROES over SQUAD, and the hill itself filling the
 * rest — a field of white crosses, one per man who has died.
 *
 * THE HILL IS A SECOND VIEW OF THE SAME LIST, NEVER THE ONLY ONE. Every man on
 * it is also a row in the HEROES column with his rank, where he fell and what it
 * cost the other side; the crosses are the picture and the column is the record.
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
 * The hill, until there is a picture of one.
 *
 * A CSS SKY AND TWO MOUNDS, and it is a placeholder wearing its own label: the
 * mockup is a painted hillside and this repository has no such asset. When
 * `assets/source/boot-hill.png` lands, this constant becomes a `?url` import and
 * `background-image` on the same element — the crosses are positioned in
 * PERCENTAGES of it, so they land in the same places over the art as they do
 * over the gradient.
 */
const HILL_BACKDROP = [
  'linear-gradient(#1d4f86 0%, #3f7fbe 27%, transparent 27%)',
  'radial-gradient(120% 80% at 78% 100%, #37853c 0%, #37853c 62%, transparent 63%)',
  'radial-gradient(150% 95% at 28% 100%, #47a44b 0%, #47a44b 64%, transparent 65%)',
  // The base the mounds stand on. A DARK green rather than near-black: the two
  // radials do not meet the sky line at every viewport width, and whatever shows
  // between them has to read as more hillside instead of as a hole in it.
  'linear-gradient(#2c6f31, #2c6f31)',
].join(',')

/**
 * The two stone markers: this mission's dead, and every mission before it.
 *
 * PRINTED CHARACTERS, NOT STYLING. Distinguishing the men who just died from
 * four levels of older stones is this screen's whole job, and colour plus font
 * weight would leave a colour-blind player weighing one line against another on
 * boldness alone — on a list that is already all one typeface. A cross the
 * reader can see is the signal; the colour is the reinforcement.
 *
 * BOTH ROWS CARRY ONE, so every line starts at the same column. Marking only
 * the fresh stones would indent them relative to the rest and make the hill
 * ragged exactly where it is meant to be legible.
 */
const MARK_FRESH = '✚'
const MARK_OLD = '·'

const LIST_STYLE = 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0.2rem'

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
    // The sky is the top ~28% of the panel; nobody is buried in it.
    top: 34 + down * 56,
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
  /** The count, and the only line an empty hill shows. */
  const summary = document.createElement('p')
  summary.style.cssText = `margin:0 0 0.2rem;color:${MUTED};font-size:0.8rem`

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
    summary,
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
    `background:${HILL_BACKDROP}`,
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
    row.style.cssText = 'display:flex;justify-content:space-between;gap:0.5rem;font-size:0.8rem'
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
    setText(
      summary,
      count === 0
        ? 'No one has fallen yet.'
        : `${String(count)} ${count === 1 ? 'man' : 'men'} lie here.`,
    )

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
      // A PRINTED MARKER FIRST, colour second: "which of these are new" must
      // survive a colour-blind player and a washed-out screen, the same bargain
      // the HUD's roster pips make. The marker is text rather than a `data-`
      // attribute or a font weight, because only text is something a reader can
      // actually see — see `MARK_FRESH`.
      setRow(
        row,
        `${fresh ? MARK_FRESH : MARK_OLD} ${grave.rankAtDeath} ${grave.name}`,
        String(grave.kills),
      )
      // The whole line still reads as prose to anything that asks for it, which
      // is what the two-column layout costs and what this buys back.
      row.title = graveLine(grave)
      const state = fresh ? 'fresh' : 'old'
      if (row.dataset.state !== state) {
        row.dataset.state = state
        row.style.color = fresh ? FRESH : MUTED
        row.style.fontWeight = fresh ? '600' : '400'
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
      setRow(row, `${man.rank} ${man.name}`, String(man.kills))
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
