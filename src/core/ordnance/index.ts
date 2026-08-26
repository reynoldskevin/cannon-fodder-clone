/**
 * The ordnance layer (ticket 015): grenades, rockets and anything a designer
 * adds after them.
 *
 * This is the public face of `src/core/ordnance`. The session registers
 * `createOrdnanceSystem(grid)` on the world and sends throws to `launch`; FX and
 * audio consume the `Explosion` event off the bus and import nothing from here
 * at all. The renderer's one read is `inFlight()`.
 *
 * `table.ts` IS THE TUNING SURFACE, exactly as `combat/weapons.ts` is for the
 * rifle: every number that decides how ordnance feels lives there, and a
 * designer should be able to add a weapon without opening `ballistics.ts`,
 * `blast.ts` or `system.ts`. That claim is asserted rather than asserted-to — a
 * row invented at runtime and handed in through `OrdnanceOptions.table` flies,
 * detonates and kills without a line of this directory changing.
 */

export { ORDNANCE, GRAVITY_TILES_PER_TICK_SQUARED } from './table'
export type { OrdnanceSpec, OrdnanceArc, FalloffCurve } from './table'

export { planTrajectory, positionAt } from './ballistics'
export type { Trajectory, FlightPoint } from './ballistics'

export { falloffAt, resolveBlast } from './blast'
export type { BlastHit } from './blast'

export { createOrdnanceSystem } from './system'
export type { OrdnanceOptions, OrdnanceSystem, InFlightOrdnance } from './system'
