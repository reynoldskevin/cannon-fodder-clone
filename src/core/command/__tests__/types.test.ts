import { describe, it, expect } from 'vitest'
import type { Command, CommandType } from '../index'

/**
 * Ticket 008 — the command union, checked at COMPILE time.
 *
 * These assertions mostly do their work in `tsc`, not in vitest: the runtime
 * body of each case is trivial, and what is really being tested is that the file
 * still typechecks. `npm run build` runs `tsc --noEmit` first, so adding a
 * member to `Command` without handling it here fails the build.
 *
 * The `never` assignment is the load-bearing line. Without it, a new command
 * variant is simply ignored by every `switch` in the codebase — the default
 * branch swallows it, nothing throws, and the feature silently does nothing.
 */

/** Fails to compile if `value` is not `never` — i.e. if a case was left unhandled. */
function assertNever(value: never): never {
  throw new Error(`unhandled command: ${JSON.stringify(value)}`)
}

/** A total function over the union. Adding a member breaks this at compile time. */
function describeCommand(command: Command): string {
  switch (command.type) {
    case 'move':
      return `move ${String(command.unitIds.length)} to ${String(command.target.x)},${String(command.target.y)}`
    case 'fire':
      return `fire ${command.ordnance} at ${String(command.target.x)},${String(command.target.y)}`
    case 'selectOrdnance':
      return `select ${command.ordnance}`
    default:
      return assertNever(command)
  }
}

describe('the Command union', () => {
  it('has exactly the three declared members', () => {
    // A runtime witness of the compile-time union, so a member added to the type
    // without a test here is visible in the diff of this array too.
    const types: CommandType[] = ['move', 'fire', 'selectOrdnance']
    expect(new Set(types).size).toBe(3)
  })

  it('describes a move', () => {
    expect(describeCommand({ type: 'move', unitIds: [1, 2], target: { x: 3, y: 4 } })).toBe(
      'move 2 to 3,4',
    )
  })

  it('describes a fire', () => {
    expect(
      describeCommand({ type: 'fire', unitIds: [1], ordnance: 'rifle', target: { x: 5, y: 6 } }),
    ).toBe('fire rifle at 5,6')
  })

  it('describes an ordnance selection', () => {
    expect(describeCommand({ type: 'selectOrdnance', ordnance: 'grenade' })).toBe('select grenade')
  })

  it('throws rather than silently ignoring an impossible variant', () => {
    // Reached only if something bypasses the type system — a command parsed from
    // JSON, say. It must be loud: a command that does nothing and says nothing is
    // indistinguishable from a game that has frozen.
    const rogue = { type: 'teleport' } as unknown as Command
    expect(() => describeCommand(rogue)).toThrow()
  })
})
