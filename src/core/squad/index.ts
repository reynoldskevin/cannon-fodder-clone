/**
 * The squad layer (ticket 007): move orders, formation follow and the local
 * steering that carries them out.
 *
 * This is the public face of `src/core/squad`. The command layer builds one
 * `SquadSystem` per world, registers it with `world.addSystem`, and sends orders
 * to it; nothing above this directory needs to know that a formation slot is a
 * rotated offset or that a straggler is caught up on a cached flow field.
 *
 * Engine-free and clock-free like the rest of `src/core`, which is what lets a
 * whole march be asserted against an ASCII picture of a map in plain Vitest.
 */

export { createSquadSystem } from './system'
export type { SquadOptions, SquadSystem } from './system'
