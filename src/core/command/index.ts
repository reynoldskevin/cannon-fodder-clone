/**
 * The command layer (ticket 008): the single input path into the simulation.
 *
 * This is the public face of `src/core/command`. `src/input` builds commands and
 * pushes them onto a `CommandQueue`; the app drains that queue at the top of
 * each tick and hands each one to `applyCommand`. Nothing outside `src/core`
 * ever writes to `World` directly, and this module is the reason that rule can
 * be kept: everything a player can do is one of three plain objects.
 *
 * The queue buffers and the apply validates — see `queue.ts` and `apply.ts` for
 * why that seam is where it is.
 */

export { createCommandQueue } from './queue'
export type { CommandQueue } from './queue'

export { applyCommand } from './apply'
export type { CommandContext } from './apply'

export type {
  Command,
  CommandType,
  CommandTarget,
  MoveCommand,
  FireCommand,
  SelectOrdnanceCommand,
} from './types'
