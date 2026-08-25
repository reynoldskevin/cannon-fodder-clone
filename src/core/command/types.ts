/**
 * The command union (ticket 008): everything the player can ask the simulation
 * to do, as data.
 *
 * WHY A UNION OF PLAIN OBJECTS. This is the single input path into the world —
 * nothing outside `src/core` ever writes to `World` directly — and a path that
 * is data rather than method calls is one that can be queued, logged, replayed
 * and asserted on. A test can construct the exact command a click would have
 * produced without a browser anywhere near it.
 *
 * DISCRIMINATED ON `type`, WHICH IS LOAD-BEARING. Every consumer switches on
 * `type` and closes the switch with a `never` assignment (see
 * `__tests__/types.test.ts`). That is what turns "someone added a variant and
 * forgot to handle it" from a silent no-op at runtime into a compile error.
 *
 * Engine-free and DOM-free like the rest of `src/core`: a `target` is a tile
 * coordinate, never a screen point and never a `Vector3`. Converting a pointer
 * to a tile is `src/input`'s job, and keeping that conversion on the far side of
 * this boundary is why these types can be tested in plain Vitest.
 */

/** A tile coordinate a command refers to. Integer tile indices, not world units. */
export interface CommandTarget {
  readonly x: number
  readonly y: number
}

/** Order the named units to march to a tile. */
export interface MoveCommand {
  readonly type: 'move'
  readonly unitIds: readonly number[]
  readonly target: CommandTarget
}

/** Order the named units to put the named ordnance onto a tile. */
export interface FireCommand {
  readonly type: 'fire'
  readonly unitIds: readonly number[]
  readonly ordnance: string
  readonly target: CommandTarget
}

/**
 * Change which ordnance the player is holding.
 *
 * Names no units and no tile: it is a change of intent, not an action in the
 * world, and it is in this union rather than in some UI state because the next
 * `fire` has to resolve against it deterministically.
 */
export interface SelectOrdnanceCommand {
  readonly type: 'selectOrdnance'
  readonly ordnance: string
}

/** Everything the player can ask for. */
export type Command = MoveCommand | FireCommand | SelectOrdnanceCommand

/** The `type` tags of `Command`, derived rather than restated so they cannot drift. */
export type CommandType = Command['type']
