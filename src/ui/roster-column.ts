/**
 * THE WIDTH OF A ROSTER COLUMN, SPELLED ONCE (ticket 065).
 *
 * Boot Hill's HEROES/SQUAD column and the level's squad rail are the same
 * column: the player reads a list of his men down the left of the memorial and
 * then down the left of the mission, and the two are supposed to line up. Two
 * files carrying the same `clamp()` agree right up until somebody widens one of
 * them, at which point nothing fails anywhere — the screens simply stop matching,
 * which is only visible by opening both and remembering what the other looked
 * like. So it is a constant, imported by both, and `squad-panel.test.ts` asserts
 * that it stays imported.
 *
 * A `clamp()` AND NOT A FIXED WIDTH, because both columns sit beside something
 * that must keep the rest of the screen: the hillside on one and the map on the
 * other. The floor keeps a name readable on a phone and the ceiling stops the
 * column eating half of a wide monitor.
 *
 * NO DOM HERE, deliberately — this is a string, so Vitest can read it under
 * `environment: 'node'` where nothing else in `src/ui` can be reached.
 */
export const ROSTER_COLUMN_WIDTH = 'clamp(11rem, 22vw, 16rem)'
