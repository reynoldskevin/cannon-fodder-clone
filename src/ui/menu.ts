/**
 * THE MENU (ticket 022b): the title, one button, and the only place a damaged
 * save is ever mentioned.
 *
 * SINCE TICKET 024 IT IS ALSO THE END OF THE CAMPAIGN. `BootHill -> Menu` on
 * `campaignComplete` is a row the chart has always had, so a finished campaign
 * has always landed here — it just arrived with nothing to say. Now it arrives
 * with the totals, and with the only button in the game that can throw a
 * campaign away. NO NEW SCREEN AND NO NEW ROW: a seventh screen for a state the
 * chart can already express would mean a row in `TRANSITIONS` that
 * `diagram.test.ts` checks against `ARCHITECTURE_DIAGRAM.md` in both directions.
 *
 * DECIDES NOTHING. Where Start leads is `core/flow`'s answer (`Menu ->
 * Recruitment`), whether there is anything to warn about is `loadCampaign`'s,
 * whether the campaign is over is `campaignComplete`'s, and the totals are
 * `campaignSummary`'s — this file draws values it is handed and calls back.
 * Vitest runs `environment: 'node'`, so nothing in `src/ui` is unit-tested at
 * all; anything decided here would be verified by looking at the screen and
 * nowhere else.
 *
 * THE NOTICE IS THE POINT OF THIS SCREEN AS MUCH AS THE BUTTON IS.
 * `runner.notice()` has existed since ticket 019 and has never been rendered: a
 * player whose save was damaged or could not be written is otherwise told by a
 * `console.warn` he will never open.
 */

import {
  createButton,
  createChrome,
  createNotice,
  setNotice,
  setText,
  BAD,
  LIST_STYLE,
  MUTED,
  TEXT,
} from './screen-chrome'
import {
  FALLEN_ROW_STYLE,
  FALLEN_NAME_STYLE,
  KILL_COUNT_STYLE,
  LOST_IN_SERVICE_TITLE,
  MEMORIAL_SCRIM,
  MEMORIAL_TITLE_STYLE,
  MISSION_HEADING_STYLE,
  POPPY_LEFT_STYLE,
  POPPY_RIGHT_STYLE,
  POPPY_URL,
  ROLL_Z_INDEX,
  missionHeading,
} from './lost-in-service'
import { INSIGNIA_STYLE, insigniaPosition } from './rank-insignia'
import { loadDisplayFont } from './display-font'
import { menuButtons } from './menu-buttons'
import { rollOfHonour } from '../core/campaign'
import type { CampaignSummary } from '../core/campaign'
import jungleUrl from '../../assets/source/jungle-background.png?url'
import logoUrl from '../../assets/source/logo.webp?url'
import sargeUrl from '../../assets/source/character-sarge.webp?url'
import shadesUrl from '../../assets/source/character-shades.webp?url'
import luckyUrl from '../../assets/source/character-lucky.webp?url'

/** Everything the Menu draws. All of it comes from `core`. */
export interface MenuModel {
  /**
   * The persistence notice, or `null` when the store is behaving.
   *
   * NOT OPTIONAL. `null` is a real answer the caller has to have looked up, and
   * an omittable field would let a caller that simply forgot to ask look
   * identical to a clean load.
   */
  readonly notice: string | null
  /** The campaign's totals. Always supplied — a campaign in progress has them too. */
  readonly summary: CampaignSummary
  /**
   * Has every published level been beaten?
   *
   * HANDED IN, NOT INFERRED FROM `summary`. "Levels completed equals the number
   * of levels" would be a second spelling of `campaignComplete`, in the one
   * layer that cannot be tested, and `>` versus `>=` there is exactly the
   * off-by-one ticket 020 measured.
   */
  readonly campaignOver: boolean
  /**
   * Is the player COMING BACK to a campaign, rather than beginning one?
   *
   * HANDED IN FOR THE SAME REASON `campaignOver` IS. "Levels completed or
   * casualties or kills" off `summary` picks out the same campaigns today, and
   * writing it here would still be a second spelling of `campaignUnderway` in
   * the one layer nothing can test — one that agrees with core until the day the
   * campaign records something the summary does not add up.
   */
  readonly campaignUnderway: boolean
}

export interface MenuOptions extends MenuModel {
  /** Begin the campaign. The chart decides where that goes. */
  readonly onStart: () => void
  /**
   * Throw the campaign away and start a new one.
   *
   * ONLY EVER CALLED ON THE SECOND PRESS. See `armRestart`.
   */
  readonly onRestart: () => void
}

export interface MenuScreen {
  /**
   * Redraw from a new model.
   *
   * NEEDED BECAUSE A RESTART DOES NOT CHANGE THE SCREEN. The router only
   * rebuilds a panel when `viewFor(runner.screen())` changes, and a wipe leaves
   * the player on the Menu — so without this the screen would go on showing the
   * totals and the graves of the campaign it has just erased.
   */
  update(model: MenuModel): void
  /**
   * Take the screen down and stop the buttons firing. Safe to call twice, and
   * safe to call while a click is still reachable — the removal and both
   * callbacks are behind one flag, so nothing runs a second time.
   */
  dispose(): void
}

