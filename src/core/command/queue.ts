/**
 * The command queue (ticket 008): a FIFO buffer between whoever produces
 * commands and the tick that consumes them.
 *
 * A BUFFER, AND NOTHING ELSE. It validates nothing — not that a unit id names
 * anything living, not that a target is on the map, not that a `move` means
 * anything at all. That is `applyCommand`'s job, because that is the only place
 * with a `World` to ask. The split is deliberate: a queue that silently
 * discarded on `push` would drop commands at a point no test and no breakpoint
 * was watching, and "my click did nothing" would be indistinguishable from "my
 * click was never delivered". Everything pushed here comes back out.
 *
 * FIFO IS THE WHOLE CONTRACT, and it is load-bearing: two move orders in one
 * frame must resolve in the order the player gave them, or the squad obeys the
 * click the player has already changed their mind about.
 */

import type { Command } from './types'

export interface CommandQueue {
  /** Buffer a command. Never rejects, never validates. */
  push(command: Command): void
  /**
   * Take everything buffered, in push order, leaving the queue empty.
   *
   * The batch handed back is the queue's *former* storage and never its current
   * storage, so a consumer iterating the batch may push follow-up commands
   * safely: those land in the fresh buffer and are drained next time rather than
   * appearing inside — or being wiped from — the array being iterated.
   */
  drain(): readonly Command[]
  /** How many commands are buffered right now. Reading it does not drain. */
  readonly size: number
}

export function createCommandQueue(): CommandQueue {
  let buffered: Command[] = []

  return {
    push(command: Command): void {
      buffered.push(command)
    },
    drain(): readonly Command[] {
      // Hand over the array and adopt a new one, rather than copying and
      // clearing. Two properties fall out of that single swap: the returned
      // batch is stable no matter what the consumer does to the queue while
      // iterating it, and mutating the batch cannot corrupt the queue.
      const batch = buffered
      buffered = []
      return batch
    },
    get size(): number {
      return buffered.length
    },
  }
}
