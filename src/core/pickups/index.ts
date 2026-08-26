/**
 * `src/core/pickups` — loot chests (ticket 017).
 *
 * The public face of collection: `createSession` registers
 * `createPickupSystem(level, { objectives, armoury })` on the world, the HUD and
 * the renderer read `remaining()`, and FX, audio and a kill feed consume the
 * `ChestCollected` event off the bus and import nothing from here at all.
 *
 * Engine-free like the rest of `src/core`: no `three`, no DOM, no wall clock, no
 * unseeded random draw — asserted by `__tests__/purity.test.ts` rather than
 * assumed, because collection is exactly the kind of feature that invites a
 * sparkle, a spawn timer and a rolled reward, and each of those would put
 * non-determinism inside the layer the replay contract depends on being free of
 * it. A designer who wants a rolled reward takes `world.rng`.
 */

export { createPickupSystem, DEFAULT_COLLECT_RADIUS_TILES } from './system'
export type {
  PickupArmoury,
  PickupObjectives,
  PickupOptions,
  PickupSystem,
  RemainingChest,
} from './system'
