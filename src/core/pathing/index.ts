/**
 * The pathing layer (ticket 006): a baked navigation grid, flow fields solved
 * outward from a destination, and a bounded cache of them.
 *
 * This is the public face of `src/core/pathing`. Ticket 007's movement system
 * holds one `NavGrid` and one `FlowFieldCache` for the mission and asks the
 * cache for a field per destination; nothing above this directory needs to know
 * that a field is three typed arrays or that the sweep is Dijkstra.
 *
 * Deliberately standalone and pure — no `World`, no tick, no events. That is
 * what lets the whole layer be asserted against ASCII pictures of maps.
 */

export { bakeNavGrid, NavGrid, INFANTRY, VEHICLE, ALL_TRAVERSAL } from './navgrid'
export type { TraversalMask } from './navgrid'

export { computeFlowField, FlowField, UNREACHABLE, SQRT2 } from './flowfield'
export type { GridPoint } from './flowfield'

export { createFlowFieldCache, DEFAULT_FIELD_CAPACITY } from './cache'
export type { FlowFieldCache, FlowFieldCacheStats } from './cache'
