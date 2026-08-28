/**
 * WHICH SCREENS COVER THE GAME (ticket 022b).
 *
 * THE ROUTER'S ONLY DECISION, PULLED OUT OF THE ROUTER. `main.ts` mounts one
 * panel at a time and disposes the last one; `src/ui` has no tests and cannot
 * have any, so this mapping written as a chain of `if`s inside that function
 * would be a mapping nothing checks. The failure it prevents is a screen with no
 * panel — a black page over a running mission, with no button to press and a
 * reload as the only way out.
 *
 * IT IS A TABLE AND NOT A NAME BECAUSE IT IS NOT 1:1 WITH `Screen`. `Mission`
 * maps to `null`: the canvas is always mounted, and being "on" the Mission
 * screen is the ABSENCE of an overlay over it rather than the presence of one.
 * Every other screen covers the game. Spell the rule as
 * `view = screen.toLowerCase()` and the router dutifully mounts a "mission"
 * panel over the mission.
 *
 * `Record<Screen, …>` MAKES AN OMISSION A COMPILE ERROR, which is the same
 * argument that made `TRANSITIONS` a table: totality checked by the compiler
 * rather than noticed by a player on a blank screen. `__tests__/views.test.ts`
 * makes the runtime half of the claim, because the compiler checks this against
 * the `Screen` UNION while the router iterates `SCREENS`.
 *
 * THE TABLE AND NOTHING ELSE LIVES IN THIS FILE. It is `src/core`, so it is
 * engine-free and DOM-free like the rest of the directory and
 * `__tests__/purity.test.ts` holds it to that: a view id is a NAME the shell
 * resolves to a `create*` function, never a function, never an element.
 */

import { SCREENS } from './transitions'
import type { Screen } from './transitions'

/**
 * The name of one mountable panel.
 *
 * A closed union for the same reason `Screen` is one: the shell switches on
 * these to pick a `create*` function, and an id added as a loose string would
 * compile into a router with no arm that can mount it.
 */
export type ViewId = 'menu' | 'controls' | 'briefing' | 'boot-hill'

/**
 * What each screen mounts, or `null` for the one that mounts nothing.
 *
 * Plain data, JSON round-trippable, no behaviour in a row — the bargain
 * `transitions.ts`, `ranks.ts` and `ordnance/table.ts` all make.
 */
export const SCREEN_VIEWS: Record<Screen, ViewId | null> = {
  Menu: 'menu',
  // Ticket 074. A real panel and NOT `null`: `null` means "the mission is the
  // screen", and here it would mean a black page with no card and no button.
  Controls: 'controls',
  BootHill: 'boot-hill',
  Briefing: 'briefing',
  // The canvas. See the header: the mission is the absence of a panel, not a
  // panel of its own.
  Mission: null,
}

/** Every id the table uses, for a shell that wants to enumerate them. */
export const VIEWS: readonly ViewId[] = ['menu', 'controls', 'briefing', 'boot-hill']

/**
 * The reading the router does: what does this screen mount?
 *
 * THE ARGUMENT IS TYPED BUT NOT TRUSTED, exactly as `advance`'s is. A screen
 * name can reach here from a handler wired to a typo'd string, and an unknown
 * one must answer `null` rather than `undefined`: the router branches on `null`
 * to mean "show the game", so an `undefined` would pass a truthiness check as
 * "no overlay" and strip the panel off a screen the game is not actually on —
 * leaving the player looking at a mission he is not in.
 */
export function viewFor(screen: Screen): ViewId | null {
  if (!SCREENS.some((known) => known === screen)) return null
  return SCREEN_VIEWS[screen] ?? null
}
