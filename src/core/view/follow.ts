/**
 * WHO THE CAMERA WATCHES, AND WHETHER THE PLAYER MAY MOVE IT (ticket 075).
 *
 * The camera used to be driven entirely by the player — `PanController` on the
 * keys and the screen edge, `ZoomController` on the wheel — and nothing followed
 * the squad at all. Order your men across the level and the view stayed where it
 * was, so the game was played by scrolling after them. The default is now the
 * opposite: fixed zoom, no pan, and the view centred on the living squad.
 *
 * BOTH DECISIONS ARE HERE BECAUSE `main.ts` CANNOT BE TESTED. It builds a WebGL
 * context on its first statement and Vitest runs `environment: 'node'`, so a
 * centroid written inline in the render loop is a rule verified by looking at
 * the screen. `parseElevation` in `orientation.ts` made the same trade for the
 * same reason, and its shape is copied exactly: the parser takes the RAW STRING
 * rather than reading `location`, so `core` stays free of the DOM and every
 * spelling of the flag is a unit test.
 */

import type { GroundPoint } from './camera'

/**
 * The little a follow needs to know about a unit.
 *
 * STRUCTURAL, NOT `Entity`. `core/view` has never imported the world and should
 * not start: the renderer, the tests and the app can all hand over anything with
 * these three fields, and the camera gains no opinion about health, ammo or
 * whatever the roster records next.
 */
export interface FollowUnit {
  readonly team: string
  readonly x: number
  readonly z: number
}

/**
 * Where to look: the middle of the living squad.
 *
 * THE FALLBACK IS NOT OPTIONAL AND IT IS NOT THE ORIGIN. An average over an
 * empty list is `0/0`, and the obvious guard — return `{ x: 0, z: 0 }` — is
 * worse than the NaN, because world coordinates start at the CORNER of the map.
 * The frame the last man died the camera would leave the fight entirely and show
 * a corner of empty jungle, held there for the three seconds ticket 058's
 * mission-end banner runs. Passing the current look-at point in means "nobody
 * left, so stay where you are", which is the only honest answer.
 *
 * A FRESH POINT EVERY TIME, including in the fallback case. The caller's
 * fallback is the rig's live target, and handing it straight back would let
 * anything that adjusted the result write into the camera's own memory of where
 * it is looking.
 *
 * FILTERED BY TEAM, WHICH IS THE EASY LINE TO LEAVE OUT. A level carries sixteen
 * enemies to four of your men, so an unfiltered centroid sits nearer the enemy
 * spawn than the squad and drifts further the more of them are alive — which
 * reads as a tuning problem rather than as a missing `filter`.
 */
export function squadFocus(
  units: readonly FollowUnit[],
  fallback: GroundPoint,
): GroundPoint {
  let sumX = 0
  let sumZ = 0
  let count = 0
  for (const unit of units) {
    if (unit.team !== 'player') continue
    sumX += unit.x
    sumZ += unit.z
    count += 1
  }
  if (count === 0) return { x: fallback.x, z: fallback.z }
  return { x: sumX / count, z: sumZ / count }
}

/**
 * May the player pan and zoom? Only with `?scroll=1`.
 *
 * ONE SPELLING, AND `true` IS REFUSED DELIBERATELY. `?scroll=true` is what
 * somebody reaches for first, and a parser written as "present and not `0`"
 * would honour it — but the same rule would also honour `?scroll=0`, which
 * plainly asks for the opposite. Matching `?debug=1` exactly is what makes the
 * convention learnable: this codebase has one way of spelling a flag.
 *
 * NOTHING IS TRIMMED. `' 1'` is not `1`; it is a typo, and quietly accepting it
 * would make the accepted set impossible to state.
 */
export function parseScrollUnlocked(raw: string | null | undefined): boolean {
  return raw === '1'
}

/**
 * The line the control hint shows, or `null` for no hint at all.
 *
 * THE LOCKED CAMERA IS SHOWN NOTHING (ticket 080). It used to carry "1-3 or
 * shift+wheel to change weapon", and three things now say that — two of them
 * better. The ordnance rail draws rifle, grenade and rocket as real `<button>`s
 * wired to `onSelectOrdnance`, so the weapons are visible and clickable without
 * being told; and the CONTROLS card in front of every campaign says "Click an
 * icon for rifle, grenade or rocket" on a screen the player cannot skip. With
 * pan and zoom already gone (ticket 075) that line was the whole pill, so the
 * honest result is no pill.
 *
 * `null` AND NOT `''`. An empty string still builds a styled, padded, rounded
 * capsule and floats it over the map for seven seconds with nothing in it.
 *
 * THE BINDINGS ARE UNTOUCHED. `onSelectKey` still takes `1`-`3` and
 * `onSelectWheel` still takes shift+wheel; what is removed is the
 * advertisement, not the shortcut.
 *
 * `?scroll=1` KEEPS ITS LINE. Pan, zoom and the fit key are taught nowhere else
 * — no card mentions them and no icon implies them — so the one place they are
 * written down has to stay. That is the same argument ticket 075 made for
 * making this conditional at all.
 */
export function controlHintText(scrollUnlocked: boolean): string | null {
  if (!scrollUnlocked) return null
  return 'WASD / arrows or screen edge to pan  ·  wheel or +/− to zoom  ·  F to zoom out fully'
}