/**
 * How long the restart button stays armed, in milliseconds.
 *
 * IT DISARMS ITSELF because the second press is a confirmation, and a
 * confirmation that waits indefinitely is not one: a button left armed while the
 * player went to make tea is a single click away from deleting his campaign, and
 * he will not remember that he half-pressed it.
 */
const RESTART_ARMED_MS = 6000

/**
 * What a button on this screen sits on.
 *
 * NEARLY OPAQUE AND NEARLY BLACK, not the shared `transparent`: the buttons are
 * over jungle now, and the shared style's bare border round bright leaves is a
 * shape you have to hunt for rather than a control.
 */
const BUTTON_FILL = 'rgba(4,9,7,0.72)'

/** The armed wipe's fill — the warm one, over the same dark. */
const RESTART_ARMED_FILL = 'rgba(255,143,107,0.28)'

/**
 * The title card's scrim: dark at the top and along the bottom, clear through
 * the middle.
 *
 * WITHOUT IT THE TEXT IS UNREADABLE. The jungle is bright, busy and mid-green,
 * and white type on it is only legible where the leaves happen to be dark. A
 * flat tint over the whole image would fix that by throwing away the art; a
 * gradient darkens the two bands the words are in and leaves the middle — where
 * the three figures stand — alone.
 *
 * A NAMED CONSTANT SINCE TICKET 073, because the campaign's end swaps it for
 * `MEMORIAL_SCRIM` and swaps it back. Written inline it would have had to be
 * spelled a second time in `render` to restore, and the copy that was never
 * updated is the one the player would have seen.
 */
const MENU_SCRIM =
  'linear-gradient(' +
  'rgba(2,6,4,0.82) 0%,' +
  'rgba(2,6,4,0.35) 30%,' +
  'rgba(2,6,4,0.25) 55%,' +
  'rgba(2,6,4,0.85) 100%)'

/**
 * How long one man takes to arrive, and the gap between them.
 *
 * THE STAGGER IS THE ANIMATION. Three figures bouncing up together is one event
 * the eye reads as a single card sliding in; one after another is a squad
 * arriving, which is what the screen is about. The gap is shorter than the
 * travel so the next man leaves the floor while the one before him is still
 * settling — they overlap rather than queue.
 */
const ENTRANCE_MS = 820
const ENTRANCE_STAGGER_MS = 260

/**
 * The bounce.
 *
 * A CUBIC-BEZIER AND NOT KEYFRAMES, because `src/ui` ships no stylesheet — every
 * screen in this layer is inline styles on elements it made, and `@keyframes`
 * cannot be written inline. The final control point overshoots (y > 1), so the
 * figure rises past its resting place and drops back onto it, which is the whole
 * bounce; a plain ease would slide.
 */
const ENTRANCE_EASE = 'cubic-bezier(0.22, 1.4, 0.32, 1)'

/**
 * Where the logo comes down to, measured from the top of the window.
 *
 * IT IS THE PANEL'S TOP PADDING TOO, so the logo is simply the first thing in
 * the column rather than a floating element positioned over it — the notice and
 * the campaign totals go on flowing underneath it as they always did, and there
 * is no second number to keep in step with this one when they do.
 */
const LOGO_TOP = '10vh'

/**
 * Off the top of the window: up by its own height AND by the drop it is going to
 * make, so its bottom edge starts exactly on the top edge of the screen.
 */
const LOGO_OFFSTAGE = `translateY(calc(-100% - ${LOGO_TOP}))`

/**
 * The heartbeat the logo settles into once it has landed.
 *
 * SLOW AND SMALL. It is on screen for as long as the player leaves the game
 * sitting on the menu, and anything faster or wider than this stops reading as
 * "the title is alive" and starts reading as a thing demanding to be clicked.
 *
 * WEB ANIMATIONS AND NOT A TRANSITION, because it repeats forever: a transition
 * has one end state and would need a `transitionend` handler flipping it back
 * and forth to loop, and `@keyframes` is not available to a layer that ships no
 * stylesheet. `Element.animate` is the DOM API for exactly this, and it hands
 * back a handle that `dispose` can cancel.
 */
const PULSE_MS = 2400
const PULSE_KEYFRAMES: Keyframe[] = [
  { transform: 'translateY(0) scale(1)' },
  { transform: 'translateY(0) scale(1.045)' },
  { transform: 'translateY(0) scale(1)' },
]

/**
 * One of the three on the title card.
 *
 * `resting` IS THE TRANSFORM THE FIGURE ENDS ON and `translate` is only its
 * horizontal half: the entrance animates the vertical part from "below the
 * bottom of the screen" to nothing, and anything else in the transform — the
 * lean, the horizontal offset — has to be identical at both ends or the man
 * would slide sideways and unrotate as he lands.
 */
interface CastEntry {
  readonly src: string
  readonly alt: string
  /**
   * Where the TOP of the image comes to rest, measured down from the top of the
   * viewport, in `vh`.
   *
   * THE TOP AND NOT THE FEET, and in `vh` rather than a percentage. At this size
   * the men are taller than the screen — the boots are below the bottom edge and
   * a `bottom` offset would be positioning something nobody can see. `vh` is
   * what makes `offstage` expressible at all: a `%` in a transform is a
   * percentage of the ELEMENT, so "start at the bottom of the WINDOW" cannot be
   * written as an arithmetic on a `%` placement.
   */
  readonly top: string
  /** Height, so the three can differ without hard-coding pixels. */
  readonly height: string
  /** Horizontal placement, applied as the first half of the transform. */
  readonly translate: string
  /** The lean, applied last so it cannot rotate the placement with it. */
  readonly rotate: string
  /** Painting order: Sarge in front, the other two behind him. */
  readonly depth: string
}

/**
 * SARGE FIRST AND CENTRALLY, the other two behind and to either side. The order
 * of this array is the order they arrive in, so it is the only place the
 * choreography is written down.
 *
 * THE HEIGHTS ARE THREE TIMES WHAT THEY WERE. They no longer describe a figure
 * standing on the screen — each man is now well over a screen tall, and what the
 * player sees is the top of him: head, shoulders and gun, with everything below
 * running off the bottom edge. Sarge rises highest, to 20% down the screen; the
 * other two stop a fifth of a screen lower, which is most of what makes them
 * read as standing behind him — Shades is nearly Sarge's size and still reads as
 * further back, because he stops lower and is further out.
 */
const CAST: readonly CastEntry[] = [
  {
    src: sargeUrl,
    alt: 'Sarge',
    top: '20vh',
    height: 'min(138vh, 162vw)',
    translate: 'translateX(-50%)',
    rotate: '',
    depth: '3',
  },
  {
    src: shadesUrl,
    alt: 'Shades',
    // Lower than Sarge and further out: three figures on one line at one size
    // read as a row of stickers, not as depth. Still half again Lucky's size,
    // and the 10vw of extra clearance is what keeps him out of the middle of
    // the card at it.
    top: '40vh',
    height: 'min(130vh, 151vw)',
    translate: 'translateX(calc(-50% - min(38vw, 34rem) - 10vw))',
    rotate: 'rotate(-30deg)',
    depth: '2',
  },
  {
    src: luckyUrl,
    alt: 'Lucky',
    top: '40vh',
    height: 'min(108vh, 126vw)',
    translate: 'translateX(calc(-50% + min(38vw, 34rem) + 10vw))',
    rotate: 'rotate(30deg)',
    depth: '2',
  },
]

/** Where a cast member sits, and where he comes in from. */
const resting = (member: CastEntry): string => `${member.translate} translateY(0) ${member.rotate}`

/**
 * Off the bottom of the screen entirely.
 *
 * THE DISTANCE FROM THE RESTING TOP TO THE BOTTOM OF THE WINDOW, so the figure
 * starts with his highest pixel exactly on the bottom edge — no part of him is
 * on screen, and he travels no further than he has to. `100vh` and not the
 * element's own `100%`: he is taller than the viewport now, and starting him a
 * full body length down would mean most of the entrance is spent crossing space
 * nobody can see, arriving late and at speed.
 */
const offstage = (member: CastEntry): string =>
  `${member.translate} translateY(calc(100vh - ${member.top})) ${member.rotate}`

export function createMenu(mount: HTMLElement, options: MenuOptions): MenuScreen {
  const { backdrop, panel } = createChrome('Main menu')

  // The memorial's title and every name on it are set in the display face, and
  // this screen can be the first one the page ever shows. Fire and forget — see
  // `display-font.ts`: the text paints in the fallback and reflows.
  loadDisplayFont()

  /**
   * THE JUNGLE, FULL BLEED (ticket 045). The shared chrome is flat black, which
   * is right for the mission card and for Boot Hill — this is the screen the
   * game is met on, and it is the one that gets art. Set on the instance rather
   * than in `screen-chrome.ts`: the other two screens are unchanged, and the
   * shared constant is pinned opaque-black by `screen-chrome.test.ts`.
   *
   * `cover` AND CENTRED, so a window of any shape is filled and the crop is
   * taken off the edges rather than letterboxed; the black stays underneath as
   * the colour of anything the image has not painted, including the first frame
   * before it has loaded.
   */
  backdrop.style.backgroundImage = `url(${jungleUrl})`
  backdrop.style.backgroundSize = 'cover'
  backdrop.style.backgroundPosition = 'center'
  // The column is the whole screen now — see `panel` below — so the chrome's own
  // indent would be a second, smaller viewport inside it.
  backdrop.style.padding = '0'

  /**
   * THE GAME'S NAME, NOT THE REPOSITORY'S (ticket 040). The start screen is the
   * first thing anybody sees and it read `Game Week` — the name of the build
   * exercise, which means nothing to a player.
   */
  /**
   * THE PAINTED LOGO, NOT SET TYPE (ticket 045). The title was the shared
   * `createHeading` — system-ui, letterspaced, uppercased — which is the right
   * answer for "Campaign complete" on a black card and the wrong one for the
   * first thing anybody sees.
   *
   * STILL AN `h1` WITH THE WORDS IN IT. The name of the game is the page's
   * heading whether it is drawn in letters or in pixels, and `alt` is what keeps
   * it readable to a screen reader and to anyone whose image never loads. A bare
   * `<img>` would have quietly deleted the only heading on the screen.
   */
  const heading = document.createElement('h1')
  // `line-height:0` so the h1 is exactly as tall as the picture in it: an inline
  // image otherwise sits on a text baseline and leaves a strip of descender
  // space under it, which reads as the logo hanging slightly too high.
  heading.style.cssText = 'margin:0;line-height:0'

  const logo = document.createElement('img')
  logo.src = logoUrl
  logo.alt = 'Cannon Fodder'
  logo.draggable = false
  logo.style.cssText = [
    'display:block',
    // Wide enough to be the title, capped so it does not outgrow the column on a
    // large screen or crowd the men on a small one.
    'width:min(34rem, 62vw)',
    'height:auto',
    'filter:drop-shadow(0 6px 16px rgba(0,0,0,0.8))',
    `transform:${LOGO_OFFSTAGE}`,
  ].join(';')
  heading.append(logo)

  /**
   * THE LINE UNDER THE TITLE IS GONE (ticket 076).
   *
   * It read "The island is taken. Start over, and none of them come back." and
   * sat between LOST IN SERVICE and the roll of the dead, saying three things
   * the screen already says: the title says they were lost, the list says who,
   * and the button says "Start over (erases n graves)".
   *
   * THE ELEMENT WENT WITH THE SENTENCE. A `createNotice` left in place and never
   * filled is a `display:none` paragraph nobody can see, a name in the append
   * list, and a thing the next reader has to check for a caller before deciding
   * it is dead — see the header this replaced, which was three paragraphs
   * arguing for an element that now has nothing to hold.
   */

  // Warm rather than muted: a save that could not be written is the one line on
  // this screen the player must not skim past.
  const notice = createNotice(BAD)

  /**
   * The campaign's totals, shown only when it is over.
   *
   * Its own container so "show the summary" is one `display` change rather than
   * a rebuild — and so a redraw after a restart cannot leave half of the last
   * campaign's numbers on screen beside half of the new one's.
   */
  const summary = document.createElement('section')
  // Bounded, because the roll shares the screen with a title and two buttons and
  // a long campaign's dead would otherwise push the buttons off the bottom.
  summary.style.cssText = [
    'display:none',
    'flex-direction:column',
    'align-items:center',
    'gap:0.5rem',
    /**
     * IT TAKES THE ROOM BETWEEN THE TITLE AND THE BUTTONS, rather than a share of
     * the viewport. A fixed `max-height` was measured against a screen and left
     * the roll clipping a row mid-name with a hand's width of empty black under
     * it — the list looked broken rather than scrollable. `min-height:0` is what
     * makes the cap real: a flex child's floor is its CONTENT by default, so
     * without it a long roll grows the column and pushes the buttons off the
     * bottom edge instead of scrolling.
     */
    'flex:1 1 auto',
    'min-height:0',
    'width:100%',
    // ABOVE THE POPPIES. They are scenery either side of this list and it is the
    // part that scrolls; see `lost-in-service.ts`.
    `z-index:${String(ROLL_Z_INDEX)}`,
  ].join(';')

  const summaryHeading = document.createElement('h2')
  summaryHeading.textContent = LOST_IN_SERVICE_TITLE
  summaryHeading.style.cssText = MEMORIAL_TITLE_STYLE

  const totals = document.createElement('p')
  totals.style.cssText = `margin:0;color:${MUTED};font-size:0.9rem;letter-spacing:0.06em`

  /**
   * The roll itself: mission headings and the men under them.
   *
   * A `div` OF `ul`s RATHER THAN ONE FLAT LIST, because the list is now grouped
   * and a heading is not a list item. `rollOfHonour` decides the grouping and
   * the order; this only draws it.
   *
   * IT IS THE ONLY THING THAT SCROLLS. The title stays put and the buttons stay
   * on the bottom edge — a memorial that pushed its own controls off screen
   * after twelve dead would be a screen the player could not leave.
   */
  const roll = document.createElement('div')
  roll.style.cssText = [
    'overflow-y:auto',
    // See `summary` above: the pair is what turns "too many dead" into a scroll
    // rather than into buttons below the fold.
    'flex:1 1 auto',
    'min-height:0',
    'width:min(28rem, 86%)',
    'padding:0 0.25rem',
    'text-align:left',
  ].join(';')

  /**
   * THE BLURB MOVES INSIDE THE MEMORIAL (ticket 073). It is only ever shown when
   * the campaign is over, and in the masthead it rendered ABOVE the title — a
   * loose sentence floating over the plaque with nothing to attach it to. Under
   * the title it is the line the title introduces.
   */
  summary.append(summaryHeading, totals, roll)

  const start = createButton('Start campaign')

  /**
   * The wipe, behind two presses.
   *
   * TWO PRESSES AND NOT ONE, because this is the only control in the game that
   * destroys anything: `startCampaign` is a replay that keeps every gravestone,
   * and `restartCampaign` deletes Boot Hill — the one screen the campaign exists
   * to fill. A player who meant "play again" must not reach "erase twelve
   * gravestones" by pressing the same button, and the second press is what makes
   * the difference deliberate. It is DOM, so nothing tests it; what IS tested,
   * in `core/flow`, is that no other command the runner has ever clears the save.
   *
   * AND IT IS NOT ON THE SCREEN AT ALL UNTIL THERE IS SOMETHING TO WIPE (ticket
   * 050). On a first run it offered to erase a campaign that does not exist yet:
   * a destructive-looking button beside Start, on the one screen where the
   * player has no idea what either of them does, and the answer to "what happens
   * if I press this" was "nothing at all". Shown from the moment the campaign
   * has a history — the same `campaignUnderway` that makes Start say "Continue".
   */
  const restart = createButton('')
  restart.style.borderColor = 'rgba(255,143,107,0.55)'
  restart.style.color = BAD

  // The shared button aligns itself to the left of a column; these two sit side
  // by side in a centred row, so each one gives that up and takes a fill of its
  // own — a transparent button on jungle is a rectangle of leaves with words on.
  for (const button of [start, restart]) {
    button.style.alignSelf = 'auto'
    button.style.margin = '0'
    button.style.background = BUTTON_FILL
    button.style.backdropFilter = 'blur(2px)'
  }

  /**
   * THE WHOLE SCREEN, not a column indented into one corner.
   *
   * The shared `PANEL_STYLE` is a reading column: `width:min(46rem, 100%)`, left
   * aligned, vertically centred. This screen is a title card — art behind, text
   * above it, controls along the bottom — so it takes the full rectangle and
   * hands the reading width back to the text alone (`masthead`). Overridden on
   * the instance rather than in `screen-chrome.ts`, for the same reason as the
   * background: the Briefing and Boot Hill are unchanged.
   *
   * `pointer-events:none` COMES BACK OFF THE COLUMN. The shared value turns it
   * on so buttons work; a column that is now the size of the viewport would
   * swallow every click the backdrop was careful to let through, so the two
   * pieces that actually take input turn it on for themselves.
   */
  panel.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:space-between',
    'gap:1rem',
    // The top padding IS the logo's resting place — see `LOGO_TOP`.
    `padding:${LOGO_TOP} clamp(1rem, 5vw, 4rem) clamp(1.5rem, 5vh, 3rem)`,
    'box-sizing:border-box',
    'overflow:hidden',
    'pointer-events:none',
  ].join(';')

  /**
   * Dark at the top and along the bottom, clear through the middle.
   *
   * WITHOUT IT THE TEXT IS UNREADABLE. The jungle is bright, busy and mid-green,
   * and white type on it is only legible where the leaves happen to be dark. A
   * flat tint over the whole image would fix that by throwing away the art; a
   * gradient darkens the two bands the words are in and leaves the middle — where
   * the three figures stand — alone.
   */
  const scrim = document.createElement('div')
  scrim.style.cssText = ['position:absolute', 'inset:0', 'z-index:0', 'pointer-events:none'].join(
    ';',
  )
  scrim.style.background = MENU_SCRIM

  /**
   * Where the squad stands.
   *
   * ITS OWN LAYER, ABSOLUTE, so the three figures are placed against the screen
   * rather than flowed between the title and the buttons: their positions are
   * percentages of the viewport ("40% up"), and a flex child's height is
   * whatever the text above it left over. `overflow:hidden` on the panel is what
   * keeps the entrance off-screen rather than growing the page.
   */
  const cast = document.createElement('div')
  cast.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none'

  /**
   * The two flowers, and they exist only for the campaign's end (ticket 073).
   *
   * BUILT ONCE AND HIDDEN, not created on the transition: this screen redraws
   * from `render` and a restart lands the player back on the same instance, so
   * anything built inside a branch would have to be torn down inside another
   * one. `display` is the whole difference between the title card and the
   * memorial.
   *
   * `alt=''` AND `aria-hidden`. They are decoration flanking a list of the dead;
   * a screen reader announcing "poppy, poppy" between the title and the names
   * says nothing the names do not.
   */
  const poppies = (['left', 'right'] as const).map((side) => {
    const flower = document.createElement('img')
    flower.src = POPPY_URL
    flower.alt = ''
    flower.setAttribute('aria-hidden', 'true')
    flower.draggable = false
    flower.style.cssText = side === 'left' ? POPPY_LEFT_STYLE : POPPY_RIGHT_STYLE
    flower.style.display = 'none'
    return flower
  })

  /** The title, the notice and the totals — the readable column. */
  const masthead = document.createElement('div')
  masthead.style.cssText = [
    'position:relative',
    'z-index:2',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:0.75rem',
    'width:min(46rem, 100%)',
    // Grows into the gap between the title and the buttons so the roll inside it
    // has somewhere to be; `min-height:0` for the same reason it is on the roll.
    'flex:1 1 auto',
    'min-height:0',
    'text-align:center',
    'text-shadow:0 2px 6px rgba(0,0,0,0.85)',
    // Only this and the button row take clicks; see the panel above.
    'pointer-events:auto',
  ].join(';')
  masthead.append(heading, notice, summary)

  /** Both buttons, side by side, centred along the bottom. */
  const controls = document.createElement('div')
  controls.style.cssText = [
    'position:relative',
    'z-index:2',
    'display:flex',
    'flex-wrap:wrap',
    'justify-content:center',
    'align-items:center',
    'gap:1rem',
    'pointer-events:auto',
  ].join(';')
  controls.append(start, restart)

  /**
   * The three of them, built from `CAST` and started off-screen.
   *
   * DRAGGING IS OFF and they take no clicks: they are scenery over a button
   * layer, and a figure that could be picked up and dropped on the Start button
   * is a way to lose a click, not a feature.
   */
  const figures = CAST.map((member) => {
    const figure = document.createElement('img')
    figure.src = member.src
    figure.alt = member.alt
    figure.draggable = false
    figure.style.cssText = [
      'position:absolute',
      'left:50%',
      `top:${member.top}`,
      `height:${member.height}`,
      'width:auto',
      `z-index:${member.depth}`,
      // The lean pivots on the top edge — the part of the man that is actually
      // on screen. On his feet it would swing his head out of frame, since the
      // feet are now a screen and a half below the bottom of the window.
      'transform-origin:top center',
      'user-select:none',
      'pointer-events:none',
      'filter:drop-shadow(0 12px 18px rgba(0,0,0,0.55))',
      `transform:${offstage(member)}`,
    ].join(';')
    return figure
  })
  cast.append(...figures)

  // The flowers go in BEFORE the masthead so they are behind it in DOM order as
  // well as by `z-index` — the roll scrolls over them, never under.
  panel.append(scrim, cast, ...poppies, masthead, controls)
  mount.append(backdrop)
  // Focused, so the keyboard alone can start the game — and so the player's next
  // click does not go to the canvas underneath by accident. Start, never
  // restart: a focused destructive button is one stray Enter from a wipe.
  start.focus()

  let done = false
  /** Whether the next press of `restart` actually restarts. */
  let armed = false
  let armedTimer: ReturnType<typeof setTimeout> | undefined
  let model: MenuModel = options

  /**
   * Every pending piece of the entrance, so `dispose` can drop the lot.
   *
   * A SCREEN CAN BE TAKEN DOWN MID-ENTRANCE: the Start button is focused and
   * clickable from the first frame, and a player who presses Enter immediately
   * leaves three timers pointing at elements that are no longer on the page.
   * They would do no visible harm — the nodes are detached — but a timer nobody
   * cancelled is exactly what the armed-restart one is careful not to be.
   */
  const entranceTimers: ReturnType<typeof setTimeout>[] = []

  /** The logo's heartbeat, once it is running. Cancelled on `dispose`. */
  let pulse: Animation | undefined

  /**
   * Start the heartbeat, but not for a player who has asked for stillness.
   *
   * `prefers-reduced-motion` IS CHECKED FOR THIS ONE AND NOT FOR THE ENTRANCE,
   * and the difference is that the entrance ENDS. A drop that is over in under a
   * second is motion the setting is not really about; a scale that never stops
   * is, and it is on screen for as long as the player leaves the game sitting on
   * the menu.
   */
  const startPulse = (): void => {
    if (done) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    pulse = logo.animate(PULSE_KEYFRAMES, {
      duration: PULSE_MS,
      iterations: Infinity,
      easing: 'ease-in-out',
    })
  }

  /**
   * Bring the squad on, one after another.
   *
   * TWO FRAMES AND NOT ONE. The figures are appended holding `offstage`, and a
   * transform set in the same frame the element was inserted is coalesced with
   * it — the browser has no previous value to animate from, so the men would
   * simply appear where they belong. The inner `requestAnimationFrame` is what
   * gives the start position a frame to be real in. `setTimeout` inside that
   * would do it too, but a rAF is the frame boundary rather than an approach to
   * it.
   */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (done) return
      // The logo drops first and from the opposite direction: it comes down out
      // of the top while the squad comes up out of the bottom, and the two
      // meeting is the screen assembling itself rather than a queue of things
      // sliding in from the same edge.
      logo.style.transition = `transform ${String(ENTRANCE_MS)}ms ${ENTRANCE_EASE}`
      logo.style.transform = 'translateY(0)'
      // The pulse takes over WHEN THE DROP IS DONE, not alongside it: both
      // animate `transform`, and a Web Animation runs above the inline style, so
      // starting it early would snap the logo to its resting place and throw the
      // rest of the bounce away.
      entranceTimers.push(setTimeout(startPulse, ENTRANCE_MS))
      figures.forEach((figure, index) => {
        const member = CAST[index]
        if (member === undefined) return
        const march = (): void => {
          figure.style.transition = `transform ${String(ENTRANCE_MS)}ms ${ENTRANCE_EASE}`
          figure.style.transform = resting(member)
        }
        // Sarge is index 0 and does not wait: the first man is the screen
        // arriving, and a title card that pauses before anything happens reads
        // as one that has not loaded.
        if (index === 0) {
          march()
          return
        }
        entranceTimers.push(setTimeout(march, index * ENTRANCE_STAGGER_MS))
      })
    })
  })

  /**
   * Does the reset need a second press on the screen currently shown?
   *
   * HELD RATHER THAN RECOMPUTED IN THE HANDLER, so the click reads the same
   * answer `render` drew the button from — see `menuButtons`.
   */
  let resetConfirms = true

  const restartLabel = (): string => {
    const graves = model.summary.casualties
    if (!armed) {
      const spec = menuButtons({
        campaignOver: model.campaignOver,
        campaignUnderway: model.campaignUnderway,
        graves,
      }).find((candidate) => candidate.action === 'reset')
      return spec?.label ?? 'Start over'
    }
    return graves === 0
      ? 'Press again to erase this campaign'
      : `Press again to erase ${String(graves)} graves`
  }

  const disarm = (): void => {
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = undefined
    armed = false
    setText(restart, restartLabel())
    restart.style.background = BUTTON_FILL
  }

  const armRestart = (): void => {
    armed = true
    setText(restart, restartLabel())
    // Visibly different as well as differently worded: the label change alone is
    // easy to press through, and this button is not one to press through.
    restart.style.background = RESTART_ARMED_FILL
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = setTimeout(disarm, RESTART_ARMED_MS)
  }

  const render = (next: MenuModel): void => {
    model = next
    setNotice(notice, next.notice)
    /**
     * ONE COMMAND, THREE THINGS TO CALL IT.
     *
     * The button always issues `onStart` and always has; what changes is what
     * that honestly IS to the player in front of it. Over a finished campaign
     * "Start campaign" reads like a wipe, which is the very thing it is not.
     * Over a campaign in progress it reads like the beginning of one, when the
     * men, the graves and the unlocked level are all still there — a returning
     * player is CONTINUING, and the button should say so.
     *
     * FINISHED IS CHECKED FIRST, because a finished campaign is also an underway
     * one and "Continue" is the wrong word for a campaign with nothing left to
     * do.
     */
    /**
     * WHAT IS OFFERED IS `menu-buttons.ts`'S ANSWER (ticket 077), not a chain of
     * conditionals here.
     *
     * The chain that stood here offered "Play again (keeps Boot Hill)" on a
     * finished campaign — `startCampaign`, which walks Menu -> Controls ->
     * BootHill and straight back to the Menu, because `advanceFromBootHill`
     * fires `campaignComplete` on a campaign with no level left. Three clicks to
     * the screen it was pressed on. The rule now lives where it can be tested,
     * and this only draws it.
     *
     * `display` AND NOT `disabled` OR A DIM: a greyed-out wipe still tells a
     * first-time player this screen can destroy something of his, which is a
     * question he does not have yet. `display:none` takes it out of the tab
     * order with it, so Enter cannot reach a button nobody can see.
     */
    const offered = menuButtons({
      campaignOver: next.campaignOver,
      campaignUnderway: next.campaignUnderway,
      graves: next.summary.casualties,
    })
    for (const [button, action] of [
      [start, 'start'],
      [restart, 'reset'],
    ] as const) {
      const spec = offered.find((candidate) => candidate.action === action)
      button.style.display = spec === undefined ? 'none' : ''
      if (spec !== undefined) setText(button, spec.label)
    }
    /**
     * THE RESET IS THE PRIMARY ACTION ON THE MEMORIAL, so it stops wearing the
     * warning colour there. It is the only button on the screen and the only
     * thing to do; `BAD` is for the wipe sitting beside a Continue the player
     * actually wants.
     */
    restart.style.borderColor = next.campaignOver ? 'rgba(159,179,189,0.55)' : 'rgba(255,143,107,0.55)'
    restart.style.color = next.campaignOver ? TEXT : BAD
    resetConfirms = offered.find((candidate) => candidate.action === 'reset')?.confirms ?? true

    summary.style.display = next.campaignOver ? 'flex' : 'none'

    /**
     * THE TITLE CARD BECOMES A MEMORIAL, and back again (ticket 073).
     *
     * The jungle and the three marching men are right for the screen the game is
     * met on and wrong for a list of the dead — the mockup has neither, and a
     * cartoon squad grinning beside twelve gravestones is the tonal problem this
     * ticket was raised about. HIDDEN RATHER THAN REMOVED, because this is still
     * the Menu: pressing Start plays again and must hand back the screen the
     * player started on, without rebuilding anything.
     *
     * THE LOGO GOES WITH THEM. It is the game's name in painted letters and it
     * would sit directly above LOST IN SERVICE, which would leave the screen
     * with two titles and no subject.
     */
    scrim.style.background = next.campaignOver ? MEMORIAL_SCRIM : MENU_SCRIM
    cast.style.display = next.campaignOver ? 'none' : ''
    heading.style.display = next.campaignOver ? 'none' : ''
    for (const flower of poppies) flower.style.display = next.campaignOver ? 'block' : 'none'

    if (next.campaignOver) {
      setText(
        totals,
        `${String(next.summary.levelsCompleted)} levels taken · ` +
          `${String(next.summary.casualties)} killed · ${String(next.summary.kills)} enemy dead`,
      )
      // Rebuilt rather than diffed: the roll changes only when the campaign
      // does, which is once a campaign, and a list this short is not worth a
      // reconciler nothing tests.
      roll.replaceChildren()
      /**
       * GROUPED BY `core`, DRAWN HERE. The reverse order, the one-group-per-level
       * fold and the order within a mission are all `rollOfHonour`'s, where
       * `roll-of-honour.test.ts` can hold them; this loop is a heading and some
       * rows.
       */
      for (const mission of rollOfHonour(next.summary.fallen)) {
        const heading = document.createElement('p')
        heading.textContent = missionHeading(mission.level)
        heading.style.cssText = MISSION_HEADING_STYLE
        roll.append(heading)

        const men = document.createElement('ul')
        men.style.cssText = LIST_STYLE
        for (const man of mission.dead) {
          const row = document.createElement('li')
          row.style.cssText = FALLEN_ROW_STYLE

          /**
           * THE BADGE, NOT THE WORD (ticket 088). Every other screen that shows
           * a rank draws it from `rank-insignia.ts`; this roll was the one that
           * spelled it out. `Grave` already carries `rankIndex`, so nothing is
           * computed here that was not already known.
           */
          const insignia = document.createElement('span')
          /**
           * NO BADGE IS A REAL ANSWER, not a missing one. `Grave.rankIndex` is
           * `null` for a stone carved under a ladder the game no longer has, and
           * `insigniaPosition` CLAMPS — handed `null` it would decorate that man
           * as a private rather than admit it does not know. Boot Hill draws
           * nothing in the same case; so does this.
           */
          insignia.style.cssText =
            man.rankIndex === null
              ? 'display:none'
              : `${INSIGNIA_STYLE};background-position:${insigniaPosition(man.rankIndex)}`
          /**
           * DECORATIVE, AND THE ROW IS WHAT MAKES THAT TRUE. An empty span with
           * a background says nothing to a screen reader, so hiding it is only
           * honest because the `title` below still carries "Private Jools" —
           * otherwise this ticket would DELETE the rank rather than move it.
           */
          insignia.setAttribute('aria-hidden', 'true')

          const who = document.createElement('span')
          who.textContent = man.name
          who.style.cssText = FALLEN_NAME_STYLE
          // The rank the badge is drawing, for anyone not looking at pictures.
          row.title = `${man.rankAtDeath} ${man.name}`
          const kills = document.createElement('span')
          // "1 killed", not "1 kills". The count is the man's whole record and
          // the plural is the difference between a memorial and a scoreboard.
          kills.textContent = `${String(man.kills)} killed`
          kills.style.cssText = KILL_COUNT_STYLE

          row.append(insignia, who, kills)
          men.append(row)
        }
        roll.append(men)
      }
    }
    // A model change can only make an armed button MORE dangerous than the
    // player agreed to, so the arming does not survive one.
    disarm()
  }

  render(options)

  const dispose = (): void => {
    // Guarded rather than merely idempotent-by-luck: `remove()` on a detached
    // node is harmless, but the flag is what lets a caller that disposes on both
    // "the player clicked" and "the screen changed" do so without thinking.
    if (done) return
    done = true
    // Before the removal: a timer left running on a detached screen would fire
    // into elements nothing can see, and on a page that may already be gone.
    if (armedTimer !== undefined) clearTimeout(armedTimer)
    armedTimer = undefined
    // Same reason, for the men still walking on. See `entranceTimers`.
    for (const timer of entranceTimers) clearTimeout(timer)
    entranceTimers.length = 0
    // The heartbeat would otherwise go on ticking against a detached element for
    // as long as anything holds a reference to it.
    pulse?.cancel()
    pulse = undefined
    backdrop.remove()
  }

  start.addEventListener('click', () => {
    // GUARDED BY THE SAME FLAG AS THE REMOVAL, because `dispose` only detaches
    // the backdrop — it does not drop this listener, and a detached button can
    // still be clicked by anything still holding a reference to it. See
    // `boot-hill.ts`, which pays for the same lesson.
    if (done) return
    // A stray press on Start must not leave the wipe armed behind it.
    disarm()
    // The callback goes first and the screen is NOT torn down here: the router
    // reconciles from `runner.screen()` after the command, and a screen that
    // removed itself before the command was accepted would leave a refused
    // Start with no menu and nothing to press.
    options.onStart()
  })

  restart.addEventListener('click', () => {
    if (done) return
    // ON THE MEMORIAL THIS IS THE ONLY BUTTON AND IT IS THE POINT OF THE SCREEN,
    // so it fires on the first press. See `MenuButton.confirms`: the second
    // press exists to save a LIVE campaign from a misclick, and there is no live
    // campaign here to save.
    if (resetConfirms && !armed) {
      armRestart()
      return
    }
    disarm()
    options.onRestart()
  })

  return { update: render, dispose }
}
